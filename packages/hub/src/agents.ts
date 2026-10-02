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
  getChatFileDiff,
  listChatChanges,
  listRecentLocalProjects,
  type ChatFileChange,
  type ChatFileDiff,
  type AgentChatDetails,
  type AgentChatStatus,
  type AgentProjectGroup,
} from "@cursor-mobile/history";
import {
  AGENT_MODES,
  type AgentMode,
  type SidebarLiveState,
  type SidebarScrapeResult,
} from "@cursor-mobile/live-cursor";
import { ApiError } from "./errors.js";

export interface AgentsIndex {
  describe(composerIds: string[]): Map<string, AgentChatDetails>;
  recent(limit: number): AgentProjectGroup[];
  changes(composerId: string): ChatFileChange[] | null;
  fileDiff(composerId: string, index: number): ChatFileDiff | null;
}

export const defaultAgentsIndex: AgentsIndex = {
  describe: (ids) => describeAgentChats(ids),
  recent: (limit) => listRecentLocalProjects({ limit }),
  changes: (id) => listChatChanges(id),
  fileDiff: (id, index) => getChatFileDiff(id, index),
};

const COMPOSER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate a local Agents chat id from a URL param (rejects bc- cloud ids and junk). */
export function agentComposerId(raw: unknown): string {
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!COMPOSER_ID.test(id)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Not a local Cursor chat id");
  }
  return id.toLowerCase();
}

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
  /** Expanded in the PC sidebar (null when unknown / fallback). */
  expanded: boolean | null;
  chats: AgentsChatRow[];
}

export interface AgentsResponse {
  source: "sidebar" | "history";
  /** Why the sidebar was not used (fallback mode only). */
  note: string | null;
  scannedAt: string;
  projects: AgentsProjectRow[];
}

function liveStatus(live: SidebarLiveState | undefined): AgentChatStatus | null {
  if (live === undefined) return null;
  return live === "working" || live === "waiting_approval" || live === "error" ? live : "idle";
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
        expanded: sec.expanded,
        chats: sec.chats.map((c) => {
          const d = details.get(c.composerId);
          return {
            sessionId: `hist_${c.composerId}`,
            composerId: c.composerId,
            // The sidebar title is what the operator sees on the PC; DB name is backup.
            title: c.title || d?.title || `Chat ${c.composerId.slice(0, 8)}`,
            ageLabel: c.ageLabel || null,
            updatedAt: d?.updatedAt ?? null,
            // Sidebar live state wins: Cursor's DB reads `aborted` for the whole run and only
            // settles when the run ends.
            status: liveStatus(c.live) ?? d?.status ?? "idle",
            unread: c.live === "unread" || (d?.unread ?? false),
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
      expanded: null,
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

/** Validate optional composer settings from a phone request body. */
export function composerOptionsFromBody(body: unknown): {
  mode?: AgentMode;
  model?: string;
  mentions?: Array<{ trigger: "@" | "/"; label: string; detail?: string }>;
  images?: Array<{ name: string; mime: "image/jpeg" | "image/png" | "image/webp"; base64: string }>;
} {
  const b = (body ?? {}) as { mode?: unknown; model?: unknown; mentions?: unknown; images?: unknown };
  const out: ReturnType<typeof composerOptionsFromBody> = {};
  if (b.mentions !== undefined && b.mentions !== null) {
    if (!Array.isArray(b.mentions) || b.mentions.length > 10) {
      throw new ApiError(400, "VALIDATION_ERROR", "mentions must be an array of up to 10 items");
    }
    out.mentions = b.mentions.map((m) => {
      const r = (m ?? {}) as { trigger?: unknown; label?: unknown; detail?: unknown };
      if ((r.trigger !== "@" && r.trigger !== "/") || typeof r.label !== "string" || !r.label.trim() || r.label.length > 200) {
        throw new ApiError(400, "VALIDATION_ERROR", "each mention needs trigger '@' or '/' and a label");
      }
      return {
        trigger: r.trigger,
        label: r.label.trim(),
        ...(typeof r.detail === "string" && r.detail.trim() ? { detail: r.detail.trim().slice(0, 300) } : {}),
      };
    });
  }
  if (b.images !== undefined && b.images !== null) {
    if (!Array.isArray(b.images) || b.images.length > 4) {
      throw new ApiError(400, "VALIDATION_ERROR", "images must be an array of up to 4 photos");
    }
    out.images = b.images.map((im, i) => {
      const r = (im ?? {}) as { name?: unknown; mime?: unknown; base64?: unknown };
      const mime = r.mime;
      if (mime !== "image/jpeg" && mime !== "image/png" && mime !== "image/webp") {
        throw new ApiError(400, "VALIDATION_ERROR", "image mime must be jpeg, png or webp");
      }
      if (typeof r.base64 !== "string" || !r.base64 || r.base64.length > 8_000_000 || !/^[A-Za-z0-9+/=\s]+$/.test(r.base64)) {
        throw new ApiError(400, "VALIDATION_ERROR", "image base64 is missing, invalid, or larger than ~6 MB");
      }
      const name = typeof r.name === "string" && /^[\w.\- ]{1,80}$/.test(r.name) ? r.name : `phone-photo-${i + 1}.${mime.split("/")[1]}`;
      return { name, mime, base64: r.base64.replace(/\s+/g, "") };
    });
  }
  if (b.mode !== undefined && b.mode !== null && b.mode !== "") {
    if (typeof b.mode !== "string" || !(AGENT_MODES as readonly string[]).includes(b.mode)) {
      throw new ApiError(400, "VALIDATION_ERROR", `mode must be one of ${AGENT_MODES.join(", ")}`);
    }
    out.mode = b.mode as AgentMode;
  }
  if (b.model !== undefined && b.model !== null && b.model !== "") {
    if (typeof b.model !== "string" || b.model.length > 80) {
      throw new ApiError(400, "VALIDATION_ERROR", "model must be a model name from GET /v1/workspace/models");
    }
    out.model = b.model.trim();
  }
  return out;
}
