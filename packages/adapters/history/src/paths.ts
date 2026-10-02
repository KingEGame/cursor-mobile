/**
 * OS path strategies for local Cursor chat storage (TOR-07 §6).
 * Best-effort discovery only — never invent secrets or cloud catalogs.
 *
 * Classes (priority):
 * 1. Desktop globalStorage `state.vscdb` (composerHeaders + cursorDiskKV)
 * 2. Workspace storage `workspaceStorage/<hash>/workspace.json` (folder → hash)
 * 3. Agent CLI chats under `~/.cursor/chats/` or `~/.config/cursor/chats/`
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type StorageBackendKind =
  | "desktop_globalStorage"
  | "workspaceStorage"
  | "agent_cli_chats";

export interface StoragePathCandidate {
  kind: StorageBackendKind;
  path: string;
  present: boolean;
  osHint: string;
}

function homeDir(override?: string): string {
  return override || process.env.HOME || process.env.USERPROFILE || homedir();
}

/** Linux / macOS desktop Cursor user data roots. */
export function cursorUserDataRoots(home = homeDir()): string[] {
  const roots: string[] = [];
  // Linux (XDG)
  roots.push(join(home, ".config", "Cursor", "User"));
  // macOS
  roots.push(
    join(home, "Library", "Application Support", "Cursor", "User"),
  );
  // Windows (best-effort when HOME/USERPROFILE points at user dir)
  if (process.env.APPDATA) {
    roots.push(join(process.env.APPDATA, "Cursor", "User"));
  } else {
    roots.push(join(home, "AppData", "Roaming", "Cursor", "User"));
  }
  return roots;
}

export function resolveDesktopGlobalStorageDb(
  home = homeDir(),
): string | null {
  for (const root of cursorUserDataRoots(home)) {
    const db = join(root, "globalStorage", "state.vscdb");
    if (existsSync(db)) return db;
  }
  return null;
}

export function resolveWorkspaceStorageRoot(
  home = homeDir(),
): string | null {
  for (const root of cursorUserDataRoots(home)) {
    const dir = join(root, "workspaceStorage");
    if (existsSync(dir)) return dir;
  }
  return null;
}

/** Agent CLI chat roots (Linux-first; macOS may share ~/.cursor). */
export function resolveAgentCliChatsRoots(home = homeDir()): string[] {
  return [
    join(home, ".cursor", "chats"),
    join(home, ".config", "cursor", "chats"),
  ].filter((p) => existsSync(p));
}

/** Diagnostic inventory — used by health / handoff docs, not phone wire. */
export function listStoragePathCandidates(
  home = homeDir(),
): StoragePathCandidate[] {
  const desktop = resolveDesktopGlobalStorageDb(home);
  const workspace = resolveWorkspaceStorageRoot(home);
  const agentRoots = resolveAgentCliChatsRoots(home);

  const candidates: StoragePathCandidate[] = [
    {
      kind: "desktop_globalStorage",
      path:
        desktop ??
        join(
          home,
          ".config",
          "Cursor",
          "User",
          "globalStorage",
          "state.vscdb",
        ),
      present: desktop !== null,
      osHint:
        "Linux: ~/.config/Cursor/User/globalStorage/state.vscdb · macOS: ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb",
    },
    {
      kind: "workspaceStorage",
      path:
        workspace ??
        join(home, ".config", "Cursor", "User", "workspaceStorage"),
      present: workspace !== null,
      osHint:
        "…/Cursor/User/workspaceStorage/<hash>/workspace.json maps folder URI → storage hash",
    },
  ];

  if (agentRoots.length === 0) {
    candidates.push({
      kind: "agent_cli_chats",
      path: join(home, ".cursor", "chats"),
      present: false,
      osHint: "~/.cursor/chats/ or ~/.config/cursor/chats/ (cursor-agent CLI)",
    });
  } else {
    for (const path of agentRoots) {
      candidates.push({
        kind: "agent_cli_chats",
        path,
        present: true,
        osHint: "cursor-agent CLI session dirs with meta.json + store.db",
      });
    }
  }

  return candidates;
}
