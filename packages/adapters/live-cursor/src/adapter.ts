import { listMentionOptions as listMentionOptionsRun, type MentionResult, type MentionTrigger } from "./mentions.js";
import {
  sendToAgentChat as sendAgentChatMessage,
  stopAgentChat as stopAgentChatRun,
  newAgentChat as newAgentChatRun,
  editAgentMessage as editAgentMessageRun,
  openAgentChat as openAgentChatRun,
  type ChatSendResult,
  type ComposerSendOptions,
} from "./chat-send.js";
import {
  scrapeAgentsSidebar,
  type SidebarScrapeResult,
  type SidebarSection,
} from "./sidebar-scrape.js";
import { randomBytes } from "node:crypto";
import {
  defaultCdpClientFactory,
  type CdpClientFactory,
} from "./cdp-client.js";
import {
  fetchCdpTargetList,
  fetchCdpVersion,
  selectWindowTargets,
} from "./cdp-http.js";
import { executeVerifiedAction } from "./cdp-input.js";
import { scrapeComposerModels } from "./model-scrape.js";
import { normalizeCdpUrl } from "./loopback.js";
import {
  createDefaultSelectorPack,
  isActionVerified,
  resolveSelectorPackStatus,
  SELECTOR_PACK_ID,
  type ActionSelector,
  type SelectorActionId,
  type SelectorPackStatus,
  type SelectorVerification,
} from "./selector-pack.js";
import type {
  ApprovalResult,
  AttachFilesResult,
  CommandResult,
  CdpProbeResult,
  CreateLiveSessionInput,
  CreateLiveSessionResult,
  EnqueueApprovalInput,
  LiveAdapterHealth,
  LiveCursorAdapter,
  LiveHealthState,
  LiveSessionRow,
  LiveWindow,
  ModelScrapeCommandResult,
  PendingApprovalInfo,
  ReopenComposerContextInput,
  ReopenComposerContextResult,
  ScrapedModelOption,
  SendMessageResult,
} from "./types.js";

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/** Escape a value for use inside a CSS attribute selector double-quoted string. */
function cssAttrEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function hashTargetToSessionId(targetId: string): string {
  // Stable id for a CDP target so list/get stay consistent within a Hub process.
  const safe = targetId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "x";
  return `sess_live_${safe}`;
}

interface TrackedSession {
  row: LiveSessionRow;
  source: "cdp" | "hub";
}

/** Minimal pack inject for unit tests (actions optional). */
export type SelectorPackStatusInject = Pick<
  SelectorPackStatus,
  "id" | "verified" | "reason"
> &
  Partial<Pick<SelectorPackStatus, "actions" | "pack" | "opsOverride">>;

export interface LiveCursorAdapterOptions {
  cdpUrl?: string;
  /** Inject selector pack status (tests). */
  selectorPack?: SelectorPackStatusInject;
  fetchTimeoutMs?: number;
  /**
   * CDP WebSocket client factory (tests inject a mock).
   * Production default opens a loopback debugger session only.
   */
  cdpClientFactory?: CdpClientFactory;
}

function normalizeSelectorPackStatus(
  injected?: SelectorPackStatusInject,
): SelectorPackStatus {
  if (!injected) {
    return resolveSelectorPackStatus(process.env);
  }
  if (injected.actions) {
    const pack = injected.pack ?? createDefaultSelectorPack();
    return {
      id: injected.id,
      verified: injected.verified,
      reason: injected.reason,
      actions: injected.actions,
      pack,
      opsOverride: injected.opsOverride ?? false,
    };
  }
  const pack = createDefaultSelectorPack();
  const flag: SelectorVerification = injected.verified
    ? "VERIFIED"
    : "CANDIDATE";
  const actions = {
    send_message: flag,
    approve: flag,
    deny: flag,
    model_select: flag,
    file_attach: flag,
    composer_history_open: flag,
  } satisfies Record<SelectorActionId, SelectorVerification>;
  return {
    id: injected.id,
    verified: injected.verified,
    reason: injected.reason,
    actions,
    pack,
    opsOverride: injected.opsOverride ?? false,
  };
}

/**
 * Phase 1 LiveCursorAdapter: CDP attach + health triad + command gate.
 * DOM mutations fail closed with EXTRACTOR_STALE until the specific action is VERIFIED;
 * then CDP Input (click/type) runs against loopback debugger only.
 */
export class LiveCursorAdapterImpl implements LiveCursorAdapter {
  readonly cdpUrl: string;
  private readonly fetchTimeoutMs: number;
  private readonly selectorPack: SelectorPackStatus;
  private readonly cdpClientFactory: CdpClientFactory;
  private attachedAt: string | null = null;
  private lastError: string | null = null;
  private lastProbe: CdpProbeResult | null = null;
  private windows: LiveWindow[] = [];
  private sessions = new Map<string, TrackedSession>();
  private approvals = new Map<string, PendingApprovalInfo>();

  constructor(opts: LiveCursorAdapterOptions | string = {}) {
    const options =
      typeof opts === "string" ? { cdpUrl: opts } : opts ?? {};
    this.cdpUrl = normalizeCdpUrl(options.cdpUrl ?? "http://127.0.0.1:9222");
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 2000;
    this.selectorPack = normalizeSelectorPackStatus(options.selectorPack);
    this.cdpClientFactory =
      options.cdpClientFactory ?? defaultCdpClientFactory;
  }

  async probe(): Promise<CdpProbeResult> {
    const urlConfigured = this.cdpUrl;
    const version = await fetchCdpVersion(this.cdpUrl, this.fetchTimeoutMs);
    if (!version.ok) {
      const result: CdpProbeResult = {
        status: version.aborted ? "disconnected" : "error",
        urlConfigured,
        lastAttachAt: null,
        error: version.error,
        cursor: { status: "not_detected", windowsDetected: 0 },
      };
      this.lastProbe = result;
      this.lastError = version.error;
      return result;
    }

    const list = await fetchCdpTargetList(this.cdpUrl, this.fetchTimeoutMs);
    const windowsDetected = list.ok
      ? selectWindowTargets(list.data).length
      : 1;

    const result: CdpProbeResult = {
      status: "connected",
      urlConfigured,
      lastAttachAt: new Date().toISOString(),
      error: null,
      cursor: {
        status: "running",
        windowsDetected,
      },
    };
    this.lastProbe = result;
    this.lastError = null;
    return result;
  }

