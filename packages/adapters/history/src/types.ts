/**
 * History Index types — PC-local only (TOR-07).
 */

export type HistorySessionMode = "history";

export type HistoryBackendKind =
  | "desktop_globalStorage"
  | "agent_cli_chats";

export interface HistorySessionSummary {
  sessionId: string;
  workspaceId: string;
  title: string;
  preview: string | null;
  model: string | null;
  updatedAt: string;
  createdAt: string;
  mode: HistorySessionMode;
  /** One-way fingerprint of native key — diagnostics only. */
  nativeKeyFingerprint: string;
  backend: HistoryBackendKind;
  correlationKey: string;
}

export interface HistoryMessage {
  messageId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: string;
}

export interface HistorySessionDetail extends HistorySessionSummary {
  messages: HistoryMessage[];
  truncated: boolean;
  capabilities: {
    canOpenOnPc: boolean;
    readOnly: true;
  };
}

export interface HistoryListOptions {
  /** Hub-bound workspace id (`ws_…`). */
  workspaceId: string;
  /** Absolute PC path for CURSOR_WORKSPACE / bind — preferred for hash match. */
  workspacePath?: string | null;
  limit?: number;
}

export interface HistoryAdapterStatus {
  ok: boolean;
  backends: Array<{
    kind: string;
    path: string;
    present: boolean;
  }>;
  lastScanAt: string | null;
  sessionCountForBind: number | null;
  extractorStale: boolean;
  reason?: string;
}

export interface HistoryOpenOnPcResult {
  ok: true;
  liveSessionId: string;
  strategy:
    | "focus_existing"
    | "ui_reopen"
    | "new_live_context"
    | "unsupported";
  note?: string;
}

export interface HistoryOpenOnPcFailure {
  ok: false;
  code:
    | "SESSION_NOT_FOUND"
    | "SESSION_NOT_HISTORY"
    | "OPEN_ON_PC_UNSUPPORTED"
    | "OPEN_ON_PC_CDP_DOWN"
    | "HISTORY_UNAVAILABLE";
  message: string;
}

export type HistoryOpenOnPcOutcome =
  | HistoryOpenOnPcResult
  | HistoryOpenOnPcFailure;

export interface HistoryAdapter {
  getStatus(workspaceId?: string): Promise<HistoryAdapterStatus>;

  listSessions(options: HistoryListOptions): Promise<HistorySessionSummary[]>;

  getSession(sessionId: string): Promise<HistorySessionDetail | null>;

  getMessages(
    sessionId: string,
    opts?: { limit?: number },
  ): Promise<{
    sessionId: string;
    messages: HistoryMessage[];
    truncated: boolean;
  } | null>;

  /**
   * Resolve open-on-PC hints. Hub wires LiveCursorAdapter;
   * adapter alone may return unsupported when no live bridge is injected.
   */
  openOnPc(sessionId: string): Promise<HistoryOpenOnPcOutcome>;
}
