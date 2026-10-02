/**
 * Local History Index adapter — Phase 2.
 * Scans PC Cursor storage when present; empty when missing / unreadable.
 */

import {
  listAgentCliSessions,
  loadAgentCliSession,
  parseCliSessionId,
  type AgentCliListScanMeta,
} from "./agent-cli-scan.js";
import {
  listDesktopSessions,
  loadDesktopMessages,
  toDetail,
  type DesktopListScanMeta,
} from "./desktop-scan.js";
import { listStoragePathCandidates } from "./paths.js";
import type {
  HistoryAdapter,
  HistoryAdapterStatus,
  HistoryListOptions,
  HistoryOpenOnPcOutcome,
  HistorySessionDetail,
  HistorySessionSummary,
} from "./types.js";

export interface LocalHistoryAdapterOptions {
  /** Override home for tests. */
  home?: string;
  /**
   * Optional open-on-PC bridge (Hub injects LiveCursorAdapter create).
   * When absent, openOnPc returns OPEN_ON_PC_UNSUPPORTED.
   */
  openOnPcBridge?: (session: HistorySessionDetail) => Promise<HistoryOpenOnPcOutcome>;
}

export class LocalHistoryAdapter implements HistoryAdapter {
  private lastScanAt: string | null = null;
  private lastBindCount: number | null = null;
  private lastBindReason: string | null = null;
  private readonly home?: string;
  private readonly openOnPcBridge?: LocalHistoryAdapterOptions["openOnPcBridge"];

  constructor(opts: LocalHistoryAdapterOptions = {}) {
    this.home = opts.home;
    this.openOnPcBridge = opts.openOnPcBridge;
  }

  async getStatus(workspaceId?: string): Promise<HistoryAdapterStatus> {
    const backends = listStoragePathCandidates(this.home).map((c) => ({
      kind: c.kind,
      path: c.path,
      present: c.present,
    }));
    const anyPresent = backends.some((b) => b.present);
    let reason: string | undefined;
    if (!anyPresent) {
      reason = "No local Cursor storage paths detected for this OS user";
    } else if (
      workspaceId &&
      this.lastBindCount === 0 &&
      this.lastBindReason
    ) {
      reason = this.lastBindReason;
    }
    return {
      ok: anyPresent,
      backends,
      lastScanAt: this.lastScanAt,
      sessionCountForBind: workspaceId ? this.lastBindCount : null,
      extractorStale: !anyPresent,
      reason,
    };
  }

  async listSessions(
    options: HistoryListOptions,
  ): Promise<HistorySessionSummary[]> {
    /** Page size for Hub/phone; status uses full bind totals (not page length). */
    const limit = options.limit ?? 100;
    const meta: DesktopListScanMeta = {};
    const cliMeta: AgentCliListScanMeta = {};
    const desktop = listDesktopSessions({
      hubWorkspaceId: options.workspaceId,
      workspacePath: options.workspacePath,
      limit,
      home: this.home,
      meta,
    });
    const remaining = Math.max(0, limit - desktop.length);
    // Always scan CLI for totalMatched even when the page is already full.
    const cli = listAgentCliSessions({
      hubWorkspaceId: options.workspaceId,
      workspacePath: options.workspacePath,
      limit: remaining,
      home: this.home,
      meta: cliMeta,
    });

    const merged = [...desktop, ...cli];
    merged.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const sliced = merged.slice(0, limit);
    this.lastScanAt = new Date().toISOString();
    const desktopTotal = meta.totalMatched ?? desktop.length;
    const cliTotal = cliMeta.totalMatched ?? 0;
    this.lastBindCount = desktopTotal + cliTotal;
    this.lastBindReason =
      sliced.length > 0
        ? null
        : meta.reason ??
          (desktopTotal === 0 && cliTotal === 0
            ? "No local history rows for bound workspace"
            : null);
    return sliced;
  }

  async getSession(sessionId: string): Promise<HistorySessionDetail | null> {
    if (parseCliSessionId(sessionId)) {
      const loaded = loadAgentCliSession(sessionId, { home: this.home });
      if (!loaded.summary) return null;
      return toDetail(loaded.summary, loaded.messages, loaded.truncated);
    }
    const loaded = loadDesktopMessages(sessionId, { home: this.home });
    if (!loaded.summary) return null;
    return toDetail(loaded.summary, loaded.messages, loaded.truncated);
  }

