/**
 * Best-effort desktop Cursor scan via composerHeaders + bubbleId KV.
 * Uses node:sqlite read-only when available; never invents rows.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  resolveDesktopGlobalStorageDb,
  resolveWorkspaceStorageRoot,
} from "./paths.js";
import { findWorkspaceStorageHashes } from "./workspace-map.js";
import type {
  HistoryBackendKind,
  HistoryMessage,
  HistorySessionDetail,
  HistorySessionSummary,
} from "./types.js";

const require = createRequire(import.meta.url);

type SqliteDb = {
  prepare: (sql: string) => {
    all: (...params: unknown[]) => unknown[];
    get: (...params: unknown[]) => unknown;
  };
  close: () => void;
};

type DatabaseSyncCtor = new (
  path: string,
  opts?: { readOnly?: boolean },
) => SqliteDb;

let DatabaseSync: DatabaseSyncCtor | null = null;
try {
  DatabaseSync = (
    require("node:sqlite") as { DatabaseSync: DatabaseSyncCtor }
  ).DatabaseSync;
} catch {
  DatabaseSync = null;
}

function openReadonlyDb(path: string): SqliteDb | null {
  if (!DatabaseSync) return null;
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    return null;
  }
}

/** Shared read-only opener for other desktop-DB readers (agents index). */
export const openReadonlyDesktopDb = openReadonlyDb;

function fingerprint(nativeKey: string): string {
  return (
    "sha256:" +
    createHash("sha256").update(nativeKey).digest("hex").slice(0, 16)
  );
}

function msToIso(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) {
    return new Date(0).toISOString();
  }
  // Cursor sometimes stores future-skewed ms; still emit ISO.
  return new Date(ms).toISOString();
}

function hubSessionId(composerId: string): string {
  return `hist_${composerId}`;
}

/**
 * Map Hub history session id → native Cursor composerId for strategy B.
 * Returns null for agent-cli rows (`hist_cli_…`) and malformed ids.
 */
export function parseDesktopComposerChatId(sessionId: string): string | null {
  if (sessionId.startsWith("hist_cli_")) return null;
  if (!sessionId.startsWith("hist_")) return null;
  const id = sessionId.slice("hist_".length);
  return id.length > 0 ? id : null;
}

function parseComposerId(sessionId: string): string | null {
  return parseDesktopComposerChatId(sessionId);
}

function bubbleRole(type: unknown): HistoryMessage["role"] {
  // Observed: type 1 ≈ user, type 2 ≈ assistant (best-effort).
  if (type === 1) return "user";
  if (type === 2) return "assistant";
  return "system";
}

/**
 * Cursor multitask marks user-facing agent chats as isSubagent=1 with
 * subagentTypeName=`generalPurpose`. Nested Task-tool helpers use other
 * type names (explore, code-reviewer, …) and must stay out of the phone list.
 */
export function isListableComposerRow(row: {
  isArchived?: number | null;
  isSubagent?: number | null;
  subagentTypeName?: string | null;
  value?: string | null;
}): boolean {
  if (row.isArchived) return false;
  let isBestOfN = false;
  let isDraft = false;
  if (row.value) {
    try {
      const v = JSON.parse(row.value) as Record<string, unknown>;
      isBestOfN = v.isBestOfNSubcomposer === true || v.isBestOfNSubcomposer === 1;
      isDraft = v.isDraft === true || v.isDraft === 1;
    } catch {
      /* ignore corrupt value — still apply column filters */
    }
  }
  if (isBestOfN || isDraft) return false;
  if (!row.isSubagent) return true;
  const typeName = (row.subagentTypeName ?? "").trim();
  // Empty / generalPurpose = user-visible composer under multitask.
  return typeName === "" || typeName === "generalPurpose";
}

/** SQL WHERE fragment matching {@link isListableComposerRow} (bound params separate). */
export const LISTABLE_COMPOSER_SQL = `
  IFNULL(isArchived, 0) = 0
  AND IFNULL(json_extract(value, '$.isBestOfNSubcomposer'), 0) = 0
  AND IFNULL(json_extract(value, '$.isDraft'), 0) = 0
  AND (
    IFNULL(isSubagent, 0) = 0
    OR IFNULL(TRIM(subagentTypeName), '') = ''
    OR subagentTypeName = 'generalPurpose'
  )
`;