  async attach(): Promise<LiveAdapterHealth> {
    const probe = await this.probe();
    if (probe.status !== "connected") {
      this.attachedAt = null;
      this.windows = [];
      return this.buildHealth(probe, null);
    }

    const list = await fetchCdpTargetList(this.cdpUrl, this.fetchTimeoutMs);
    if (!list.ok) {
      this.attachedAt = null;
      this.windows = [];
      this.lastError = list.error;
      const degraded: CdpProbeResult = {
        ...probe,
        status: list.aborted ? "disconnected" : "error",
        error: list.error,
        cursor: { status: "not_detected", windowsDetected: 0 },
      };
      this.lastProbe = degraded;
      return this.buildHealth(degraded, null);
    }

    const targets = selectWindowTargets(list.data);
    this.windows = targets.map((t) => ({
      windowId: `win_${t.id}`,
      targetId: t.id,
      title: t.title || "Cursor",
      url: t.url,
      type: t.type,
      webSocketDebuggerUrl: t.webSocketDebuggerUrl,
    }));

    // Refresh CDP-sourced live sessions (do not wipe Hub-created stubs).
    for (const [id, tracked] of this.sessions) {
      if (tracked.source === "cdp") this.sessions.delete(id);
    }
    for (const win of this.windows) {
      const id = hashTargetToSessionId(win.targetId);
      const now = new Date().toISOString();
      this.sessions.set(id, {
        source: "cdp",
        row: {
          id,
          workspaceId: "", // filled by Hub with bound workspace when listing
          mode: "live",
          title: win.title || "Live Composer",
          preview: null,
          model: null,
          updatedAt: now,
          createdAt: now,
          pendingApprovals: 0,
          windowId: win.windowId,
          targetId: win.targetId,
        },
      });
    }

    this.attachedAt = new Date().toISOString();
    this.lastError = this.selectorPack.verified
      ? null
      : this.selectorPack.reason;
    return this.buildHealth(probe, this.windows[0]?.windowId ?? null);
  }

  async detach(): Promise<void> {
    this.attachedAt = null;
    this.windows = [];
    for (const [id, tracked] of this.sessions) {
      if (tracked.source === "cdp") this.sessions.delete(id);
    }
  }

  async getHealth(): Promise<LiveAdapterHealth> {
    // Refresh attach state on each health read so /health stays current.
    return this.attach();
  }

  async listWindows(): Promise<LiveWindow[]> {
    await this.attach();
    return [...this.windows];
  }

  async listLiveSessions(workspaceId: string): Promise<LiveSessionRow[]> {
    await this.attach();
    const health = await this.snapshotHealth();
    if (health.state === "cursor_down") {
      return [];
    }

    const rows: LiveSessionRow[] = [];
    for (const tracked of this.sessions.values()) {
      const row = { ...tracked.row, workspaceId };
      rows.push(row);
    }
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getLiveSession(sessionId: string): Promise<LiveSessionRow | null> {
    const tracked = this.sessions.get(sessionId);
    return tracked ? { ...tracked.row } : null;
  }

  async createSession(
    input: CreateLiveSessionInput,
  ): Promise<CommandResult<CreateLiveSessionResult>> {
    const health = await this.attach();

    if (health.state === "cursor_down") {
      return {
        ok: false,
        code: "CURSOR_DOWN",
        message:
          "Cursor CDP is not reachable — open Cursor with remote debugging on 127.0.0.1",
        details: { health: health.state },
      };
    }

    const now = new Date().toISOString();
    const id = newId("sess_live");
    const title =
      (input.prompt && input.prompt.trim().slice(0, 80)) ||
      `New session (${input.model})`;
    const attachments = input.attachments ?? [];
    const agentMode = input.agentMode ?? "agent";

    // Register Hub session even when extractor is stale so list/create UX works;
    // never claim DOM was driven.
    const row: LiveSessionRow = {
      id,
      workspaceId: input.workspaceId,
      mode: "live",
      title,
      preview: input.prompt?.trim() || null,
      model: input.model,
      updatedAt: now,
      createdAt: now,
      pendingApprovals: 0,
      windowId: health.windowId ?? "win_unbound",
      targetId: "hub_created",
    };
    this.sessions.set(id, { source: "hub", row });

    const modelOk = isActionVerified(this.selectorPack, "model_select");
    const attachOk =
      attachments.length === 0 ||
      isActionVerified(this.selectorPack, "file_attach");
    const promptOk =
      !input.prompt?.trim() ||
      isActionVerified(this.selectorPack, "send_message");
    // Never claim DOM drive unless CDP is up AND required actions VERIFIED.
    // Per-action VERIFIED is enough (pack overall may still be extractor_stale).
    // cursor_down already returned above — remaining states mean CDP is up.
    const cdpUp = true;
    const domApplied = cdpUp && modelOk && attachOk && promptOk;
    return {
      ok: true,
      id,
      workspaceId: input.workspaceId,
      mode: "live",
      title,
      model: input.model,
      agentMode,
      attachments,
      createdAt: now,
      updatedAt: now,
      domApplied,
      note: domApplied
        ? undefined
        : "Session registered on Hub; Composer DOM not driven (extractor_stale / CANDIDATE actions)",
    };
  }

  async sendMessage(
    sessionId: string,
    content: string,
  ): Promise<CommandResult<SendMessageResult>> {
    const trimmed = content.trim();
    if (!trimmed) {
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message: "content must be non-empty",
      };
    }

    const health = await this.attach();
    const tracked = this.sessions.get(sessionId);
    if (!tracked) {
      return {
        ok: false,
        code: "SESSION_NOT_FOUND",
        message: `Unknown live session ${sessionId}`,
      };
    }

    if (health.state === "cursor_down") {
      return {
        ok: false,
        code: "CURSOR_DOWN",
        message:
          "Cannot send message — Cursor CDP is down (enable --remote-debugging-port=9222 on 127.0.0.1)",
        details: { health: health.state },
      };
    }

    // Per-action gate: CANDIDATE / unverified → fail closed (no CDP Input).
    if (!isActionVerified(this.selectorPack, "send_message")) {
      return {
        ok: false,
        code: "EXTRACTOR_STALE",
        message:
          "Sender blocked — send_message selectors not VERIFIED (extractor_stale); enable CDP and mark VERIFIED after live DOM proof",
        details: {
          health: health.state,
          selectorPack: this.selectorPack.id,
          action: "send_message",
          actionStatus: this.selectorPack.actions.send_message,
        },
      };
    }

    const drive = await this.driveDomAction("send_message", {
      text: trimmed,
      preferredTargetId: tracked.row.targetId,
    });
    if (!drive.ok) {
      return {
        ok: false,
        code: drive.code,
        message: drive.message,
        details: drive.details,
      };
    }

    const now = new Date().toISOString();
    tracked.row.preview = trimmed.slice(0, 120);
    tracked.row.updatedAt = now;

    return {
      ok: true,
      messageId: newId("msg"),
      sessionId,
      role: "user",
      content: trimmed,
      status: "accepted",
      createdAt: now,
      domApplied: true,
    };
  }

