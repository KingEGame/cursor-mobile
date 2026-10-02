/**
 * Agents sidebar scrape — parser is fail-closed on DOM drift (no live Cursor required).
 */
import { describe, expect, it } from "vitest";
import { createMockCdpClient } from "./cdp-client.js";
import { parseSidebarSnapshot, scrapeAgentsSidebar } from "./sidebar-scrape.js";

const CHAT_A = "466762d6-04ca-46e6-a047-4ad7932ae829";
const CHAT_B = "5197bfb7-05a0-460d-9c89-6b2b0fd2f4c9";

const snapshot = [
  {
    sectionId: "workspace:185f5275652640487261e9e70e346aad",
    name: "omnitouter",
    expanded: false,
    hasMore: false,
    chats: [{ composerId: CHAT_A, title: "Omnitouter and Laya project", ageLabel: "7d", active: false }],
  },
  {
    sectionId: "workspace:home",
    name: "No Repo",
    expanded: true,
    hasMore: true,
    chats: [
      // Background (cloud) agent rows are not local composers — dropped.
      { composerId: "bc-64eb9b50-740d-48ba-9863-9cef302ce9b1", title: "UAT probe", ageLabel: "2d", active: false },
      { composerId: CHAT_B.toUpperCase(), title: "Local chat", ageLabel: "2d", active: true },
    ],
  },
];

describe("parseSidebarSnapshot", () => {
  it("keeps section order, titles, ages and the active row", () => {
    const res = parseSidebarSnapshot(snapshot);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sections.map((s) => s.name)).toEqual(["omnitouter", "No Repo"]);
    expect(res.sections[0]!.chats[0]).toEqual({
      composerId: CHAT_A,
      title: "Omnitouter and Laya project",
      ageLabel: "7d",
      active: false,
    });
    expect(res.sections[1]!.hasMore).toBe(true);
  });

  it("drops non-composer rows such as bc- background agents and lowercases ids", () => {
    const res = parseSidebarSnapshot(snapshot);
    if (!res.ok) throw new Error(res.error);
    expect(res.sections[1]!.chats).toEqual([
      { composerId: CHAT_B, title: "Local chat", ageLabel: "2d", active: true },
    ]);
  });

  it("fails closed when the Agents window is not open or the shape changed", () => {
    expect(parseSidebarSnapshot([]).ok).toBe(false);
    expect(parseSidebarSnapshot(null).ok).toBe(false);
    expect(parseSidebarSnapshot([{ name: "x" }]).ok).toBe(false);
  });
});

describe("scrapeAgentsSidebar", () => {
  it("runs one read-only Runtime.evaluate and parses the value", async () => {
    const client = createMockCdpClient({
      "Runtime.evaluate": () => ({ result: { value: snapshot } }),
    });
    const res = await scrapeAgentsSidebar(client);
    expect(res.ok).toBe(true);
    expect(client.calls.map((c) => c.method)).toEqual(["Runtime.evaluate"]);
  });

  it("reports page exceptions instead of guessing", async () => {
    const client = createMockCdpClient({
      "Runtime.evaluate": () => ({ exceptionDetails: { text: "boom" } }),
    });
    const res = await scrapeAgentsSidebar(client);
    expect(res).toEqual({ ok: false, error: "Sidebar scrape threw: boom" });
  });
});
