/**
 * Agents-window index — per-chat status for the phone Chats list.
 *
 * Reads Cursor's own `composerHeaders` + `composerData:<id>` rows in the desktop
 * globalStorage DB (read-only). Which chats appear, and in what order, comes from the
 * Agents sidebar (live adapter); this module only describes those chats, plus a
 * recent-local fallback for when Cursor is closed. Never invents rows.
 */

import { basename } from "node:path";
import { resolveDesktopGlobalStorageDb } from "./paths.js";
import { LISTABLE_COMPOSER_SQL, openReadonlyDesktopDb } from "./desktop-scan.js";

export type AgentChatStatus = "working" | "waiting_approval" | "error" | "idle";

export interface AgentChatDetails {
  composerId: string;
  /** Hub history session id (`hist_<composerId>`) — opens the transcript. */
  sessionId: string;
  title: string;
  status: AgentChatStatus;
  unread: boolean;
  linesAdded: number;
  linesRemoved: number;
  mode: string | null;
  createdAt: string;
  updatedAt: string;
  /** Cursor workspace hash (matches the sidebar `workspace:<hash>` section id). */
  projectId: string;
  projectPath: string | null;
}

export interface AgentProjectGroup {
  projectId: string;
  name: string;
  path: string | null;
  chats: AgentChatDetails[];
}

type HeaderRow = {
  composerId: string;
  workspaceId: string | null;
  createdAt: number | null;
  lastUpdatedAt: number | null;
  value: string | null;
  dataStatus: string | null;
  generating: number | null;
};

const HEADER_SELECT = `
  SELECT h.composerId, h.workspaceId, h.createdAt, h.lastUpdatedAt, h.value,
         json_extract(d.value, '$.status') AS dataStatus,
         json_array_length(d.value, '$.generatingBubbleIds') AS generating
  FROM composerHeaders h
  LEFT JOIN cursorDiskKV d ON d.key = 'composerData:' || h.composerId
`;

function isoOrEpoch(ms: number | null | undefined): string {
  return new Date(ms != null && Number.isFinite(ms) ? ms : 0).toISOString();
}

/** Status precedence: approval wait beats running; running beats error. */
export function deriveChatStatus(input: {
  hasBlockingPendingActions?: unknown;
  dataStatus?: string | null;
  generating?: number | null;
}): AgentChatStatus {
  // Cursor leaves hasBlockingPendingActions set on finished chats (seen on 4/4 flagged
  // chats, all status=completed), so only trust it while the run is not completed.
  if (input.hasBlockingPendingActions === true && input.dataStatus !== "completed") {
    return "waiting_approval";
  }
  if ((input.generating ?? 0) > 0 || input.dataStatus === "generating") return "working";
  if (input.dataStatus === "error" || input.dataStatus === "aborted") return "error";
  return "idle";
}

export function rowToChatDetails(row: HeaderRow): AgentChatDetails {
  let v: Record<string, unknown> = {};
  if (row.value) {
    try {
      v = JSON.parse(row.value) as Record<string, unknown>;
    } catch {
      v = {};
    }
  }
  const ws = (v.workspaceIdentifier ?? {}) as {
    id?: unknown;
    uri?: { fsPath?: unknown };
  };
  const projectId =
    (typeof ws.id === "string" && ws.id) || row.workspaceId || "unknown";
  const projectPath = typeof ws.uri?.fsPath === "string" ? ws.uri.fsPath : null;
  const name = typeof v.name === "string" && v.name.trim() ? v.name : null;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return {
    composerId: row.composerId,
    sessionId: `hist_${row.composerId}`,
    title: name ?? `Chat ${row.composerId.slice(0, 8)}`,
    status: deriveChatStatus({
      hasBlockingPendingActions: v.hasBlockingPendingActions,
      dataStatus: row.dataStatus,
      generating: row.generating,
    }),
    unread: v.hasUnreadMessages === true,
    linesAdded: num(v.totalLinesAdded),
    linesRemoved: num(v.totalLinesRemoved),
    mode: typeof v.unifiedMode === "string" ? v.unifiedMode : null,
    createdAt: isoOrEpoch(row.createdAt),
    updatedAt: isoOrEpoch(row.lastUpdatedAt ?? row.createdAt),
    projectId,
    projectPath,
  };
}

/**
 * Describe the given chats (composer ids from the Agents sidebar).
 * Unknown ids are simply absent from the map.
 */
export function describeAgentChats(
  composerIds: string[],
  opts?: { home?: string },
): Map<string, AgentChatDetails> {
  const out = new Map<string, AgentChatDetails>();
  if (composerIds.length === 0) return out;
  const dbPath = resolveDesktopGlobalStorageDb(opts?.home);
  const db = dbPath ? openReadonlyDesktopDb(dbPath) : null;
  if (!db) return out;
  try {
    const stmt = db.prepare(`${HEADER_SELECT} WHERE h.composerId = ?`);
    for (const id of composerIds) {
      const row = stmt.get(id) as HeaderRow | undefined;
      if (row) out.set(id, rowToChatDetails(row));
    }
    return out;
  } catch {
    return out;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/** Only folders that exist on this PC — skips chats synced from other machines (`e:\…`). */
function isLocalPosixPath(p: string | null): p is string {
  return typeof p === "string" && p.startsWith("/");
}

export function groupChatsByProject(chats: AgentChatDetails[]): AgentProjectGroup[] {
  const groups = new Map<string, AgentProjectGroup>();
  for (const chat of chats) {
    let g = groups.get(chat.projectId);
    if (!g) {
      g = {
        projectId: chat.projectId,
        name: chat.projectPath ? basename(chat.projectPath) : chat.projectId.slice(0, 8),
        path: chat.projectPath,
        chats: [],
      };
      groups.set(chat.projectId, g);
    }
    g.chats.push(chat);
  }
  return [...groups.values()];
}

/**
 * Fallback when the Agents sidebar can't be read (Cursor closed): most recent listable
 * local chats, grouped by project, newest first.
 */
export function listRecentLocalProjects(opts?: {
  limit?: number;
  home?: string;
}): AgentProjectGroup[] {
  const limit = opts?.limit ?? 40;
  const dbPath = resolveDesktopGlobalStorageDb(opts?.home);
  const db = dbPath ? openReadonlyDesktopDb(dbPath) : null;
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        `${HEADER_SELECT}
         WHERE ${LISTABLE_COMPOSER_SQL.replace(/\b(isArchived|isSubagent|subagentTypeName|value)\b/g, "h.$1")}
           AND IFNULL(json_extract(h.value, '$.isEphemeral'), 0) = 0
           AND h.workspaceId IS NOT NULL AND h.workspaceId != 'empty-window'
         ORDER BY COALESCE(h.lastUpdatedAt, h.createdAt, 0) DESC
         LIMIT ?`,
      )
      .all(limit * 3) as HeaderRow[];
    const chats = rows
      .map(rowToChatDetails)
      .filter((c) => isLocalPosixPath(c.projectPath))
      .slice(0, limit);
    return groupChatsByProject(chats);
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}
