/**
 * Read-only scrape of the Cursor Agents-window sidebar (projects → chats).
 *
 * One `Runtime.evaluate` over loopback CDP; no clicks, no input. The sidebar is the
 * source of truth for *which* chats the operator sees and in what order; details and
 * transcripts come from the History Index (local DB) by composer id.
 *
 * Observed DOM (Cursor Agents window, 2026-10-01):
 *   section[data-agent-drop-section-id="workspace:<hash>" | "repo:<remote>" | "workspace:home"]
 *     [data-section-head] .ui-sidebar-label-row-title   → project name
 *     li[data-sidebar-item-key="row:<composerId>"]       → chat
 *       .ui-sidebar-menu-button-content                   → title
 *       .ui-sidebar-menu-button-end-rest                  → age label ("42m", "7d")
 */

import type { CdpClient } from "./cdp-client.js";

export interface SidebarChat {
  composerId: string;
  title: string;
  ageLabel: string;
  /** Currently selected in the PC sidebar. */
  active: boolean;
  /**
   * Live state from the sidebar status icon (the local DB only settles after a run ends —
   * it reads `aborted` for the whole run). Absent on older snapshots.
   */
  live?: SidebarLiveState;
}

export type SidebarLiveState = "working" | "waiting_approval" | "error" | "unread" | "idle";

/** Map the row's status icon to a live state. Unknown labels fall back to idle. */
export function sidebarLiveState(running: unknown, label: unknown, variant: unknown): SidebarLiveState {
  if (running === true) return "working";
  const text = `${typeof label === "string" ? label : ""} ${typeof variant === "string" ? variant : ""}`.toLowerCase();
  if (/approv|waiting|needs.?input|blocked/.test(text)) return "waiting_approval";
  if (/error|fail|abort|stopped/.test(text)) return "error";
  if (/unseen|unread/.test(text)) return "unread";
  return "idle";
}

export interface SidebarSection {
  /** Raw section id, e.g. `workspace:185f…`, `repo:github.com/…`, `workspace:home`. */
  sectionId: string;
  name: string;
  expanded: boolean | null;
  /** Sidebar shows a "More" row — PC has older chats not listed. */
  hasMore: boolean;
  chats: SidebarChat[];
}

/**
 * A notice tray above the Agents composer (e.g. "Agent Execution Timed Out" with
 * "Reload Window"). When one is an error, sends from the phone / Claude will not run.
 */
export interface CursorAlert {
  title: string;
  message: string;
  /** Button labels offered in the tray ("Reload Window", "Copy ID"…). */
  actions: string[];
  error: boolean;
  /** Cursor's agent runtime (extension host) is stuck — only Reload Window on the PC fixes it. */
  needsReload: boolean;
}

export type SidebarScrapeResult =
  | { ok: true; sections: SidebarSection[]; alerts?: CursorAlert[] }
  | { ok: false; error: string };

export const SIDEBAR_SCRAPE_EXPRESSION = `(() => {
  const text = (el) => (el ? el.textContent.replace(/\\s+/g, " ").trim() : "");
  const sections = [...document.querySelectorAll("section[data-agent-drop-section-id]")];
  // Visible notice trays above the composer ("Agent Execution Timed Out" + "Reload Window").
  const alerts = [...document.querySelectorAll('.ui-prompt-input-header-tray__tray[data-visible="true"]')]
    .filter((t) => t.getAttribute("aria-hidden") !== "true")
    .map((t) => ({
      lines: [...t.querySelectorAll(".ui-text")].map(text).filter(Boolean),
      actions: [...t.querySelectorAll("button")]
        .map((b) => (b.getAttribute("aria-label") || b.textContent || "").replace(/\\s+/g, " ").trim())
        .filter(Boolean),
    }));
  const list = sections.map((sec) => {
    const head = sec.querySelector("[data-section-head]");
    const chats = [...sec.querySelectorAll('li[data-sidebar-item-key^="row:"]')].map((li) => {
      const btn = li.querySelector("[data-sidebar-menu-button]");
      return {
        composerId: (li.getAttribute("data-sidebar-item-key") || "").slice(4),
        title: text(li.querySelector(".ui-sidebar-menu-button-content")),
        ageLabel: text(li.querySelector(".ui-sidebar-menu-button-end-rest")),
        active: !!btn && (btn.getAttribute("data-active") === "true"
          || btn.getAttribute("aria-current") === "page"
          || btn.getAttribute("aria-selected") === "true"),
        // Live run state from the row's status icon: an animated loader while the agent
        // runs, otherwise a labelled dot (aria-label "Completed", data-variant "done-seen"…).
        running: !!li.querySelector(".ui-sidebar-menu-button-status-icon .ui-dot-grid-loader"),
        statusLabel: (li.querySelector(".ui-sidebar-menu-button-status-icon [role=img]") || {}).getAttribute
          ? li.querySelector(".ui-sidebar-menu-button-status-icon [role=img]").getAttribute("aria-label") || ""
          : "",
        statusVariant: (li.querySelector(".ui-sidebar-menu-button-status-icon [data-variant]") || {}).getAttribute
          ? li.querySelector(".ui-sidebar-menu-button-status-icon [data-variant]").getAttribute("data-variant") || ""
          : "",
      };
    });
    const hasMore = [...sec.querySelectorAll("li, [role=button]")]
      .some((el) => el.children.length <= 3 && /^More$/.test(text(el)));
    return {
      sectionId: sec.getAttribute("data-agent-drop-section-id") || "",
      name: text(head && head.querySelector(".ui-sidebar-label-row-title")),
      expanded: head ? head.getAttribute("aria-expanded") === "true" : null,
      hasMore,
      chats,
    };
  });
  return { sections: list, alerts };
})()`;

