/**
 * GET /v1/agents — the Cursor Agents-window list (projects → chats) for the phone.
 *
 * Source of truth for which chats exist and their order: the PC sidebar (read-only CDP
 * scrape). Status / unread / lines changed come from Cursor's local DB by composer id.
 * When the sidebar can't be read (Cursor closed, DOM changed) we fall back to recent
 * local chats from the DB and say so — never invent rows.
 */

import {
  describeAgentChats,
  listRecentLocalProjects,
  type AgentChatDetails,
  type AgentChatStatus,
  type AgentProjectGroup,
} from "@cursor-mobile/history";
import type { SidebarScrapeResult } from "@cursor-mobile/live-cursor";

export interface AgentsIndex {
  describe(composerIds: string[]): Map<string, AgentChatDetails>;
  recent(limit: number): AgentProjectGroup[];
}

export const defaultAgentsIndex: AgentsIndex = {
  describe: (ids) => describeAgentChats(ids),
  recent: (limit) => listRecentLocalProjects({ limit }),
};

export interface AgentsChatRow {
  /** Hub session id; `GET /v1/sessions/:id` returns the transcript. */
  sessionId: string;
  composerId: string;
  title: string;
  /** Sidebar age label as shown on the PC ("42m", "7d"); null in fallback mode. */
  ageLabel: string | null;
  updatedAt: string | null;
  status: AgentChatStatus;
  unread: boolean;
  linesAdded: number;
  linesRemoved: number;
  /** Selected in the PC sidebar right now. */
  activeOnPc: boolean;
}

export interface AgentsProjectRow {
  projectId: string;
  name: string;
  path: string | null;
  hasMore: boolean;
  chats: AgentsChatRow[];
}

export interface AgentsResponse {
  source: "sidebar" | "history";
  /** Why the sidebar was not used (fallback mode only). */
  note: string | null;
  scannedAt: string;
  projects: AgentsProjectRow[];
}

export function buildAgentsResponse(
  sidebar: SidebarScrapeResult,
  index: AgentsIndex,
  now: Date = new Date(),
): AgentsResponse {
  if (sidebar.ok) {
    const ids = sidebar.sections.flatMap((s) => s.chats.map((c) => c.composerId));
    const details = index.describe(ids);
    return {
      source: "sidebar",
      note: null,
      scannedAt: now.toISOString(),
      // Sections whose rows are all non-local (e.g. `bc-` background/cloud agents, which
      // the product locks out) would render as empty projects — drop them.
      projects: sidebar.sections.filter((sec) => sec.chats.length > 0).map((sec) => ({
        projectId: sec.sectionId,
        name: sec.name,
        path:
          sec.chats.map((c) => details.get(c.composerId)?.projectPath).find(Boolean) ??
          null,
        hasMore: sec.hasMore,
        chats: sec.chats.map((c) => {
          const d = details.get(c.composerId);
          return {
            sessionId: `hist_${c.composerId}`,
            composerId: c.composerId,
            // The sidebar title is what the operator sees on the PC; DB name is backup.
            title: c.title || d?.title || `Chat ${c.composerId.slice(0, 8)}`,
            ageLabel: c.ageLabel || null,
            updatedAt: d?.updatedAt ?? null,
            status: d?.status ?? "idle",
            unread: d?.unread ?? false,
            linesAdded: d?.linesAdded ?? 0,
            linesRemoved: d?.linesRemoved ?? 0,
            activeOnPc: c.active,
          };
        }),
      })),
    };
  }

  return {
    source: "history",
    note: sidebar.error,
    scannedAt: now.toISOString(),
    projects: index.recent(40).map((g) => ({
      projectId: g.projectId,
      name: g.name,
      path: g.path,
      hasMore: false,
      chats: g.chats.map((d) => ({
        sessionId: d.sessionId,
        composerId: d.composerId,
        title: d.title,
        ageLabel: null,
        updatedAt: d.updatedAt,
        status: d.status,
        unread: d.unread,
        linesAdded: d.linesAdded,
        linesRemoved: d.linesRemoved,
        activeOnPc: false,
      })),
    })),
  };
}
