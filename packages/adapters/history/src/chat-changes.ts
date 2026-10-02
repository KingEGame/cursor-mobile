/**
 * Files an Agents chat changed, as read-only diffs (original → current disk).
 *
 * Cursor keeps the pre-edit content of every file a chat touched:
 *   composerData:<id>.originalFileStates[<file uri>] = { contentKey, isNewlyCreated }
 *   cursorDiskKV[contentKey] = original text
 * The current side is the file on disk now. Files are addressed by their index in that
 * chat's list — the phone never sends a path, so it can only see files the chat edited.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { structuredPatch } from "diff";
import { resolveDesktopGlobalStorageDb } from "./paths.js";
import { openReadonlyDesktopDb } from "./desktop-scan.js";

/** Larger files are listed but not diffed (phone screen + Hub memory). */
const MAX_DIFF_BYTES = 1_000_000;

export interface ChatFileChange {
  index: number;
  path: string;
  isNew: boolean;
  /** File no longer exists on disk. */
  deleted: boolean;
  added: number;
  removed: number;
  /** Not diffed (too large or binary). */
  skipped: string | null;
}

export interface ChatFileDiff extends ChatFileChange {
  hunks: Array<{ oldStart: number; newStart: number; lines: string[] }>;
}

type Origin = { path: string; isNew: boolean; original: string | null };

function readOrigins(composerId: string, home?: string): Origin[] | null {
  const dbPath = resolveDesktopGlobalStorageDb(home);
  const db = dbPath ? openReadonlyDesktopDb(dbPath) : null;
  if (!db) return null;
  try {
    const row = db.prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`).get(`composerData:${composerId}`) as
      | { value: string | Buffer }
      | undefined;
    if (!row) return null;
    const raw = Buffer.isBuffer(row.value) ? row.value.toString("utf8") : String(row.value);
    const states = (JSON.parse(raw) as { originalFileStates?: Record<string, unknown> }).originalFileStates ?? {};
    const byKey = db.prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`);
    const out: Origin[] = [];
    for (const [uri, state] of Object.entries(states)) {
      if (!uri.startsWith("file://")) continue;
      let path: string;
      try {
        path = fileURLToPath(uri);
      } catch {
        continue;
      }
      const s = (state ?? {}) as { contentKey?: unknown; isNewlyCreated?: unknown };
      let original: string | null = null;
      if (typeof s.contentKey === "string") {
        const hit = byKey.get(s.contentKey) as { value: string | Buffer } | undefined;
        if (hit) original = Buffer.isBuffer(hit.value) ? hit.value.toString("utf8") : String(hit.value);
      }
      out.push({ path, isNew: s.isNewlyCreated === true, original });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

function readCurrent(path: string): { text: string | null; skipped: string | null } {
  if (!existsSync(path)) return { text: null, skipped: null };
  try {
    if (statSync(path).size > MAX_DIFF_BYTES) return { text: null, skipped: "File too large to diff" };
    const buf = readFileSync(path);
    if (buf.includes(0)) return { text: null, skipped: "Binary file" };
    return { text: buf.toString("utf8"), skipped: null };
  } catch {
    return { text: null, skipped: "Could not read file" };
  }
}

/** Pure diff step — exported for tests. */
export function diffFile(
  index: number,
  origin: Origin,
  current: { text: string | null; skipped: string | null },
): ChatFileDiff {
  const deleted = current.text === null && current.skipped === null;
  const base = { index, path: origin.path, isNew: origin.isNew, deleted };
  const before = origin.isNew ? "" : origin.original;
  if (current.skipped || before === null || before.length > MAX_DIFF_BYTES) {
    return {
      ...base,
      added: 0,
      removed: 0,
      skipped: current.skipped ?? (before === null ? "Original not recorded by Cursor" : "File too large to diff"),
      hunks: [],
    };
  }
  const patch = structuredPatch(origin.path, origin.path, before, current.text ?? "", "", "", { context: 3 });
  let added = 0;
  let removed = 0;
  for (const h of patch.hunks) {
    for (const l of h.lines) {
      if (l.startsWith("+")) added++;
      else if (l.startsWith("-")) removed++;
    }
  }
  return {
    ...base,
    added,
    removed,
    skipped: null,
    hunks: patch.hunks.map((h) => ({ oldStart: h.oldStart, newStart: h.newStart, lines: h.lines })),
  };
}

/** Changed files for a chat with +/- counts; null when the chat is unknown. */
export function listChatChanges(composerId: string, opts?: { home?: string }): ChatFileChange[] | null {
  const origins = readOrigins(composerId, opts?.home);
  if (!origins) return null;
  return origins.map((o, i) => {
    const { hunks: _hunks, ...summary } = diffFile(i, o, readCurrent(o.path));
    return summary;
  });
}

/** One file's diff by its index in {@link listChatChanges}; null when out of range. */
export function getChatFileDiff(
  composerId: string,
  index: number,
  opts?: { home?: string },
): ChatFileDiff | null {
  const origins = readOrigins(composerId, opts?.home);
  const origin = origins?.[index];
  if (!origin) return null;
  return diffFile(index, origin, readCurrent(origin.path));
}
