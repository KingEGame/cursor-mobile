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

export type SidebarScrapeResult =
  | { ok: true; sections: SidebarSection[] }
  | { ok: false; error: string };

export const SIDEBAR_SCRAPE_EXPRESSION = `(() => {
  const text = (el) => (el ? el.textContent.replace(/\\s+/g, " ").trim() : "");
  const sections = [...document.querySelectorAll("section[data-agent-drop-section-id]")];
  return sections.map((sec) => {
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
})()`;

const COMPOSER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate the page's return value. Fail closed: anything off-shape (Cursor changed
 * its DOM) is an error, never a partial guess.
 */
export function parseSidebarSnapshot(value: unknown): SidebarScrapeResult {
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
  return { ok: true, sections };
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
