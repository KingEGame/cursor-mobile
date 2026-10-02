import type { ChatSendResult } from "./chat-send.js";
import type { SidebarScrapeResult } from "./sidebar-scrape.js";
/** Live adapter health triad (TOR-06). */
export type LiveHealthState = "cdp_ok" | "extractor_stale" | "cursor_down";

export type CdpProbeStatus = "connected" | "disconnected" | "error";

export type CursorDetectStatus = "running" | "not_detected";

export interface CdpProbeResult {
  status: CdpProbeStatus;
  urlConfigured: string;
  lastAttachAt: string | null;
  error: string | null;
  cursor: {
    status: CursorDetectStatus;
    windowsDetected: number;
  };
}

/** CDP discovery target (Chrome DevTools /json/list). */
export interface CdpTarget {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface LiveWindow {
  windowId: string;
  targetId: string;
  title: string;
  url: string;
  type: string;
  /** Loopback CDP page debugger URL when discovered via /json/list. */
  webSocketDebuggerUrl?: string;
}

export interface LiveSessionRow {
  id: string;
  workspaceId: string;
  mode: "live";
  title: string;
  preview: string | null;
  model: string | null;
  updatedAt: string;
  createdAt: string;
  pendingApprovals: number;
  windowId: string;
  targetId: string;
}

export interface LiveAdapterHealth {
  state: LiveHealthState;
  cdpUrl: string;
  selectorPack: string | null;
  windowId: string | null;
  workspaceId: string | null;
  extractorReady: boolean;
  lastError: string | null;
  attachedAt: string | null;
  /**
   * Per-action VERIFIED / CANDIDATE flags from the selector pack.
   * Overall `state` may stay `extractor_stale` while `send_message` is VERIFIED —
   * Hub/APK must gate mutations per action, not only on pack-wide readiness.
   */
  actions?: Record<string, "VERIFIED" | "CANDIDATE">;
  /** True when send_message selectors are VERIFIED (Composer type+send may proceed). */
  sendMessageVerified?: boolean;
  /** Phase 0 /health compatibility slice. */
  probe: CdpProbeResult;
}

export type CommandFailureCode =
  | "CURSOR_DOWN"
  | "EXTRACTOR_STALE"
  | "SESSION_NOT_FOUND"
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_APPLY_FAILED"
  | "CDP_INPUT_FAILED"
  | "VALIDATION_ERROR";

export type CommandResult<T = Record<string, unknown>> =
  | ({ ok: true } & T)
  | {
      ok: false;
      code: CommandFailureCode;
      message: string;
      details?: unknown;
    };

export interface CreateLiveSessionInput {
  workspaceId: string;
  model: string;
  attachments?: string[];
  prompt?: string;
  agentMode?: string;
}

export interface CreateLiveSessionResult {
  id: string;
  workspaceId: string;
  mode: "live";
  title: string;
  model: string;
  agentMode: string;
  attachments: string[];
  createdAt: string;
  updatedAt: string;
  /** false when DOM selectors are not ready — Hub must not claim Composer was driven. */
  domApplied: boolean;
  note?: string;
}

export interface SendMessageResult {
  messageId: string;
  sessionId: string;
  role: "user";
  content: string;
  status: "accepted" | "deferred";
  createdAt: string;
  domApplied: boolean;
}

export interface AttachFilesResult {
  sessionId: string;
  attachments: string[];
  /** True only when file_attach is VERIFIED and CDP inject ran successfully. */
  domApplied: boolean;
  note?: string;
}

/** One model option scraped from the Composer picker (Hub may map to WorkspaceModel). */
export interface ScrapedModelOption {
  id: string;
  label: string;
  family: string;
  available: boolean;
  default: boolean;
}

export type ModelScrapeCommandResult =
  | {
      ok: true;
      models: ScrapedModelOption[];
      strategy: string;
      methods: string[];
      domSelectVerified: true;
    }
  | {
      ok: false;
      code: CommandFailureCode;
      message: string;
      details?: unknown;
      domSelectVerified: false;
    };

/** Hints for TOR-07 strategy B — Composer UI reopen from a history row. */
export interface ReopenComposerContextInput {
  workspaceId: string;
  historySessionId: string;
  /** Native Cursor composerId when known (desktop hist_* without hist_cli_). */
  composerChatId: string | null;
  title?: string | null;
  correlationKey?: string | null;
  model?: string | null;
}

export type ReopenComposerStrategy = "ui_reopen";

export interface ReopenComposerContextResult {
  id: string;
  workspaceId: string;
  mode: "live";
  historySessionId: string;
  composerChatId: string;
  strategy: ReopenComposerStrategy;
  title: string;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  /** True only when composer_history_open is VERIFIED and CDP click succeeded. */
  domApplied: boolean;
  note?: string;
}

export interface ApprovalResult {
  approvalId: string;
  sessionId: string;
  decision: "approve" | "deny";
  /** `recorded` = synthetic UAT path (no Cursor DOM click). */
  status: "applied" | "rejected" | "recorded";
  appliedAt: string;
  /** True only when approve/deny selectors were VERIFIED and CDP click succeeded. */
  domApplied: boolean;
  /** Present when decision came from Hub synthetic UAT enqueue. */
  synthetic?: boolean;
  note?: string;
}

export interface PendingApprovalTool {
  name: string;
  server?: string | null;
  kind?: string | null;
}

/** In-adapter pending/resolved approval row (live + synthetic UAT). */
export interface PendingApprovalInfo {
  approvalId: string;
  sessionId: string;
  tool: PendingApprovalTool;
  summary: string;
  argsPreview?: unknown;
  createdAt: string;
  expiresAt?: string | null;
  status: "pending" | "resolved";
  decision?: "approve" | "deny";
  /**
   * True when enqueued via Hub synthetic UAT route.
   * Never implies a live Cursor tool-card DOM match.
   */
  synthetic: boolean;
}

export interface EnqueueApprovalInput {
  sessionId: string;
  approvalId?: string;
  tool?: PendingApprovalTool;
  summary?: string;
  argsPreview?: unknown;
  /** Default false. Synthetic = UAT-only decision path without DOM. */
  synthetic?: boolean;
  expiresAt?: string | null;
}

export interface LiveCursorAdapter {
  readonly cdpUrl: string;