  async attachFiles(
    sessionId: string,
    attachments: string[],
  ): Promise<CommandResult<AttachFilesResult>> {
    const health = await this.attach();
    const tracked = this.sessions.get(sessionId);
    if (!tracked) {
      return {
        ok: false,
        code: "SESSION_NOT_FOUND",
        message: `Unknown live session ${sessionId}`,
      };
    }

    if (health.state === "cursor_down") {
      return {
        ok: false,
        code: "CURSOR_DOWN",
        message:
          "Cannot attach files — Cursor CDP is down (enable --remote-debugging-port=9222 on 127.0.0.1)",
        details: { health: health.state },
      };
    }

    const paths = attachments.filter((p) => typeof p === "string" && p.trim());
    if (paths.length === 0) {
      return {
        ok: true,
        sessionId,
        attachments: [],
        domApplied: false,
        note: "No attachment paths to inject.",
      };
    }

    // Soft gate: Hub may still register paths; never claim Composer @-inject
    // while file_attach remains CANDIDATE.
    if (!isActionVerified(this.selectorPack, "file_attach")) {
      return {
        ok: true,
        sessionId,
        attachments: paths,
        domApplied: false,
        note: "Hub may register paths under workspace roots; Composer DOM @-inject blocked until file_attach selector is VERIFIED.",
        // Soft EXTRACTOR_STALE signal for Hub notes without failing the registry path.
      };
    }

    const drive = await this.driveDomAction("file_attach", {
      preferredTargetId: tracked.row.targetId,
    });
    if (!drive.ok) {
      return {
        ok: true,
        sessionId,
        attachments: paths,
        domApplied: false,
        note: `file_attach VERIFIED but CDP inject failed: ${drive.message}. Hub may still register paths.`,
      };
    }

    tracked.row.updatedAt = new Date().toISOString();
    return {
      ok: true,
      sessionId,
      attachments: paths,
      domApplied: true,
      note: "Composer attach control clicked (file_attach VERIFIED). Paths must stay under Hub-bound workspace roots.",
    };
  }

  async reopenComposerContext(
    input: ReopenComposerContextInput,
  ): Promise<CommandResult<ReopenComposerContextResult>> {
    const health = await this.attach();
    const composerChatId = input.composerChatId?.trim() || null;

    if (!composerChatId) {
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message:
          "Strategy B requires a desktop Composer chat id (hist_<composerId>); agent-cli history rows cannot UI-reopen",
        details: {
          historySessionId: input.historySessionId,
          strategy: "ui_reopen",
        },
      };
    }

    if (health.state === "cursor_down") {
      return {
        ok: false,
        code: "CURSOR_DOWN",
        message:
          "Cannot reopen Composer chat — Cursor CDP is down (enable --remote-debugging-port=9222 on 127.0.0.1)",
        details: {
          health: health.state,
          composerChatId,
          strategy: "ui_reopen",
        },
      };
    }

    if (!isActionVerified(this.selectorPack, "composer_history_open")) {
      return {
        ok: false,
        code: "EXTRACTOR_STALE",
        message:
          "Composer UI reopen (strategy B) blocked — composer_history_open selectors not VERIFIED (CANDIDATE); Hub may fall back to new live + context (strategy C)",
        details: {
          health: health.state,
          selectorPack: this.selectorPack.id,
          action: "composer_history_open",
          actionStatus: this.selectorPack.actions.composer_history_open,
          composerChatId,
          strategy: "ui_reopen",
          code: "OPEN_ON_PC_SELECTOR_CANDIDATE",
        },
      };
    }

    const base = this.selectorPack.pack.actions.composer_history_open;
    const title = input.title?.trim() || null;
    const enriched: ActionSelector = {
      ...base,
      strategies: [
        `[data-composer-id="${cssAttrEscape(composerChatId)}"]`,
        `[data-chat-id="${cssAttrEscape(composerChatId)}"]`,
        `[data-composer-session-id="${cssAttrEscape(composerChatId)}"]`,
        ...base.strategies,
      ],
      textMatch: [
        ...(title ? [title] : []),
        composerChatId,
        composerChatId.slice(0, 8),
        ...(base.textMatch ?? []),
      ],
    };

    const drive = await this.driveDomAction("composer_history_open", {
      selectorOverride: enriched,
      text: title ?? composerChatId,
    });
    if (!drive.ok) {
      return {
        ok: false,
        code: drive.code,
        message: drive.message,
        details: {
          ...((drive.details as object) ?? {}),
          composerChatId,
          strategy: "ui_reopen",
        },
      };
    }

    const now = new Date().toISOString();
    const id = newId("sess_live");
    const row: LiveSessionRow = {
      id,
      workspaceId: input.workspaceId,
      mode: "live",
      title: title || `Composer ${composerChatId.slice(0, 8)}`,
      preview: `Reopened history ${input.historySessionId}`,
      model: input.model ?? null,
      updatedAt: now,
      createdAt: now,
      pendingApprovals: 0,
      windowId: health.windowId ?? "win_unbound",
      targetId: "hub_reopen",
    };
    this.sessions.set(id, { source: "hub", row });

