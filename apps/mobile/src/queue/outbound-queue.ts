/**
 * Phase 4 offline outbound queue (FR-091 / NFR-OFF-03).
 *
 * Queue messages and *user-decided* approvals while Hub is unreachable.
 * Flush on Ready with stable Idempotency-Key — never invent Approve.
 */

import { createIdempotencyKey } from '../hub/idempotency';

export type OutboundKind = 'message' | 'approval';

export type QueueItemStatus = 'pending' | 'flushing' | 'failed';

export interface QueuedMessage {
  id: string;
  kind: 'message';
  sessionId: string;
  content: string;
  clientMessageId?: string;
  idempotencyKey: string;
  createdAt: string;
  status: QueueItemStatus;
  lastError?: string;
}

export interface QueuedApproval {
  id: string;
  kind: 'approval';
  sessionId: string;
  approvalId: string;
  /** User already chose — flush must never change this to approve silently. */
  decision: 'approve' | 'deny';
  idempotencyKey: string;
  createdAt: string;
  status: QueueItemStatus;
  lastError?: string;
}

export type OutboundQueueItem = QueuedMessage | QueuedApproval;

export interface QueueStorage {
  load(): Promise<OutboundQueueItem[]>;
  save(items: OutboundQueueItem[]): Promise<void>;
}

/** In-memory storage (tests). Production uses SecureStore via `createSecureQueueStorage`. */
export function createMemoryQueueStorage(
  seed: OutboundQueueItem[] = [],
): QueueStorage {
  let items = [...seed];
  return {
    async load() {
      return [...items];
    },
    async save(next) {
      items = [...next];
    },
  };
}

function newQueueId(prefix: string): string {
  const rand =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `q_${prefix}_${rand}`;
}

export function enqueueMessage(
  items: OutboundQueueItem[],
  input: {
    sessionId: string;
    content: string;
    clientMessageId?: string;
    idempotencyKey?: string;
  },
): { items: OutboundQueueItem[]; item: QueuedMessage } {
  const item: QueuedMessage = {
    id: newQueueId('msg'),
    kind: 'message',
    sessionId: input.sessionId,
    content: input.content,
    clientMessageId: input.clientMessageId,
    idempotencyKey: input.idempotencyKey ?? createIdempotencyKey('msg'),
    createdAt: new Date().toISOString(),
    status: 'pending',
  };
  return { items: [...items, item], item };
}

/**
 * Enqueue an approval the user already decided.
 * Never call with a synthetic 'approve' — UI must collect the tap first.
 */
export function enqueueApproval(
  items: OutboundQueueItem[],
  input: {
    sessionId: string;
    approvalId: string;
    decision: 'approve' | 'deny';
    idempotencyKey?: string;
  },
): { items: OutboundQueueItem[]; item: QueuedApproval } {
  // Dedupe same approvalId — keep first pending/failed decision (no flip).
  const existing = items.find(
    (i) =>
      i.kind === 'approval' &&
      i.approvalId === input.approvalId &&
      (i.status === 'pending' || i.status === 'failed'),
  );
  if (existing && existing.kind === 'approval') {
    return { items, item: existing };
  }

  const item: QueuedApproval = {
    id: newQueueId('apr'),
    kind: 'approval',
    sessionId: input.sessionId,
    approvalId: input.approvalId,
    decision: input.decision,
    idempotencyKey:
      input.idempotencyKey ?? createIdempotencyKey(`apr-${input.decision}`),
    createdAt: new Date().toISOString(),
    status: 'pending',
  };
  return { items: [...items, item], item };
}

export function pendingCount(items: OutboundQueueItem[]): number {
  return items.filter((i) => i.status === 'pending' || i.status === 'failed')
    .length;
}

export function itemsForSession(
  items: OutboundQueueItem[],
  sessionId: string,
): OutboundQueueItem[] {
  return items.filter((i) => i.sessionId === sessionId);
}

