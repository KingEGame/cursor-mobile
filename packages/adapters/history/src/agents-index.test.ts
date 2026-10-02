/**
 * Agents index — status mapping, grouping, and transcript tool-run collapsing.
 */
import { describe, expect, it } from "vitest";
import { deriveChatStatus, groupChatsByProject, rowToChatDetails } from "./agents-index.js";
import { collapseToolRuns, desktopScanInternals } from "./desktop-scan.js";
import type { HistoryMessage } from "./types.js";

function header(value: Record<string, unknown>, extra: Partial<{ dataStatus: string; generating: number }> = {}) {
  return {
    composerId: "466762d6-04ca-46e6-a047-4ad7932ae829",
    workspaceId: "185f5275652640487261e9e70e346aad",
    createdAt: 1_790_276_575_744,
    lastUpdatedAt: 1_790_279_135_594,
    value: JSON.stringify(value),
    dataStatus: extra.dataStatus ?? null,
    generating: extra.generating ?? null,
  };
}

describe("deriveChatStatus", () => {
  it("prefers waiting-for-approval over working over error", () => {
    expect(deriveChatStatus({ hasBlockingPendingActions: true, generating: 2 })).toBe("waiting_approval");
    expect(deriveChatStatus({ generating: 1 })).toBe("working");
    expect(deriveChatStatus({ dataStatus: "generating" })).toBe("working");
    expect(deriveChatStatus({ dataStatus: "error" })).toBe("error");
    expect(deriveChatStatus({ dataStatus: "completed" })).toBe("idle");
    // Stale flag on a finished chat is not a real approval wait.
    expect(deriveChatStatus({ hasBlockingPendingActions: true, dataStatus: "completed" })).toBe("idle");
  });
});

describe("rowToChatDetails", () => {
  it("maps Cursor header fields to the phone row", () => {
    const d = rowToChatDetails(
      header({
        name: "Omnitouter and Laya project",
        hasUnreadMessages: true,
        totalLinesAdded: 620,
        totalLinesRemoved: 72,
        unifiedMode: "agent",
        workspaceIdentifier: {
          id: "185f5275652640487261e9e70e346aad",
          uri: { fsPath: "/data/projects/omnitouter" },
        },
      }),
    );
    expect(d).toMatchObject({
      sessionId: "hist_466762d6-04ca-46e6-a047-4ad7932ae829",
      title: "Omnitouter and Laya project",
      status: "idle",
      unread: true,
      linesAdded: 620,
      linesRemoved: 72,
      projectId: "185f5275652640487261e9e70e346aad",
      projectPath: "/data/projects/omnitouter",
    });
  });

  it("survives a corrupt header value without inventing a title", () => {
    const row = { ...header({}), value: "{not json" };
    expect(rowToChatDetails(row).title).toBe("Chat 466762d6");
  });
});

describe("groupChatsByProject", () => {
  it("groups by project id and names the group after the folder", () => {
    const a = rowToChatDetails(header({ workspaceIdentifier: { id: "p1", uri: { fsPath: "/x/alpha" } } }));
    const b = { ...a, composerId: "b", sessionId: "hist_b" };
    const groups = groupChatsByProject([a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ projectId: "p1", name: "alpha", path: "/x/alpha" });
    expect(groups[0]!.chats).toHaveLength(2);
  });
});

describe("collapseToolRuns", () => {
  const msg = (role: HistoryMessage["role"], content: string, i: number): HistoryMessage => ({
    messageId: `m_${i}`,
    role,
    content,
    createdAt: `2026-09-24T19:0${i}:00.000Z`,
  });

  it("merges consecutive tool steps and keeps text messages in order", () => {
    const out = collapseToolRuns([
      msg("user", "clone omnitouter", 0),
      msg("tool", "Used read_file", 1),
      msg("tool", "Used grep", 2),
      msg("tool", "Used read_file", 3),
      msg("assistant", "Cloned.", 4),
      msg("tool", "Used run_terminal_cmd", 5),
    ]);
    expect(out.map((m) => m.content)).toEqual([
      "clone omnitouter",
      "Used read_file, grep (3 steps)",
      "Cloned.",
      "Used run_terminal_cmd",
    ]);
  });

  it("caps the tool name list", () => {
    const out = collapseToolRuns(
      ["a", "b", "c", "d", "e"].map((n, i) => msg("tool", `Used ${n}`, i)),
    );
    expect(out[0]!.content).toBe("Used a, b, c +2 more (5 steps)");
  });
});

describe("bubbleToMessage", () => {
  const { bubbleToMessage } = desktopScanInternals;
  const row = (bubble: Record<string, unknown>) => ({ key: "bubbleId:c:b1", value: JSON.stringify(bubble) });

  it("turns Cursor simulated user turns into a one-line sub-task notice", () => {
    const m = bubbleToMessage(
      row({
        bubbleId: "b1",
        type: 1,
        text: "<timestamp>…</timestamp>\n<system_notification>…",
        isSimulatedMsg: true,
        simulatedMessageMetadata: { title: "Survey MasterProject state" },
      }),
      "2026-09-12T17:55:00.000Z",
    );
    expect(m).toMatchObject({ role: "system", content: "Sub-task finished: Survey MasterProject state" });
  });

  it("keeps real user text as a user message", () => {
    const m = bubbleToMessage(row({ bubbleId: "b1", type: 1, text: "reply with pong" }), "x");
    expect(m).toMatchObject({ role: "user", content: "reply with pong" });
  });
});