const ERROR_TEXT = /timed out|error|failed|did not respond|unavailable|unresponsive|crash/i;

export function parseCursorAlerts(value: unknown): CursorAlert[] {
  if (!Array.isArray(value)) return [];
  const out: CursorAlert[] = [];
  for (const raw of value as Array<Record<string, unknown>>) {
    const lines = Array.isArray(raw?.lines) ? raw.lines.filter((l): l is string => typeof l === "string" && !!l.trim()) : [];
    const actions = Array.isArray(raw?.actions)
      ? raw.actions.filter((a): a is string => typeof a === "string" && !!a.trim()).slice(0, 6)
      : [];
    if (lines.length === 0) continue;
    const title = lines[0]!.slice(0, 200);
    const message = lines.slice(1).join(" ").slice(0, 600);
    const all = `${title} ${message}`;
    const needsReload = actions.some((a) => /reload window/i.test(a)) || /extension host/i.test(all);
    const error = needsReload || actions.some((a) => /dismiss error/i.test(a)) || ERROR_TEXT.test(all);
    out.push({ title, message, actions, error, needsReload });
  }
  return out;
}

const COMPOSER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate the page's return value. Fail closed: anything off-shape (Cursor changed
 * its DOM) is an error, never a partial guess.
 */
export function parseSidebarSnapshot(snapshot: unknown): SidebarScrapeResult {
  // Current shape: { sections, alerts }; older snapshots were the bare section list.
  const wrapped = !!snapshot && typeof snapshot === "object" && !Array.isArray(snapshot);
  const value = wrapped ? (snapshot as { sections?: unknown }).sections : snapshot;
  const alerts = wrapped ? parseCursorAlerts((snapshot as { alerts?: unknown }).alerts) : [];
  if (!Array.isArray(value)) {
    return { ok: false, error: "Sidebar scrape returned no section list" };
  }
  if (value.length === 0) {
    return {
      ok: false,
      error: "No Agents sidebar sections found — is the Cursor Agents window open?",
    };
  }
  const sections: SidebarSection[] = [];
  for (const raw of value) {
    const s = raw as Record<string, unknown>;
    if (typeof s.sectionId !== "string" || !s.sectionId || !Array.isArray(s.chats)) {
      return { ok: false, error: "Sidebar section shape changed (missing id or chats)" };
    }
    const chats: SidebarChat[] = [];
    for (const c of s.chats as Array<Record<string, unknown>>) {
      const id = typeof c.composerId === "string" ? c.composerId : "";
      if (!COMPOSER_ID.test(id)) continue; // skip non-chat rows defensively
      chats.push({
        composerId: id.toLowerCase(),
        title: typeof c.title === "string" ? c.title : "",
        ageLabel: typeof c.ageLabel === "string" ? c.ageLabel : "",
        active: c.active === true,
        live: sidebarLiveState(c.running, c.statusLabel, c.statusVariant),
      });
    }
    sections.push({
      sectionId: s.sectionId,
      name: typeof s.name === "string" && s.name ? s.name : s.sectionId,
      expanded: typeof s.expanded === "boolean" ? s.expanded : null,
      hasMore: s.hasMore === true,
      chats,
    });
  }
  return { ok: true, sections, alerts };
}

export async function scrapeAgentsSidebar(client: CdpClient): Promise<SidebarScrapeResult> {
  try {
    const res = await client.send<{
      result?: { value?: unknown };
      exceptionDetails?: { text?: string };
    }>("Runtime.evaluate", {
      expression: SIDEBAR_SCRAPE_EXPRESSION,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      return {
        ok: false,
        error: `Sidebar scrape threw: ${res.exceptionDetails.text ?? "unknown"}`,
      };
    }
    return parseSidebarSnapshot(res.result?.value);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Sidebar scrape failed",
    };
  }
}