export type DesktopListScanMeta = {
  reason?: string;
  /** Total listable rows for bind (ignores page `limit`). */
  totalMatched?: number;
};

export function listDesktopSessions(opts: {
  hubWorkspaceId: string;
  workspacePath?: string | null;
  limit: number;
  home?: string;
  /** Optional out-param for honest empty reasons (Hub / status). */
  meta?: DesktopListScanMeta;
}): HistorySessionSummary[] {
  const dbPath = resolveDesktopGlobalStorageDb(opts.home);
  if (!dbPath) {
    if (opts.meta) {
      opts.meta.reason =
        "Desktop globalStorage state.vscdb not found for this OS user";
    }
    return [];
  }

  const hashes = opts.workspacePath
    ? findWorkspaceStorageHashes(
        opts.workspacePath,
        resolveWorkspaceStorageRoot(opts.home),
      ).map((m) => m.hash)
    : [];
  if (!opts.workspacePath) {
    if (opts.meta) {
      opts.meta.reason =
        "No workspacePath bound — History Index abstains (prefer false negatives)";
    }
    return [];
  }
  if (hashes.length === 0) {
    // Without a path→hash match we abstain (prefer false negatives).
    if (opts.meta) {
      opts.meta.reason = `No workspaceStorage hash matched folder URI for ${opts.workspacePath}`;
    }
    return [];
  }

  const db = openReadonlyDb(dbPath);
  if (!db) {
    if (opts.meta) {
      opts.meta.reason =
        "Could not open state.vscdb read-only (node:sqlite unavailable or locked)";
    }
    return [];
  }

  try {
    const placeholders = hashes.map(() => "?").join(",");
    const countSql = `
      SELECT COUNT(*) AS n
      FROM composerHeaders
      WHERE workspaceId IN (${placeholders})
        AND ${LISTABLE_COMPOSER_SQL}
    `;
    const countRow = db.prepare(countSql).get(...hashes) as
      | { n: number | bigint }
      | undefined;
    if (opts.meta) {
      const n = countRow?.n;
      opts.meta.totalMatched =
        typeof n === "bigint" ? Number(n) : Number(n ?? 0);
    }

    const sql = `
      SELECT composerId, workspaceId, createdAt, lastUpdatedAt, value,
             isSubagent, subagentTypeName
      FROM composerHeaders
      WHERE workspaceId IN (${placeholders})
        AND ${LISTABLE_COMPOSER_SQL}
      ORDER BY COALESCE(
        lastUpdatedAt,
        CAST(json_extract(value, '$.conversationCheckpointLastUpdatedAt') AS INTEGER),
        CAST(json_extract(value, '$.lastUpdatedAt') AS INTEGER),
        createdAt,
        0
      ) DESC
      LIMIT ?
    `;
    const rows = db.prepare(sql).all(...hashes, opts.limit) as Array<{
      composerId: string;
      workspaceId: string;
      createdAt: number | null;
      lastUpdatedAt: number | null;
      value: string | null;
      isSubagent: number | null;
      subagentTypeName: string | null;
    }>;

    const out: HistorySessionSummary[] = [];
    for (const row of rows) {
      // Defense in depth — SQL + JS must agree.
      if (!isListableComposerRow(row)) continue;
      let name: string | null = null;
      let subtitle: string | null = null;
      let unifiedMode: string | null = null;
      let valueUpdatedAt: number | null = null;
      if (row.value) {
        try {
          const v = JSON.parse(row.value) as Record<string, unknown>;
          name = typeof v.name === "string" ? v.name : null;
          subtitle = typeof v.subtitle === "string" ? v.subtitle : null;
          unifiedMode =
            typeof v.unifiedMode === "string" ? v.unifiedMode : null;
          const ck = v.conversationCheckpointLastUpdatedAt;
          const lu = v.lastUpdatedAt;
          if (typeof ck === "number" && Number.isFinite(ck)) valueUpdatedAt = ck;
          else if (typeof lu === "number" && Number.isFinite(lu))
            valueUpdatedAt = lu;
        } catch {
          /* ignore */
        }
      }
      const composerId = row.composerId;
      const fp = fingerprint(composerId);
      out.push({
        sessionId: hubSessionId(composerId),
        workspaceId: opts.hubWorkspaceId,
        title: name || `Composer ${composerId.slice(0, 8)}`,
        preview: subtitle,
        model: unifiedMode,
        updatedAt: msToIso(
          row.lastUpdatedAt ?? valueUpdatedAt ?? row.createdAt,
        ),
        createdAt: msToIso(row.createdAt),
        mode: "history",
        nativeKeyFingerprint: fp,
        backend: "desktop_globalStorage" satisfies HistoryBackendKind,
        correlationKey: `ck_${fp.slice("sha256:".length)}`,
      });
    }
    if (out.length === 0 && opts.meta) {
      opts.meta.reason =
        "No listable composers for bound workspace (archived/draft/nested-subagent filtered)";
    }
    return out;
  } catch {
    if (opts.meta) {
      opts.meta.reason = "Desktop composerHeaders query failed";
    }
    return [];
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

function readConversationOrder(db: SqliteDb, composerId: string): string[] {
  const row = db
    .prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`)
    .get(`composerData:${composerId}`) as { value: string | Buffer } | undefined;
  if (!row) return [];
  try {
    const raw = Buffer.isBuffer(row.value) ? row.value.toString("utf8") : String(row.value);
    const data = JSON.parse(raw) as { fullConversationHeadersOnly?: unknown };
    if (!Array.isArray(data.fullConversationHeadersOnly)) return [];
    return data.fullConversationHeadersOnly
      .map((h) => (h as { bubbleId?: unknown }).bubbleId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

/**
 * Merge consecutive tool steps into one line ("Used read_file, grep +4 more") so a phone
 * transcript reads as a conversation, not a tool log.
 */
export function collapseToolRuns(messages: HistoryMessage[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  let run: HistoryMessage[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const names = [...new Set(run.map((m) => m.content.replace(/^Used /, "")))];
    const shown = names.slice(0, 3).join(", ");
    const extra = names.length > 3 ? ` +${names.length - 3} more` : "";
    out.push({
      ...run[0]!,
      content: `Used ${shown}${extra}${run.length > 1 ? ` (${run.length} steps)` : ""}`,
    });
    run = [];
  };
  for (const m of messages) {
    if (m.role === "tool") {
      run.push(m);
    } else {
      flush();
      out.push(m);
    }
  }
  flush();
  return out;
}

/** Text bubbles become messages; tool-only bubbles become a short "Used <tool>" line. */
function bubbleToMessage(
  row: { key: string; value: string | Buffer },
  fallbackCreatedAt: string,
): HistoryMessage | null {
  try {
    const raw = Buffer.isBuffer(row.value) ? row.value.toString("utf8") : String(row.value);
    const bubble = JSON.parse(raw) as Record<string, unknown>;
    const bubbleId =
      typeof bubble.bubbleId === "string"
        ? bubble.bubbleId
        : row.key.split(":").pop() || row.key;
    const createdAt =
      typeof bubble.createdAt === "string" ? bubble.createdAt : fallbackCreatedAt;
    // Cursor injects background-task completions as fake user turns
    // (`isSimulatedMsg`); show a one-line notice, not a "You" message.
    if (bubble.isSimulatedMsg === true) {
      const meta = bubble.simulatedMessageMetadata as { title?: unknown } | undefined;
      const title = typeof meta?.title === "string" && meta.title.trim() ? meta.title.trim() : null;
      return {
        messageId: `m_${bubbleId}`,
        role: "system",
        content: title ? `Sub-task finished: ${title}` : "Sub-task finished",
        createdAt,
      };
    }
    const text =
      typeof bubble.text === "string"
        ? bubble.text
        : typeof bubble.richText === "string"
          ? bubble.richText
          : "";
    if (text.trim()) {
      return {
        messageId: `m_${bubbleId}`,
        role: bubbleRole(bubble.type),
        content: text,
        createdAt,
      };
    }
    const tool = bubble.toolFormerData as { name?: unknown } | undefined;
    if (tool && typeof tool.name === "string" && tool.name) {
      return {
        messageId: `m_${bubbleId}`,
        role: "tool",
        content: `Used ${tool.name}`,
        createdAt,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function loadDesktopMessages(
  sessionId: string,
  opts?: { limit?: number; home?: string },
): {
  summary: HistorySessionSummary | null;
  messages: HistoryMessage[];
  truncated: boolean;
} {
  const composerId = parseComposerId(sessionId);
  if (!composerId) {
    return { summary: null, messages: [], truncated: false };
  }

  const dbPath = resolveDesktopGlobalStorageDb(opts?.home);
  if (!dbPath) {
    return { summary: null, messages: [], truncated: false };
  }

  const db = openReadonlyDb(dbPath);
  if (!db) {
    return { summary: null, messages: [], truncated: false };
  }

  const limit = opts?.limit ?? 200;

  try {
    const header = db
      .prepare(
        `SELECT composerId, workspaceId, createdAt, lastUpdatedAt, value
         FROM composerHeaders WHERE composerId = ? LIMIT 1`,
      )
      .get(composerId) as
      | {
          composerId: string;
          workspaceId: string;
          createdAt: number | null;
          lastUpdatedAt: number | null;
          value: string | null;
        }
      | undefined;

    if (!header) {
      return { summary: null, messages: [], truncated: false };
    }

    let name: string | null = null;
    let subtitle: string | null = null;
    let unifiedMode: string | null = null;
    if (header.value) {
      try {
        const v = JSON.parse(header.value) as Record<string, unknown>;
        name = typeof v.name === "string" ? v.name : null;
        subtitle = typeof v.subtitle === "string" ? v.subtitle : null;
        unifiedMode =
          typeof v.unifiedMode === "string" ? v.unifiedMode : null;
      } catch {
        /* ignore */
      }
    }

    const fp = fingerprint(composerId);
    const summary: HistorySessionSummary = {
      sessionId: hubSessionId(composerId),
      workspaceId: "", // Hub fills bind id on response
      title: name || `Composer ${composerId.slice(0, 8)}`,
      preview: subtitle,
      model: unifiedMode,
      updatedAt: msToIso(header.lastUpdatedAt ?? header.createdAt),
      createdAt: msToIso(header.createdAt),
      mode: "history",
      nativeKeyFingerprint: fp,
      backend: "desktop_globalStorage",
      correlationKey: `ck_${fp.slice("sha256:".length)}`,
    };

    // Conversation order comes from composerData.fullConversationHeadersOnly; each
    // bubble is then a primary-key lookup. A `LIKE 'bubbleId:<id>:%'` scan cannot use
    // the index and took ~6 s on a 160k-row store (2026-10-01 device test).
    const order = readConversationOrder(db, composerId);
    let bubbles: Array<{ key: string; value: string | Buffer }>;
    let truncated: boolean;
    if (order.length > 0) {
      truncated = order.length > limit;
      const ids = truncated ? order.slice(-limit) : order;
      const byKey = db.prepare(`SELECT key, value FROM cursorDiskKV WHERE key = ?`);
      bubbles = [];
      for (const bubbleId of ids) {
        const row = byKey.get(`bubbleId:${composerId}:${bubbleId}`) as
          | { key: string; value: string | Buffer }
          | undefined;
        if (row) bubbles.push(row);
      }
    } else {
      // No header list: index range scan over this composer's bubble keys.
      const rows = db
        .prepare(
          `SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ? LIMIT ?`,
        )
        .all(`bubbleId:${composerId}:`, `bubbleId:${composerId};`, limit + 1) as Array<{
        key: string;
        value: string | Buffer;
      }>;
      truncated = rows.length > limit;
      bubbles = truncated ? rows.slice(0, limit) : rows;
    }

    const messages: HistoryMessage[] = [];
    for (const row of bubbles) {
      const message = bubbleToMessage(row, summary.createdAt);
      if (message) messages.push(message);
    }

    // Header order is authoritative; only the fallback path needs a time sort.
    if (order.length === 0) {
      messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    const compact = collapseToolRuns(messages);
    messages.length = 0;
    messages.push(...compact);

    return { summary, messages, truncated };
  } catch {
    return { summary: null, messages: [], truncated: false };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

export function toDetail(
  summary: HistorySessionSummary,
  messages: HistoryMessage[],
  truncated: boolean,
): HistorySessionDetail {
  return {
    ...summary,
    messages,
    truncated,
    capabilities: { canOpenOnPc: true, readOnly: true },
  };
}

/** Exported for tests — parse helpers. */
export const desktopScanInternals = {
  bubbleToMessage,
  hubSessionId,
  parseComposerId,
  fingerprint,
};
