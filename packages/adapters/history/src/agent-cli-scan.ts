/**
 * Best-effort cursor-agent CLI chat scan (~/.cursor/chats).
 * Uses meta.json only for list; store.db blobs are optional / best-effort.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { resolveAgentCliChatsRoots } from "./paths.js";
import type {
  HistoryMessage,
  HistorySessionSummary,
} from "./types.js";

interface AgentMeta {
  schemaVersion?: number;
  title?: string;
  cwd?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  hasConversation?: boolean;
}

function fingerprint(nativeKey: string): string {
  return (
    "sha256:" +
    createHash("sha256").update(nativeKey).digest("hex").slice(0, 16)
  );
}

function normalizePath(p: string): string {
  let s = p.replace(/\\/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

function hubSessionId(nativeId: string): string {
  return `hist_cli_${nativeId}`;
}

export function parseCliSessionId(sessionId: string): string | null {
  if (!sessionId.startsWith("hist_cli_")) return null;
  const id = sessionId.slice("hist_cli_".length);
  return id.length > 0 ? id : null;
}

function msToIso(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return new Date(0).toISOString();
  return new Date(ms).toISOString();
}

export type AgentCliListScanMeta = {
  /** Total matching CLI sessions for bind (ignores page `limit`). */
  totalMatched?: number;
};

export function listAgentCliSessions(opts: {
  hubWorkspaceId: string;
  workspacePath?: string | null;
  limit: number;
  home?: string;
  meta?: AgentCliListScanMeta;
}): HistorySessionSummary[] {
  const roots = resolveAgentCliChatsRoots(opts.home);
  if (roots.length === 0 || !opts.workspacePath) return [];

  const wanted = normalizePath(opts.workspacePath);
  const out: HistorySessionSummary[] = [];

  for (const root of roots) {
    let groupDirs: string[] = [];
    try {
      groupDirs = readdirSync(root);
    } catch {
      continue;
    }
    for (const group of groupDirs) {
      const groupPath = join(root, group);
      let sessionDirs: string[] = [];
      try {
        if (!statSync(groupPath).isDirectory()) continue;
        sessionDirs = readdirSync(groupPath);
      } catch {
        continue;
      }
      for (const sid of sessionDirs) {
        const metaPath = join(groupPath, sid, "meta.json");
        if (!existsSync(metaPath)) continue;
        try {
          const meta = JSON.parse(
            readFileSync(metaPath, "utf8"),
          ) as AgentMeta;
          if (!meta.cwd || normalizePath(meta.cwd) !== wanted) continue;
          const nativeKey = `${group}/${sid}`;
          const fp = fingerprint(nativeKey);
          out.push({
            sessionId: hubSessionId(sid),
            workspaceId: opts.hubWorkspaceId,
            title: meta.title || `CLI ${sid.slice(0, 8)}`,
            preview: meta.cwd,
            model: null,
            updatedAt: msToIso(meta.updatedAtMs ?? meta.createdAtMs),
            createdAt: msToIso(meta.createdAtMs),
            mode: "history",
            nativeKeyFingerprint: fp,
            backend: "agent_cli_chats",
            correlationKey: `ck_${fp.slice("sha256:".length)}`,
            // stash path for message load via sessionId map — use sid only
          });
        } catch {
          /* skip */
        }
      }
    }
  }

  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (opts.meta) {
    opts.meta.totalMatched = out.length;
  }
  return out.slice(0, opts.limit);
}

/**
 * CLI store.db message extract is best-effort and often opaque blobs.
 * Return empty messages with summary from meta when found.
 */
export function loadAgentCliSession(
  sessionId: string,
  opts?: { home?: string },
): {
  summary: HistorySessionSummary | null;
  messages: HistoryMessage[];
  truncated: boolean;
} {
  const sid = parseCliSessionId(sessionId);
  if (!sid) return { summary: null, messages: [], truncated: false };

  const roots = resolveAgentCliChatsRoots(opts?.home);
  for (const root of roots) {
    let groupDirs: string[] = [];
    try {
      groupDirs = readdirSync(root);
    } catch {
      continue;
    }
    for (const group of groupDirs) {
      const metaPath = join(root, group, sid, "meta.json");
      if (!existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf8")) as AgentMeta;
        const nativeKey = `${group}/${sid}`;
        const fp = fingerprint(nativeKey);
        const summary: HistorySessionSummary = {
          sessionId: hubSessionId(sid),
          workspaceId: "",
          title: meta.title || `CLI ${sid.slice(0, 8)}`,
          preview: meta.cwd ?? null,
          model: null,
          updatedAt: msToIso(meta.updatedAtMs ?? meta.createdAtMs),
          createdAt: msToIso(meta.createdAtMs),
          mode: "history",
          nativeKeyFingerprint: fp,
          backend: "agent_cli_chats",
          correlationKey: `ck_${fp.slice("sha256:".length)}`,
        };
        // Prompt history is optional and may be empty — no invented messages.
        const promptPath = join(root, group, sid, "prompt_history.json");
        const messages: HistoryMessage[] = [];
        if (existsSync(promptPath)) {
          try {
            const raw = JSON.parse(readFileSync(promptPath, "utf8")) as unknown;
            if (Array.isArray(raw)) {
              raw.forEach((entry, i) => {
                const text =
                  typeof entry === "string"
                    ? entry
                    : entry &&
                        typeof entry === "object" &&
                        "text" in entry &&
                        typeof (entry as { text: unknown }).text === "string"
                      ? (entry as { text: string }).text
                      : null;
                if (text && text.trim()) {
                  messages.push({
                    messageId: `m_cli_${sid}_${i}`,
                    role: "user",
                    content: text,
                    createdAt: summary.createdAt,
                  });
                }
              });
            }
          } catch {
            /* ignore */
          }
        }
        return { summary, messages, truncated: false };
      } catch {
        continue;
      }
    }
  }
  return { summary: null, messages: [], truncated: false };
}