  /** CDP HTTP probe — Phase 0 compatibility. */
  probe(): Promise<CdpProbeResult>;

  /** Attach lifecycle: probe + list targets + load selector pack. */
  attach(): Promise<LiveAdapterHealth>;

  detach(): Promise<void>;

  getHealth(): Promise<LiveAdapterHealth>;

  /** Best-effort window list via CDP /json/list; empty when cursor_down. */
  listWindows(): Promise<LiveWindow[]>;

  /**
   * Live Composer/agent sessions for a workspace.
   * Best-effort from CDP targets; empty when cursor_down or no match.
   */
  listLiveSessions(workspaceId: string): Promise<LiveSessionRow[]>;

  getLiveSession(sessionId: string): Promise<LiveSessionRow | null>;

  createSession(
    input: CreateLiveSessionInput,
  ): Promise<CommandResult<CreateLiveSessionResult>>;

  sendMessage(
    sessionId: string,
    content: string,
  ): Promise<CommandResult<SendMessageResult>>;

  /**
   * Inject workspace attachment paths into Composer via CDP.
   * Fail-closed: returns domApplied=false unless file_attach is VERIFIED.
   * Hub may still register paths when domApplied is false.
   */
  attachFiles(
    sessionId: string,
    attachments: string[],
  ): Promise<CommandResult<AttachFilesResult>>;

  /**
   * Strategy B — focus/open an existing Composer chat via CDP UI.
   * Fail-closed: EXTRACTOR_STALE while composer_history_open is CANDIDATE;
   * CURSOR_DOWN when CDP is unreachable. Never invents a cloud resume path.
   */
  reopenComposerContext(
    input: ReopenComposerContextInput,
  ): Promise<CommandResult<ReopenComposerContextResult>>;

  applyApproval(
    sessionId: string,
    approvalId: string,
    decision: "approve" | "deny",
  ): Promise<CommandResult<ApprovalResult>>;

  /** List pending (and optionally resolved) approvals for a live session. */
  listPendingApprovals(sessionId: string): Promise<PendingApprovalInfo[]>;

  /**
   * Register a pending approval (live extractor or Hub synthetic UAT).
   * Synthetic rows resolve without Cursor DOM when applyApproval is called.
   */
  enqueuePendingApproval(
    input: EnqueueApprovalInput,
  ): Promise<PendingApprovalInfo>;

  /**
   * Scrape Composer model picker options via CDP when model_select is VERIFIED.
   * Fail-closed: returns ok=false when CDP down, selectors stale, or DOM miss.
   */
  scrapeModels(): Promise<ModelScrapeCommandResult>;

  /**
   * Read the Agents-window sidebar (projects → chats) via one read-only
   * Runtime.evaluate. No clicks. Fail-closed when CDP is down or the DOM shape changed.
   */
  scrapeSidebar(): Promise<SidebarScrapeResult>;

  /**
   * Open `composerId` in the PC Agents window (sidebar click, verified switch) and
   * type + submit `text`. Requires send_message VERIFIED; never types into another chat.
   */
  sendToAgentChat(composerId: string, text: string): Promise<ChatSendResult>;
}