  async getMessages(
    sessionId: string,
    opts?: { limit?: number },
  ): Promise<{
    sessionId: string;
    messages: HistorySessionDetail["messages"];
    truncated: boolean;
  } | null> {
    const detail = await this.getSession(sessionId);
    if (!detail) return null;
    const limit = opts?.limit ?? 200;
    const truncated = detail.truncated || detail.messages.length > limit;
    return {
      sessionId,
      messages: detail.messages.slice(0, limit),
      truncated,
    };
  }

  async openOnPc(sessionId: string): Promise<HistoryOpenOnPcOutcome> {
    const detail = await this.getSession(sessionId);
    if (!detail) {
      return {
        ok: false,
        code: "SESSION_NOT_FOUND",
        message: `Unknown history session ${sessionId}`,
      };
    }
    if (this.openOnPcBridge) {
      return this.openOnPcBridge(detail);
    }
    return {
      ok: false,
      code: "OPEN_ON_PC_UNSUPPORTED",
      message:
        "Open on PC requires LiveCursorAdapter bridge (focus/reopen Composer). Hub should inject the bridge or return 501.",
    };
  }
}

/** Empty stub for unit tests that must not touch real Cursor storage. */
export class StubHistoryAdapter implements HistoryAdapter {
  async getStatus(): Promise<HistoryAdapterStatus> {
    return {
      ok: true,
      backends: [],
      lastScanAt: null,
      sessionCountForBind: 0,
      extractorStale: false,
      reason: "stub",
    };
  }

  async listSessions(
    _options: HistoryListOptions,
  ): Promise<HistorySessionSummary[]> {
    return [];
  }

  async getSession(_sessionId: string): Promise<HistorySessionDetail | null> {
    return null;
  }

  async getMessages(_sessionId: string) {
    return null;
  }

  async openOnPc(_sessionId: string): Promise<HistoryOpenOnPcOutcome> {
    return {
      ok: false,
      code: "OPEN_ON_PC_UNSUPPORTED",
      message: "StubHistoryAdapter — open-on-PC not wired",
    };
  }
}

/** In-memory fixture adapter for Hub filter / empty tests. */
export class MemoryHistoryAdapter implements HistoryAdapter {
  constructor(private sessions: HistorySessionDetail[] = []) {}

  async getStatus(workspaceId?: string): Promise<HistoryAdapterStatus> {
    const count = workspaceId
      ? this.sessions.filter((s) => s.workspaceId === workspaceId).length
      : this.sessions.length;
    return {
      ok: true,
      backends: [{ kind: "memory", path: ":memory:", present: true }],
      lastScanAt: new Date().toISOString(),
      sessionCountForBind: count,
      extractorStale: false,
    };
  }

  async listSessions(
    options: HistoryListOptions,
  ): Promise<HistorySessionSummary[]> {
    const limit = options.limit ?? 50;
    return this.sessions
      .filter((s) => s.workspaceId === options.workspaceId)
      .slice(0, limit)
      .map(({ messages: _m, capabilities: _c, truncated: _t, ...summary }) => summary);
  }

  async getSession(sessionId: string): Promise<HistorySessionDetail | null> {
    return this.sessions.find((s) => s.sessionId === sessionId) ?? null;
  }

  async getMessages(sessionId: string, opts?: { limit?: number }) {
    const s = await this.getSession(sessionId);
    if (!s) return null;
    const limit = opts?.limit ?? 200;
    return {
      sessionId,
      messages: s.messages.slice(0, limit),
      truncated: s.truncated || s.messages.length > limit,
    };
  }

  async openOnPc(sessionId: string): Promise<HistoryOpenOnPcOutcome> {
    const s = await this.getSession(sessionId);
    if (!s) {
      return {
        ok: false,
        code: "SESSION_NOT_FOUND",
        message: "missing",
      };
    }
    return {
      ok: false,
      code: "OPEN_ON_PC_UNSUPPORTED",
      message: "MemoryHistoryAdapter has no live bridge",
    };
  }
}

export function createHistoryAdapter(
  opts?: LocalHistoryAdapterOptions,
): HistoryAdapter {
  return new LocalHistoryAdapter(opts);
}