/** Drop queue on revoke / forget PC (FR-091 alternate). */
export function clearQueue(): OutboundQueueItem[] {
  return [];
}

export interface FlushDeps {
  postMessage: (
    sessionId: string,
    body: { content: string; clientMessageId?: string },
    idempotencyKey: string,
  ) => Promise<unknown>;
  postApproval: (
    sessionId: string,
    body: { approvalId: string; decision: 'approve' | 'deny' },
    idempotencyKey: string,
  ) => Promise<unknown>;
  /** When false, do not flush (not Ready). */
  isReady: boolean;
}

export interface FlushResult {
  items: OutboundQueueItem[];
  flushedIds: string[];
  failedIds: string[];
  skipped: boolean;
}

/**
 * Flush pending/failed items in FIFO order when Ready.
 * Approvals re-send the stored user decision only — never auto-approve.
 */
export async function flushOutboundQueue(
  items: OutboundQueueItem[],
  deps: FlushDeps,
): Promise<FlushResult> {
  if (!deps.isReady) {
    return { items, flushedIds: [], failedIds: [], skipped: true };
  }

  const next = items.map((i) => ({ ...i }));
  const flushedIds: string[] = [];
  const failedIds: string[] = [];

  for (let idx = 0; idx < next.length; idx++) {
    const item = next[idx]!;
    if (item.status !== 'pending' && item.status !== 'failed') continue;

    next[idx] = { ...item, status: 'flushing', lastError: undefined };
    try {
      if (item.kind === 'message') {
        await deps.postMessage(
          item.sessionId,
          {
            content: item.content,
            clientMessageId: item.clientMessageId,
          },
          item.idempotencyKey,
        );
      } else {
        // Explicit: use stored decision only (NFR-REL-03 / NFR-OFF-03).
        await deps.postApproval(
          item.sessionId,
          {
            approvalId: item.approvalId,
            decision: item.decision,
          },
          item.idempotencyKey,
        );
      }
      flushedIds.push(item.id);
      next[idx] = undefined as unknown as OutboundQueueItem;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Flush failed';
      failedIds.push(item.id);
      next[idx] = {
        ...item,
        status: 'failed',
        lastError: message,
      };
      // Stop on first failure to preserve order / avoid stampede.
      break;
    }
  }

  return {
    items: next.filter(Boolean),
    flushedIds,
    failedIds,
    skipped: false,
  };
}

export class OutboundQueue {
  private items: OutboundQueueItem[] = [];
  private loaded = false;

  constructor(private readonly storage: QueueStorage) {}

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.items = await this.storage.load();
    this.loaded = true;
  }

  async list(): Promise<OutboundQueueItem[]> {
    await this.ensureLoaded();
    return [...this.items];
  }

  async enqueueMessage(input: {
    sessionId: string;
    content: string;
    clientMessageId?: string;
    idempotencyKey?: string;
  }): Promise<QueuedMessage> {
    await this.ensureLoaded();
    const { items, item } = enqueueMessage(this.items, input);
    this.items = items;
    await this.storage.save(this.items);
    return item;
  }

  async enqueueApproval(input: {
    sessionId: string;
    approvalId: string;
    decision: 'approve' | 'deny';
    idempotencyKey?: string;
  }): Promise<QueuedApproval> {
    await this.ensureLoaded();
    const { items, item } = enqueueApproval(this.items, input);
    this.items = items;
    await this.storage.save(this.items);
    return item;
  }

  async flush(deps: Omit<FlushDeps, 'isReady'> & { isReady: boolean }): Promise<FlushResult> {
    await this.ensureLoaded();
    const result = await flushOutboundQueue(this.items, deps);
    this.items = result.items;
    await this.storage.save(this.items);
    return result;
  }

  async clear(): Promise<void> {
    this.items = clearQueue();
    this.loaded = true;
    await this.storage.save(this.items);
  }

  async pendingCount(): Promise<number> {
    await this.ensureLoaded();
    return pendingCount(this.items);
  }
}
