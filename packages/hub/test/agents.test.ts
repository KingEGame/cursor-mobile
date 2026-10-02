/**
 * GET /v1/agents merge — sidebar order + DB details, and honest history fallback.
 */
import { describe, expect, it } from "vitest";
import type { AgentChatDetails } from "@cursor-mobile/history";
import { agentComposerId, buildAgentsResponse, type AgentsIndex } from "../src/agents.js";

const NOW = new Date("2026-10-01T21:00:00.000Z");
const ID = "466762d6-04ca-46e6-a047-4ad7932ae829";

const detail: AgentChatDetails = {
  composerId: ID,
  sessionId: `hist_${ID}`,
  title: "DB name",
  status: "waiting_approval",
  unread: true,
  linesAdded: 12,
  linesRemoved: 3,
  mode: "agent",
  createdAt: "2026-09-24T19:02:55.000Z",
  updatedAt: "2026-09-24T19:47:48.000Z",
  projectId: "185f",
  projectPath: "/data/projects/omnitouter",
};

const index: AgentsIndex = {
  describe: (ids) => new Map(ids.filter((i) => i === ID).map((i) => [i, detail])),
  recent: () => [{ projectId: "185f", name: "omnitouter", path: "/data/projects/omnitouter", chats: [detail] }],
  changes: () => [],
  fileDiff: () => null,
};

describe("buildAgentsResponse", () => {
  it("keeps sidebar order and titles, enriched with DB status", () => {
    const res = buildAgentsResponse(
      {
        ok: true,
        sections: [
          {
            sectionId: "workspace:185f",
            name: "omnitouter",
            expanded: true,
            hasMore: true,
            chats: [{ composerId: ID, title: "Sidebar title", ageLabel: "7d", active: true }],
          },
          { sectionId: "workspace:home", name: "No Repo", expanded: true, hasMore: false, chats: [] },
        ],
      },
      index,
      NOW,
    );
    expect(res.source).toBe("sidebar");
    // Empty sections (only bc- cloud rows on the PC) are dropped.
    expect(res.projects.map((p) => p.name)).toEqual(["omnitouter"]);
    expect(res.projects[0]).toMatchObject({ path: "/data/projects/omnitouter", hasMore: true });
    expect(res.projects[0]!.chats[0]).toEqual({
      sessionId: `hist_${ID}`,
      composerId: ID,
      title: "Sidebar title",
      ageLabel: "7d",
      updatedAt: detail.updatedAt,
      status: "waiting_approval",
      unread: true,
      linesAdded: 12,
      linesRemoved: 3,
      activeOnPc: true,
    });
  });

  it("shows a sidebar chat even when the DB has no row for it", () => {
    const other = "11111111-2222-3333-4444-555555555555";
    const res = buildAgentsResponse(
      {
        ok: true,
        sections: [
          {
            sectionId: "workspace:x",
            name: "x",
            expanded: true,
            hasMore: false,
            chats: [{ composerId: other, title: "", ageLabel: "1h", active: false }],
          },
        ],
      },
      index,
      NOW,
    );
    expect(res.projects[0]!.chats[0]).toMatchObject({ title: "Chat 11111111", status: "idle" });
  });

  it("falls back to local history and says why when the sidebar is unreadable", () => {
    const res = buildAgentsResponse({ ok: false, error: "Cursor down" }, index, NOW);
    expect(res).toMatchObject({ source: "history", note: "Cursor down" });
    expect(res.projects[0]!.chats[0]).toMatchObject({ title: "DB name", ageLabel: null, activeOnPc: false });
  });
});

describe("POST /v1/agents/chats/:id/messages", () => {
  it("is covered via the mock adapter contract", async () => {
    const { createMockLiveCursorAdapter } = await import("@cursor-mobile/live-cursor");
    const live = createMockLiveCursorAdapter({
      healthState: "cdp_ok",
      sidebarSections: [
        {
          sectionId: "workspace:185f",
          name: "omnitouter",
          expanded: true,
          hasMore: false,
          chats: [{ composerId: ID, title: "t", ageLabel: "1m", active: false }],
        },
      ],
    });
    expect((await live.sendToAgentChat(ID, "hi")).ok).toBe(true);
    expect(await live.sendToAgentChat("11111111-2222-3333-4444-555555555555", "hi")).toMatchObject({
      ok: false,
      code: "CHAT_NOT_IN_SIDEBAR",
    });
  });
});

describe("agentComposerId", () => {
  it("accepts local chat ids and rejects cloud or malformed ones", () => {
    expect(agentComposerId(ID.toUpperCase())).toBe(ID);
    expect(() => agentComposerId("bc-64eb9b50-740d-48ba-9863-9cef302ce9b1")).toThrow(/local Cursor chat/);
    expect(() => agentComposerId("../../etc/passwd")).toThrow();
  });
});
