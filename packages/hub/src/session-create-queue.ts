/**
 * PC-local New-session create queue.
 *
 * When POST /sessions fails with CURSOR_DOWN / liveAdapter down, persist the
 * create payload and retry once Hub reports cdp_ok. No cloud — Hub process only.
 */

export type SessionCreateQueueStatus =
  | "pending"
  | "flushing"
  | "failed"
  | "done";

export interface PendingSessionCreate {
  id: string;
  workspaceId: string;
  model: string;
  attachments: string[];
  prompt?: string;
  agentMode?: string;
  idempotencyKey: string;
  createdAt: string;
  status: SessionCreateQueueStatus;
  lastError?: string;
  resultSessionId?: string;
}

export interface SessionCreateQueueSnapshot {
  pending: number;
  items: Array<{
    id: string;
    status: SessionCreateQueueStatus;
    model: string;
    promptLen: number;
    promptPrefix: string;
    attachmentCount: number;
    createdAt: string;
    lastError?: string;
    resultSessionId?: string;
  }>;
  lastDrained: {
    at: string;
    sessionId: string | null;
    queueId: string;
    ok: boolean;
    error?: string;
  } | null;
}

export interface SessionCreateInput {
  workspaceId: string;
  model: string;
  attachments: string[];
  prompt?: string;
  agentMode?: string;
}

export type SessionCreateResult =
  | ({ ok: true; id: string } & Record<string, unknown>)
  | { ok: false; code: string; message: string; details?: unknown };

function newQueueId(): string {
  const rand =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `q_create_${rand}`;
}

export function enqueueSessionCreate(
  items: PendingSessionCreate[],
  input: SessionCreateInput & { idempotencyKey: string },
): { items: PendingSessionCreate[]; item: PendingSessionCreate; deduped: boolean } {
  const existing = items.find(
    (i) =>
      i.idempotencyKey === input.idempotencyKey &&
      (i.status === "pending" || i.status === "failed" || i.status === "flushing"),
  );
  if (existing) {
    return { items, item: existing, deduped: true };
  }

  const item: PendingSessionCreate = {
    id: newQueueId(),
    workspaceId: input.workspaceId,
    model: input.model,
    attachments: [...input.attachments],
    prompt: input.prompt,
    agentMode: input.agentMode,
    idempotencyKey: input.idempotencyKey,
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  return { items: [...items, item], item, deduped: false };
}

export function pendingSessionCreateCount(items: PendingSessionCreate[]): number {
  return items.filter((i) => i.status === "pending" || i.status === "failed")
    .length;
}

export function snapshotSessionCreateQueue(
  items: PendingSessionCreate[],
  lastDrained: SessionCreateQueueSnapshot["lastDrained"],
): SessionCreateQueueSnapshot {
  return {
    pending: pendingSessionCreateCount(items),
    items: items
      .filter((i) => i.status !== "done")
      .map((i) => ({
        id: i.id,
        status: i.status,
        model: i.model,
        promptLen: i.prompt?.length ?? 0,
        promptPrefix: (i.prompt ?? "").slice(0, 64),
        attachmentCount: i.attachments.length,
        createdAt: i.createdAt,
        lastError: i.lastError,
        resultSessionId: i.resultSessionId,
      })),
    lastDrained,
  };
}

export interface FlushSessionCreateDeps {
  isCdpOk: boolean;
  createSession: (input: SessionCreateInput) => Promise<SessionCreateResult>;
}

export interface FlushSessionCreateResult {
  items: PendingSessionCreate[];
  flushedIds: string[];
  failedIds: string[];
  skipped: boolean;
  lastDrained: SessionCreateQueueSnapshot["lastDrained"];
}

/**
 * Flush pending/failed creates in FIFO when liveAdapter is cdp_ok.
 * Stops on first failure to preserve order.
 */
export async function flushSessionCreateQueue(
  items: PendingSessionCreate[],
  deps: FlushSessionCreateDeps,
  priorLastDrained: SessionCreateQueueSnapshot["lastDrained"] = null,
): Promise<FlushSessionCreateResult> {
  if (!deps.isCdpOk) {
    return {
      items,
      flushedIds: [],
      failedIds: [],
      skipped: true,
      lastDrained: priorLastDrained,
    };
  }

  const next = items.map((i) => ({ ...i }));
  const flushedIds: string[] = [];
  const failedIds: string[] = [];
  let lastDrained = priorLastDrained;

  for (let idx = 0; idx < next.length; idx++) {
    const item = next[idx]!;
    if (item.status !== "pending" && item.status !== "failed") continue;

    next[idx] = { ...item, status: "flushing", lastError: undefined };
    try {
      const result = await deps.createSession({
        workspaceId: item.workspaceId,
        model: item.model,
        attachments: item.attachments,
        prompt: item.prompt,
        agentMode: item.agentMode,
      });
      if (!result.ok) {
        if (result.code === "CURSOR_DOWN") {
          // Still down — leave pending for next drain.
          next[idx] = { ...item, status: "pending", lastError: result.message };
          lastDrained = {
            at: new Date().toISOString(),
            sessionId: null,
            queueId: item.id,
            ok: false,
            error: result.message,
          };
          break;
        }
        failedIds.push(item.id);
        next[idx] = {
          ...item,
          status: "failed",
          lastError: `${result.code}: ${result.message}`,
        };
        lastDrained = {
          at: new Date().toISOString(),
          sessionId: null,
          queueId: item.id,
          ok: false,
          error: `${result.code}: ${result.message}`,
        };
        break;
      }
      flushedIds.push(item.id);
      next[idx] = {
        ...item,
        status: "done",
        resultSessionId: result.id,
        lastError: undefined,
      };
      lastDrained = {
        at: new Date().toISOString(),
        sessionId: result.id,
        queueId: item.id,
        ok: true,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Flush failed";
      failedIds.push(item.id);
      next[idx] = { ...item, status: "failed", lastError: message };
      lastDrained = {
        at: new Date().toISOString(),
        sessionId: null,
        queueId: item.id,
        ok: false,
        error: message,
      };
      break;
    }
  }

  // Drop done items from the active queue (keep failed/pending).
  return {
    items: next.filter((i) => i.status !== "done"),
    flushedIds,
    failedIds,
    skipped: false,
    lastDrained,
  };
}

export class SessionCreateQueue {
  private items: PendingSessionCreate[] = [];
  private lastDrained: SessionCreateQueueSnapshot["lastDrained"] = null;
  private draining = false;

  list(): PendingSessionCreate[] {
    return [...this.items];
  }

  snapshot(): SessionCreateQueueSnapshot {
    return snapshotSessionCreateQueue(this.items, this.lastDrained);
  }

  enqueue(
    input: SessionCreateInput & { idempotencyKey: string },
  ): { item: PendingSessionCreate; deduped: boolean } {
    const { items, item, deduped } = enqueueSessionCreate(this.items, input);
    this.items = items;
    return { item, deduped };
  }

  async drain(deps: FlushSessionCreateDeps): Promise<FlushSessionCreateResult> {
    if (this.draining) {
      return {
        items: this.items,
        flushedIds: [],
        failedIds: [],
        skipped: true,
        lastDrained: this.lastDrained,
      };
    }
    this.draining = true;
    try {
      const result = await flushSessionCreateQueue(
        this.items,
        deps,
        this.lastDrained,
      );
      this.items = result.items;
      this.lastDrained = result.lastDrained;
      return result;
    } finally {
      this.draining = false;
    }
  }

  pendingCount(): number {
    return pendingSessionCreateCount(this.items);
  }
}