    return {
      ok: true,
      id,
      workspaceId: input.workspaceId,
      mode: "live",
      historySessionId: input.historySessionId,
      composerChatId,
      strategy: "ui_reopen",
      title: row.title,
      model: row.model,
      createdAt: now,
      updatedAt: now,
      domApplied: true,
      note: `Composer UI reopen via ${drive.strategy}`,
    };
  }

  async applyApproval(
    sessionId: string,
    approvalId: string,
    decision: "approve" | "deny",
  ): Promise<CommandResult<ApprovalResult>> {
    const tracked = this.sessions.get(sessionId);
    if (!tracked) {
      return {
        ok: false,
        code: "SESSION_NOT_FOUND",
        message: `Unknown live session ${sessionId}`,
      };
    }

    const existing = this.approvals.get(approvalId);
    if (existing && existing.sessionId !== sessionId) {
      return {
        ok: false,
        code: "APPROVAL_NOT_FOUND",
        message: "Approval does not belong to this session",
      };
    }
    if (existing && existing.status === "resolved") {
      return {
        ok: false,
        code: "APPROVAL_APPLY_FAILED",
        message: "Approval already resolved",
      };
    }
    if (!existing) {
      // Unknown approval id — fail closed (no silent invent).
      return {
        ok: false,
        code: "APPROVAL_NOT_FOUND",
        message: `Unknown approval ${approvalId}`,
      };
    }

    // Synthetic UAT path: record phone decision without Cursor DOM.
    // Never claims live tool-card approve/deny succeeded.
    if (existing.synthetic) {
      const now = new Date().toISOString();
      this.approvals.set(approvalId, {
        ...existing,
        status: "resolved",
        decision,
      });
      if (tracked.row.pendingApprovals > 0) {
        tracked.row.pendingApprovals -= 1;
      }
      tracked.row.updatedAt = now;
      return {
        ok: true,
        approvalId,
        sessionId,
        decision,
        status: "recorded",
        appliedAt: now,
        domApplied: false,
        synthetic: true,
        note: "Synthetic UAT approval — decision recorded; Cursor DOM was NOT clicked",
      };
    }

    const health = await this.attach();
    if (health.state === "cursor_down") {
      return {
        ok: false,
        code: "CURSOR_DOWN",
        message: "Cannot apply approval — Cursor CDP is down",
      };
    }

    const approvalAction: SelectorActionId =
      decision === "approve" ? "approve" : "deny";
    if (!isActionVerified(this.selectorPack, approvalAction)) {
      return {
        ok: false,
        code: "EXTRACTOR_STALE",
        message: `Cannot click ${decision} — ${approvalAction} selectors not VERIFIED (extractor_stale)`,
        details: {
          health: health.state,
          selectorPack: this.selectorPack.id,
          decision,
          action: approvalAction,
          actionStatus: this.selectorPack.actions[approvalAction],
        },
      };
    }

    const drive = await this.driveDomAction(approvalAction, {
      preferredTargetId: tracked.row.targetId,
    });
    if (!drive.ok) {
      return {
        ok: false,
        code: drive.code,
        message: drive.message,
        details: drive.details,
      };
    }

    const now = new Date().toISOString();
    this.approvals.set(approvalId, {
      ...existing,
      status: "resolved",
      decision,
    });
    if (tracked.row.pendingApprovals > 0) {
      tracked.row.pendingApprovals -= 1;
    }
    tracked.row.updatedAt = now;

    return {
      ok: true,
      approvalId,
      sessionId,
      decision,
      status: "applied",
      appliedAt: now,
      domApplied: true,
      synthetic: false,
    };
  }

  async listPendingApprovals(sessionId: string): Promise<PendingApprovalInfo[]> {
    return [...this.approvals.values()].filter(
      (a) => a.sessionId === sessionId && a.status === "pending",
    );
  }

  async enqueuePendingApproval(
    input: EnqueueApprovalInput,
  ): Promise<PendingApprovalInfo> {
    const tracked = this.sessions.get(input.sessionId);
    if (!tracked) {
      throw new Error(`Unknown live session ${input.sessionId}`);
    }
    const approvalId =
      input.approvalId?.trim() || `apr_${randomBytes(8).toString("hex")}`;
    const existing = this.approvals.get(approvalId);
    if (existing && existing.status === "pending") {
      return existing;
    }
    const now = new Date().toISOString();
    const row: PendingApprovalInfo = {
      approvalId,
      sessionId: input.sessionId,
      tool: input.tool ?? {
        name: input.synthetic ? "synthetic.uat" : "tool",
        kind: input.synthetic ? "synthetic" : null,
      },
      summary:
        input.summary?.trim() ||
        (input.synthetic
          ? "Synthetic UAT pending approval (no live Cursor tool card)"
          : "Tool call pending"),
      argsPreview: input.argsPreview,
      createdAt: now,
      expiresAt: input.expiresAt ?? null,
      status: "pending",
      synthetic: Boolean(input.synthetic),
    };
    this.approvals.set(approvalId, row);
    tracked.row.pendingApprovals += 1;
    tracked.row.updatedAt = now;
    return row;
  }

  /** Test helper: register a pending (non-synthetic) approval for a session. */
  registerPendingApproval(sessionId: string, approvalId: string): void {
    const tracked = this.sessions.get(sessionId);
    const now = new Date().toISOString();
    this.approvals.set(approvalId, {
      approvalId,
      sessionId,
      tool: { name: "test.tool" },
      summary: "Test pending approval",
      createdAt: now,
      expiresAt: null,
      status: "pending",
      synthetic: false,
    });
    if (tracked) {
      tracked.row.pendingApprovals += 1;
      tracked.row.updatedAt = now;
    }
  }

  /**
   * Open Composer model picker and scrape menu labels (VERIFIED model_select only).
   */
  async scrapeModels(): Promise<ModelScrapeCommandResult> {
    const health = await this.getHealth();
    if (health.state === "cursor_down") {
      return {
        ok: false,
        code: "CURSOR_DOWN",
        message: "Cursor CDP unreachable — cannot scrape model picker",
        domSelectVerified: false,
      };
    }
    if (!isActionVerified(this.selectorPack, "model_select")) {
      return {
        ok: false,
        code: "EXTRACTOR_STALE",
        message:
          "model_select not VERIFIED — refuse CDP model-picker scrape (fail-closed)",
        details: { action: "model_select" },
        domSelectVerified: false,
      };
    }

    const debuggerUrl = this.resolveDebuggerUrl();
    if (!debuggerUrl) {
      return {
        ok: false,
        code: "CDP_INPUT_FAILED",
        message: "No loopback CDP debugger URL for model scrape",
        domSelectVerified: false,
      };
    }

    let client;
    try {
      client = await this.cdpClientFactory(debuggerUrl);
    } catch (err) {
      return {
        ok: false,
        code: "CDP_INPUT_FAILED",
        message:
          err instanceof Error
            ? err.message
            : "Failed to open CDP session for model scrape",
        details: { debuggerUrl },
        domSelectVerified: false,
      };
    }

    try {
      const scraped = await scrapeComposerModels(client);
      if (!scraped.ok) {
        return {
          ok: false,
          code: "CDP_INPUT_FAILED",
          message: scraped.error,
          details: { methods: scraped.methods },
          domSelectVerified: false,
        };
      }
      return {
        ok: true,
        models: scraped.models,
        strategy: scraped.strategy,
        methods: scraped.methods,
        domSelectVerified: true,
      };
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async sendToAgentChat(
    composerId: string,
    text: string,
    composer?: ComposerSendOptions,
  ): Promise<ChatSendResult> {
    const health = await this.getHealth();
    if (health.state === "cursor_down") {
      return { ok: false, code: "CDP_INPUT_FAILED", error: "Cursor CDP unreachable", methods: [] };
    }
    if (!isActionVerified(this.selectorPack, "send_message")) {
      return {
        ok: false,
        code: "CDP_INPUT_FAILED",
        error: "send_message not VERIFIED — refuse to type into Cursor (fail-closed)",
        methods: [],
      };
    }
    const debuggerUrl = this.resolveDebuggerUrl();
    if (!debuggerUrl) {
      return { ok: false, code: "CDP_INPUT_FAILED", error: "No loopback CDP debugger URL", methods: [] };
    }
    let client;
    try {
      client = await this.cdpClientFactory(debuggerUrl);
    } catch (err) {
      return {
        ok: false,
        code: "CDP_INPUT_FAILED",
        error: err instanceof Error ? err.message : "Failed to open CDP session",
        methods: [],
      };
    }
    try {
      return await sendAgentChatMessage(
        client,
        composerId,
        text,
        this.selectorPack.pack.actions.send_message,
        { composer },
      );
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async newAgentChat(
    sectionId: string,
    text: string,
    composer?: ComposerSendOptions,
  ): Promise<ChatSendResult> {
    const health = await this.getHealth();
    if (health.state === "cursor_down") {
      return { ok: false, code: "CDP_INPUT_FAILED", error: "Cursor CDP unreachable", methods: [] };
    }
    if (!isActionVerified(this.selectorPack, "send_message")) {
      return {
        ok: false,
        code: "CDP_INPUT_FAILED",
        error: "send_message not VERIFIED — refuse to type into Cursor (fail-closed)",
        methods: [],
      };
    }
    const debuggerUrl = this.resolveDebuggerUrl();
    if (!debuggerUrl) {
      return { ok: false, code: "CDP_INPUT_FAILED", error: "No loopback CDP debugger URL", methods: [] };
    }
    let client;
    try {
      client = await this.cdpClientFactory(debuggerUrl);
    } catch (err) {
      return {
        ok: false,
        code: "CDP_INPUT_FAILED",
        error: err instanceof Error ? err.message : "Failed to open CDP session",
        methods: [],
      };
    }
    try {
      return await newAgentChatRun(client, sectionId, text, this.selectorPack.pack.actions.send_message, {
        composer,
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async editAgentMessage(composerId: string, bubbleId: string, text: string): Promise<ChatSendResult> {
    const health = await this.getHealth();
    if (health.state === "cursor_down") {
      return { ok: false, code: "CDP_INPUT_FAILED", error: "Cursor CDP unreachable", methods: [] };
    }
    const debuggerUrl = this.resolveDebuggerUrl();
    if (!debuggerUrl) {
      return { ok: false, code: "CDP_INPUT_FAILED", error: "No loopback CDP debugger URL", methods: [] };
    }
    let client;
    try {
      client = await this.cdpClientFactory(debuggerUrl);
    } catch (err) {
      return {
        ok: false,
        code: "CDP_INPUT_FAILED",
        error: err instanceof Error ? err.message : "Failed to open CDP session",
        methods: [],
      };
    }
    try {
      return await editAgentMessageRun(client, composerId, bubbleId, text);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async listAgentMentions(
    composerId: string,
    trigger: MentionTrigger,
    query: string,
  ): Promise<MentionResult> {
    const health = await this.getHealth();
    if (health.state === "cursor_down") {
      return { ok: false, code: "CDP_INPUT_FAILED", error: "Cursor CDP unreachable" };
    }
    const debuggerUrl = this.resolveDebuggerUrl();
    if (!debuggerUrl) return { ok: false, code: "CDP_INPUT_FAILED", error: "No loopback CDP debugger URL" };
    let client;
    try {
      client = await this.cdpClientFactory(debuggerUrl);
    } catch (err) {
      return { ok: false, code: "CDP_INPUT_FAILED", error: err instanceof Error ? err.message : "CDP session failed" };
    }
    try {
      // Files are project-scoped: list from the chat the phone is in.
      const opened = await openAgentChatRun(client, composerId);
      if (!opened.ok) return { ok: false, code: "CDP_INPUT_FAILED", error: opened.error };
      return await listMentionOptionsRun(client, trigger, query);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async stopAgentChat(composerId: string): Promise<ChatSendResult> {
    const health = await this.getHealth();
    if (health.state === "cursor_down") {
      return { ok: false, code: "CDP_INPUT_FAILED", error: "Cursor CDP unreachable", methods: [] };
    }
    const debuggerUrl = this.resolveDebuggerUrl();
    if (!debuggerUrl) {
      return { ok: false, code: "CDP_INPUT_FAILED", error: "No loopback CDP debugger URL", methods: [] };
    }
    let client;
    try {
      client = await this.cdpClientFactory(debuggerUrl);
    } catch (err) {
      return {
        ok: false,
        code: "CDP_INPUT_FAILED",
        error: err instanceof Error ? err.message : "Failed to open CDP session",
        methods: [],
      };
    }
    try {
      return await stopAgentChatRun(client, composerId);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async scrapeSidebar(): Promise<SidebarScrapeResult> {
    const health = await this.getHealth();
    if (health.state === "cursor_down") {
      return { ok: false, error: "Cursor CDP unreachable — cannot read Agents sidebar" };
    }
    const debuggerUrl = this.resolveDebuggerUrl();
    if (!debuggerUrl) {
      return { ok: false, error: "No loopback CDP debugger URL for sidebar scrape" };
    }
    let client;
    try {
      client = await this.cdpClientFactory(debuggerUrl);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Failed to open CDP session for sidebar",
      };
    }
    try {
      return await scrapeAgentsSidebar(client);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /**
   * Open loopback CDP debugger for the session window and run Input/evaluate.
   * Caller must already have verified the action gate.
   */
  private async driveDomAction(
    action: SelectorActionId,
    opts: {
      text?: string;
      preferredTargetId?: string;
      selectorOverride?: ActionSelector;
    } = {},
  ): Promise<
    | { ok: true; strategy: string; methods: string[] }
    | {
        ok: false;
        code: "CDP_INPUT_FAILED" | "CURSOR_DOWN";
        message: string;
        details?: unknown;
      }
  > {
    const debuggerUrl = this.resolveDebuggerUrl(opts.preferredTargetId);
    if (!debuggerUrl) {
      return {
        ok: false,
        code: "CDP_INPUT_FAILED",
        message: `No loopback CDP debugger URL for action ${action}`,
        details: { action, windows: this.windows.length },
      };
    }

    const selector =
      opts.selectorOverride ?? this.selectorPack.pack.actions[action];
    let client;
    try {
      client = await this.cdpClientFactory(debuggerUrl);
    } catch (err) {
      return {
        ok: false,
        code: "CDP_INPUT_FAILED",
        message:
          err instanceof Error
            ? err.message
            : `Failed to open CDP session for ${action}`,
        details: { action, debuggerUrl },
      };
    }

    try {
      const result = await executeVerifiedAction(client, action, selector, {
        text: opts.text,
      });
      if (!result.ok) {
        return {
          ok: false,
          code: "CDP_INPUT_FAILED",
          message: result.error,
          details: { action, methods: result.methods },
        };
      }
      return {
        ok: true,
        strategy: result.strategy,
        methods: result.methods,
      };
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private resolveDebuggerUrl(preferredTargetId?: string): string | null {
    if (preferredTargetId && preferredTargetId !== "hub_created") {
      const match = this.windows.find((w) => w.targetId === preferredTargetId);
      if (match?.webSocketDebuggerUrl) return match.webSocketDebuggerUrl;
    }
    const first = this.windows.find((w) => Boolean(w.webSocketDebuggerUrl));
    return first?.webSocketDebuggerUrl ?? null;
  }

  private async snapshotHealth(): Promise<LiveAdapterHealth> {
    const probe =
      this.lastProbe ??
      ({
        status: "disconnected" as const,
        urlConfigured: this.cdpUrl,
        lastAttachAt: null,
        error: this.lastError,
        cursor: { status: "not_detected" as const, windowsDetected: 0 },
      } satisfies CdpProbeResult);
    return this.buildHealth(probe, this.windows[0]?.windowId ?? null);
  }

  private buildHealth(
    probe: CdpProbeResult,
    windowId: string | null,
  ): LiveAdapterHealth {
    const state = this.deriveState(probe);
    const actions = this.selectorPack.actions;
    const sendMessageVerified = isActionVerified(
      this.selectorPack,
      "send_message",
    );
    return {
      state,
      cdpUrl: this.cdpUrl,
      selectorPack: SELECTOR_PACK_ID,
      windowId,
      workspaceId: null,
      extractorReady: state === "cdp_ok",
      lastError:
        state === "cdp_ok"
          ? null
          : this.lastError ??
            (state === "extractor_stale" ? this.selectorPack.reason : probe.error),
      attachedAt: this.attachedAt,
      actions,
      sendMessageVerified,
      probe,
    };
  }

  private deriveState(probe: CdpProbeResult): LiveHealthState {
    if (probe.status !== "connected") {
      return "cursor_down";
    }
    if (!this.selectorPack.verified) {
      return "extractor_stale";
    }
    return "cdp_ok";
  }
}

export function createLiveCursorAdapter(
  cdpUrlOrOpts?: string | LiveCursorAdapterOptions,
): LiveCursorAdapter {
  return new LiveCursorAdapterImpl(cdpUrlOrOpts);
}

/**
 * Controllable adapter for Hub unit tests (no real CDP).
 */
export function createMockLiveCursorAdapter(
  overrides: Partial<{
    cdpUrl: string;
    healthState: LiveHealthState;
    windowsDetected: number;
    sessions: LiveSessionRow[];
    /** When set, scrapeModels returns these with domSelectVerified=true (cdp_ok only). */
    scrapedModels: ScrapedModelOption[];
    /** When set, scrapeSidebar returns these sections (cdp_ok only). */
    sidebarSections: SidebarSection[];
  }> = {},
): LiveCursorAdapter {
  const cdpUrl = normalizeCdpUrl(overrides.cdpUrl ?? "http://127.0.0.1:9222");
  const healthState = overrides.healthState ?? "cursor_down";
  const windowsDetected = overrides.windowsDetected ?? 0;
  const sessions = new Map<string, LiveSessionRow>(
    (overrides.sessions ?? []).map((s) => [s.id, s]),
  );
  const approvals = new Map<string, PendingApprovalInfo>();
  /** Messages accepted by mock sendToAgentChat (tests assert on this). */
  const sentToAgentChats: Array<{ composerId: string; text: string }> = [];

  const probeFromState = (): CdpProbeResult => {
    if (healthState === "cursor_down") {
      return {
        status: "disconnected",
        urlConfigured: cdpUrl,
        lastAttachAt: null,
        error: "CDP unreachable (timeout)",
        cursor: { status: "not_detected", windowsDetected: 0 },
      };
    }
    return {
      status: "connected",
      urlConfigured: cdpUrl,
      lastAttachAt: new Date().toISOString(),
      error: null,
      cursor: { status: "running", windowsDetected },
    };
  };

  const healthFromState = (): LiveAdapterHealth => {
    const probe = probeFromState();
    // Mock: pack-wide cdp_ok ⇒ all actions VERIFIED; extractor_stale ⇒ none
    // (tests that need partial packs should use the real adapter + inject).
    const allVerified = healthState === "cdp_ok";
    const flag = allVerified ? ("VERIFIED" as const) : ("CANDIDATE" as const);
    const actions = {
      send_message: flag,
      approve: flag,
      deny: flag,
      model_select: flag,
      file_attach: flag,
      composer_history_open: flag,
    };
    return {
      state: healthState,
      cdpUrl,
      selectorPack: SELECTOR_PACK_ID,
      windowId: windowsDetected > 0 ? "win_mock" : null,
      workspaceId: null,
      extractorReady: healthState === "cdp_ok",
      lastError:
        healthState === "extractor_stale"
          ? "Selector pack not verified"
          : probe.error,
      attachedAt: healthState === "cursor_down" ? null : new Date().toISOString(),
      actions,
      sendMessageVerified: allVerified,
      probe,
    };
  };

  return {
    cdpUrl,
    async probe() {
      return probeFromState();
    },
    async attach() {
      return healthFromState();
    },
    async detach() {
      /* no-op */
    },
    async getHealth() {
      return healthFromState();
    },
    async listWindows() {
      if (healthState === "cursor_down") return [];
      return Array.from({ length: windowsDetected }, (_, i) => ({
        windowId: `win_mock_${i}`,
        targetId: `target_${i}`,
        title: `Mock Cursor ${i}`,
        url: "vscode-file://mock",
        type: "page",
      }));
    },
    async listLiveSessions(workspaceId: string) {
      if (healthState === "cursor_down") return [];
      return [...sessions.values()].map((s) => ({ ...s, workspaceId }));
    },
    async getLiveSession(sessionId: string) {
      return sessions.get(sessionId) ?? null;
    },
    async createSession(input) {
      if (healthState === "cursor_down") {
        return {
          ok: false,
          code: "CURSOR_DOWN",
          message: "Cursor down",
        };
      }
      const now = new Date().toISOString();
      const id = newId("sess_live");
      const title =
        input.prompt?.slice(0, 80) || `New session (${input.model})`;
      const row: LiveSessionRow = {
        id,
        workspaceId: input.workspaceId,
        mode: "live",
        title,
        preview: input.prompt ?? null,
        model: input.model,
        updatedAt: now,
        createdAt: now,
        pendingApprovals: 0,
        windowId: "win_mock",
        targetId: "hub_created",
      };
      sessions.set(id, row);
      return {
        ok: true,
        id,
        workspaceId: input.workspaceId,
        mode: "live",
        title,
        model: input.model,
        agentMode: input.agentMode ?? "agent",
        attachments: input.attachments ?? [],
        createdAt: now,
        updatedAt: now,
        domApplied: healthState === "cdp_ok",
        note:
          healthState === "cdp_ok"
            ? undefined
            : "Session registered; DOM not driven (extractor_stale)",
      };
    },
    async sendMessage(sessionId, content) {
      if (!sessions.has(sessionId)) {
        return { ok: false, code: "SESSION_NOT_FOUND", message: "missing" };
      }
      if (healthState === "cursor_down") {
        return { ok: false, code: "CURSOR_DOWN", message: "down" };
      }
      if (healthState === "extractor_stale") {
        return {
          ok: false,
          code: "EXTRACTOR_STALE",
          message: "extractor_stale",
        };
      }
      return {
        ok: true,
        messageId: newId("msg"),
        sessionId,
        role: "user",
        content: content.trim(),
        status: "accepted",
        createdAt: new Date().toISOString(),
        domApplied: true,
      };
    },
    async attachFiles(sessionId, attachments) {
      if (!sessions.has(sessionId)) {
        return { ok: false, code: "SESSION_NOT_FOUND", message: "missing" };
      }
      if (healthState === "cursor_down") {
        return { ok: false, code: "CURSOR_DOWN", message: "down" };
      }
      const paths = attachments.filter((p) => typeof p === "string" && p.trim());
      if (healthState === "extractor_stale") {
        return {
          ok: true,
          sessionId,
          attachments: paths,
          domApplied: false,
          note: "Hub may register paths; Composer DOM @-inject blocked until file_attach is VERIFIED.",
        };
      }
      return {
        ok: true,
        sessionId,
        attachments: paths,
        domApplied: true,
        note: "Mock: file_attach applied",
      };
    },
    async reopenComposerContext(input) {
      const composerChatId = input.composerChatId?.trim() || null;
      if (!composerChatId) {
        return {
          ok: false,
          code: "VALIDATION_ERROR",
          message:
            "Strategy B requires a desktop Composer chat id (hist_<composerId>)",
          details: { historySessionId: input.historySessionId },
        };
      }
      if (healthState === "cursor_down") {
        return {
          ok: false,
          code: "CURSOR_DOWN",
          message: "Cannot reopen Composer chat — Cursor CDP is down",
          details: { composerChatId, strategy: "ui_reopen" },
        };
      }
      if (healthState === "extractor_stale") {
        return {
          ok: false,
          code: "EXTRACTOR_STALE",
          message:
            "Composer UI reopen (strategy B) blocked — composer_history_open not VERIFIED",
          details: {
            action: "composer_history_open",
            actionStatus: "CANDIDATE",
            composerChatId,
            strategy: "ui_reopen",
            code: "OPEN_ON_PC_SELECTOR_CANDIDATE",
          },
        };
      }
      const now = new Date().toISOString();
      const id = newId("sess_live");
      const title =
        input.title?.trim() || `Composer ${composerChatId.slice(0, 8)}`;
      const row: LiveSessionRow = {
        id,
        workspaceId: input.workspaceId,
        mode: "live",
        title,
        preview: `Reopened history ${input.historySessionId}`,
        model: input.model ?? null,
        updatedAt: now,
        createdAt: now,
        pendingApprovals: 0,
        windowId: "win_mock",
        targetId: "hub_reopen",
      };
      sessions.set(id, row);
      return {
        ok: true,
        id,
        workspaceId: input.workspaceId,
        mode: "live",
        historySessionId: input.historySessionId,
        composerChatId,
        strategy: "ui_reopen",
        title,
        model: input.model ?? null,
        createdAt: now,
        updatedAt: now,
        domApplied: true,
        note: "Mock: Composer UI reopen",
      };
    },
    async applyApproval(sessionId, approvalId, decision) {
      const row = sessions.get(sessionId);
      if (!row) {
        return { ok: false, code: "SESSION_NOT_FOUND", message: "missing" };
      }
      const existing = approvals.get(approvalId);
      if (!existing || existing.sessionId !== sessionId) {
        return {
          ok: false,
          code: "APPROVAL_NOT_FOUND",
          message: `Unknown approval ${approvalId}`,
        };
      }
      if (existing.status === "resolved") {
        return {
          ok: false,
          code: "APPROVAL_APPLY_FAILED",
          message: "Approval already resolved",
        };
      }
      if (existing.synthetic) {
        const now = new Date().toISOString();
        approvals.set(approvalId, {
          ...existing,
          status: "resolved",
          decision,
        });
        if (row.pendingApprovals > 0) row.pendingApprovals -= 1;
        return {
          ok: true,
          approvalId,
          sessionId,
          decision,
          status: "recorded",
          appliedAt: now,
          domApplied: false,
          synthetic: true,
          note: "Synthetic UAT approval — decision recorded; Cursor DOM was NOT clicked",
        };
      }
      if (healthState === "cursor_down") {
        return { ok: false, code: "CURSOR_DOWN", message: "down" };
      }
      if (healthState === "extractor_stale") {
        return {
          ok: false,
          code: "EXTRACTOR_STALE",
          message: "Cannot click — approve/deny selectors not VERIFIED (extractor_stale)",
          details: {
            action: decision === "approve" ? "approve" : "deny",
            actionStatus: "CANDIDATE",
          },
        };
      }
      const now = new Date().toISOString();
      approvals.set(approvalId, {
        ...existing,
        status: "resolved",
        decision,
      });
      if (row.pendingApprovals > 0) row.pendingApprovals -= 1;
      return {
        ok: true,
        approvalId,
        sessionId,
        decision,
        status: "applied",
        appliedAt: now,
        domApplied: true,
        synthetic: false,
      };
    },
    async listPendingApprovals(sessionId) {
      return [...approvals.values()].filter(
        (a) => a.sessionId === sessionId && a.status === "pending",
      );
    },
    async enqueuePendingApproval(input) {
      const row = sessions.get(input.sessionId);
      if (!row) {
        throw new Error(`Unknown live session ${input.sessionId}`);
      }
      const approvalId =
        input.approvalId?.trim() || `apr_${randomBytes(8).toString("hex")}`;
      const now = new Date().toISOString();
      const info: PendingApprovalInfo = {
        approvalId,
        sessionId: input.sessionId,
        tool: input.tool ?? {
          name: input.synthetic ? "synthetic.uat" : "tool",
          kind: input.synthetic ? "synthetic" : null,
        },
        summary:
          input.summary?.trim() ||
          (input.synthetic
            ? "Synthetic UAT pending approval (no live Cursor tool card)"
            : "Tool call pending"),
        argsPreview: input.argsPreview,
        createdAt: now,
        expiresAt: input.expiresAt ?? null,
        status: "pending",
        synthetic: Boolean(input.synthetic),
      };
      approvals.set(approvalId, info);
      row.pendingApprovals += 1;
      return info;
    },
    async scrapeModels() {
      if (healthState === "cursor_down") {
        return {
          ok: false,
          code: "CURSOR_DOWN",
          message: "Cursor down",
          domSelectVerified: false,
        };
      }
      if (healthState !== "cdp_ok") {
        return {
          ok: false,
          code: "EXTRACTOR_STALE",
          message: "Selector pack not verified",
          domSelectVerified: false,
        };
      }
      if (overrides.scrapedModels && overrides.scrapedModels.length > 0) {
        return {
          ok: true,
          models: overrides.scrapedModels.map((m) => ({ ...m })),
          strategy: "mock-scrape",
          methods: ["Runtime.evaluate"],
          domSelectVerified: true,
        };
      }
      return {
        ok: false,
        code: "CDP_INPUT_FAILED",
        message: "Mock adapter has no scrapedModels override",
        domSelectVerified: false,
      };
    },
    async sendToAgentChat(composerId, text) {
      if (healthState !== "cdp_ok") {
        return { ok: false, code: "CDP_INPUT_FAILED", error: "Cursor down", methods: [] };
      }
      const known = (overrides.sidebarSections ?? []).some((sec) =>
        sec.chats.some((c) => c.composerId === composerId),
      );
      if (!known) {
        return {
          ok: false,
          code: "CHAT_NOT_IN_SIDEBAR",
          error: "Chat is not in the PC Agents sidebar",
          methods: [],
        };
      }
      sentToAgentChats.push({ composerId, text });
      return { ok: true, switched: true, methods: ["Runtime.evaluate", "Input.insertText"] };
    },
    async newAgentChat(sectionId, text) {
      if (healthState !== "cdp_ok") {
        return { ok: false, code: "CDP_INPUT_FAILED", error: "Cursor down", methods: [] };
      }
      const section = (overrides.sidebarSections ?? []).find((sec) => sec.sectionId === sectionId);
      if (!section) {
        return { ok: false, code: "PROJECT_NOT_IN_SIDEBAR", error: "Project is not in the PC Agents sidebar", methods: [] };
      }
      sentToAgentChats.push({ composerId: `new:${sectionId}`, text });
      return { ok: true, switched: true, methods: ["Runtime.evaluate"], composerId: "00000000-0000-4000-8000-000000000001" };
    },
    async editAgentMessage(composerId, bubbleId, text) {
      if (healthState !== "cdp_ok") {
        return { ok: false, code: "CDP_INPUT_FAILED", error: "Cursor down", methods: [] };
      }
      sentToAgentChats.push({ composerId: `edit:${composerId}:${bubbleId}`, text });
      return { ok: true, switched: false, methods: ["Input.insertText"] };
    },
    async listAgentMentions(_composerId, trigger) {
      if (healthState !== "cdp_ok") return { ok: false, code: "CDP_INPUT_FAILED", error: "Cursor down" };
      return {
        ok: true,
        options:
          trigger === "@"
            ? [{ label: "AGENTS.md", detail: "", hint: "" }]
            : [{ label: "goal", detail: "Set a goal", hint: "" }],
      };
    },
    async stopAgentChat(composerId) {
      if (healthState !== "cdp_ok") {
        return { ok: false, code: "CDP_INPUT_FAILED", error: "Cursor down", methods: [] };
      }
      const chat = (overrides.sidebarSections ?? [])
        .flatMap((sec) => sec.chats)
        .find((c) => c.composerId === composerId);
      if (!chat) {
        return { ok: false, code: "CHAT_NOT_IN_SIDEBAR", error: "Chat is not in the PC Agents sidebar", methods: [] };
      }
      if (chat.live !== "working") {
        return { ok: false, code: "NOT_RUNNING", error: "This chat is not running on the PC", methods: [] };
      }
      return { ok: true, switched: true, methods: ["Input.dispatchMouseEvent"] };
    },
    async scrapeSidebar() {
      if (healthState !== "cdp_ok") {
        return { ok: false, error: "Cursor down" };
      }
      if (!overrides.sidebarSections) {
        return { ok: false, error: "Mock adapter has no sidebarSections override" };
      }
      return {
        ok: true,
        sections: overrides.sidebarSections.map((sec) => ({
          ...sec,
          chats: sec.chats.map((c) => ({ ...c })),
        })),
      };
    },
  };
}
