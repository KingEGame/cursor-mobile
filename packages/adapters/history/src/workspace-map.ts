/**
 * Map bound workspace folder path → Cursor workspaceStorage hash(es).
 * Reads workspace.json only (folder URI) — no proprietary secrets.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveWorkspaceStorageRoot } from "./paths.js";

export interface WorkspaceHashMatch {
  hash: string;
  folderUri: string;
}

function normalizeFsPath(p: string): string {
  // Resolve symlinks loosely: strip trailing slash, lowercase drive on win
  let s = p.replace(/\\/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/** Resolve symlinks (e.g. `/data` → `/mnt/data`) so both spellings of a folder match. */
function canonicalPath(p: string): string {
  const s = normalizeFsPath(p);
  try {
    return normalizeFsPath(realpathSync(s));
  } catch {
    return s;
  }
}

function folderUrisForPath(workspacePath: string): string[] {
  const abs = normalizeFsPath(workspacePath);
  const fileUri = pathToFileURL(abs).href;
  // Cursor sometimes stores without encoding differences — keep both forms
  return [fileUri, `file://${abs}`, `file://${abs}/`];
}

/**
 * Scan workspaceStorage hash dirs for workspace.json folder matching workspacePath.
 */
export function findWorkspaceStorageHashes(
  workspacePath: string,
  workspaceStorageRoot?: string | null,
): WorkspaceHashMatch[] {
  const root = workspaceStorageRoot ?? resolveWorkspaceStorageRoot();
  if (!root || !existsSync(root)) return [];

  const wanted = new Set(
    folderUrisForPath(workspacePath).map((u) => normalizeFsPath(u)),
  );
  const wantedPath = normalizeFsPath(workspacePath);
  const wantedCanonical = canonicalPath(workspacePath);
  const matches: WorkspaceHashMatch[] = [];

  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  for (const hash of entries) {
    const metaPath = join(root, hash, "workspace.json");
    if (!existsSync(metaPath)) continue;
    try {
      const raw = readFileSync(metaPath, "utf8");
      const json = JSON.parse(raw) as { folder?: string; workspace?: string };
      const folderUri = json.folder || json.workspace;
      if (!folderUri || typeof folderUri !== "string") continue;
      const normalizedUri = normalizeFsPath(folderUri);
      const pathFromUri = normalizedUri.replace(/^file:\/\//, "");
      let decodedPath = pathFromUri;
      try {
        decodedPath = decodeURIComponent(pathFromUri);
      } catch {
        /* keep raw */
      }
      if (
        wanted.has(normalizedUri) ||
        normalizeFsPath(pathFromUri) === wantedPath ||
        canonicalPath(decodedPath) === wantedCanonical
      ) {
        matches.push({ hash, folderUri });
      }
    } catch {
      // skip corrupt / unreadable
    }
  }

  return matches;
}

/** Stable Hub workspace id from path (mirrors Hub hashPathToWorkspaceId). */
export function workspaceIdFromPath(workspacePath: string): string {
  const digest = createHash("sha256")
    .update(normalizeFsPath(workspacePath))
    .digest("hex")
    .slice(0, 12);
  return `ws_${digest}`;
}
