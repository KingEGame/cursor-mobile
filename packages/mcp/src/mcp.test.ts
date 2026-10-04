/**
 * End to end: real Hub app (mock Cursor adapter) ← HubClient ← MCP server ← MCP client.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMockLiveCursorAdapter } from "@cursor-mobile/live-cursor";
import { createApp, createHubContext, loadConfig, PairingStore } from "@cursor-mobile/hub";
import { assertLoopbackUrl, HubClient, memoryTokenStore } from "./hub-client.js";
import { findPrompt, replyAfterLastPrompt, waitForAgent } from "./cursor-api.js";
import { createCursorMcpServer } from "./server.js";

const CHAT = "466762d6-04ca-46e6-a047-4ad7932ae829";
const OTHER = "5197bfb7-05a0-460d-9c89-6b2b0fd2f4c9";

let server: Server;
let baseUrl: string;
let pairing: PairingStore;
let client: Client;
let live: ReturnType<typeof createMockLiveCursorAdapter>;
const tokens = memoryTokenStore();

beforeAll(async () => {
  const config = loadConfig({
    HUB_HOST: "127.0.0.1",
    HUB_PORT: "0",
    CDP_URL: "http://127.0.0.1:9222",
    PAIRING_REQUIRED: "true",
    HUB_DATA_DIR: "none",
  });
  pairing = new PairingStore();
  live = createMockLiveCursorAdapter({
    healthState: "cdp_ok",
    sidebarSections: [
      {
        sectionId: "workspace:185f",
        name: "omnitouter",
        expanded: true,
        hasMore: false,
        chats: [
          { composerId: CHAT, title: "Ping response", ageLabel: "2m", active: true, live: "idle" },
          { composerId: OTHER, title: "Busy one", ageLabel: "now", active: false, live: "working" },
        ],
      },
    ],
  });
  const history = {
    getStatus: async () => ({ state: "ok" }),
    getMessages: async (id: string) =>
      id === `hist_${CHAT}`
        ? {
            sessionId: id,
            truncated: false,
            messages: [
              { messageId: "m1", role: "user", content: "reply with ping", createdAt: "x" },
              { messageId: "m2", role: "assistant", content: "ping", createdAt: "x" },
            ],
          }
        : null,
  };
  const agentsIndex = {
    describe: () => new Map(),
    recent: () => [],
    changes: (id: string) =>
      id === CHAT ? [{ index: 0, path: "a.ts", isNew: false, deleted: false, added: 1, removed: 1, skipped: null }] : null,
    fileDiff: (id: string, index: number) =>
      id === CHAT && index === 0
        ? {
            index: 0, path: "a.ts", isNew: false, deleted: false, added: 1, removed: 1, skipped: null,
            hunks: [{ oldStart: 1, newStart: 1, lines: ["-old", "+new"] }],
          }
        : null,
  };
  const ctx = createHubContext(config, {
    pairing,
    live,
    history: history as never,
    agentsIndex: agentsIndex as never,
  });
  server = createApp(ctx).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const mcp = createCursorMcpServer(new HubClient({ baseUrl, tokens }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await mcp.connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
});

afterAll(async () => {
  await client?.close();
  await new Promise((r) => server.close(r));
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  const text = res.content[0]!.text;
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* plain text result */
  }
  return { isError: !!res.isError, text, json: json as any };
}

describe("cursor-mobile MCP", () => {
  it("exposes the agreed tools (no message editing)", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "cursor_changes",
      "cursor_diff",
      "cursor_find_mention",
      "cursor_list_projects",
      "cursor_new_chat",
      "cursor_read_chat",
      "cursor_send",
      "cursor_status",
      "cursor_stop",
      "cursor_wait",
    ]);
  });

  it("pairs itself over loopback as a revocable device", async () => {
    const res = await call("cursor_list_projects");
    expect(res.isError).toBe(false);
    expect(tokens.load()).toBeTruthy();
    expect(pairing.listDevices().map((d) => d.deviceName)).toContain("Claude (MCP)");
    expect(res.json.projects[0]).toMatchObject({ projectId: "workspace:185f", name: "omnitouter" });
    expect(res.json.projects[0].chats.map((c: { status: string }) => c.status)).toEqual(["idle", "working"]);
  });

  it("filters projects by name", async () => {
    expect((await call("cursor_list_projects", { project: "nope" })).json.projects).toEqual([]);
  });

  it("reads a chat transcript", async () => {
    const res = await call("cursor_read_chat", { composerId: CHAT });
    expect(res.json).toMatchObject({ title: "Ping response", status: "idle", totalMessages: 2 });
    expect(res.json.messages).toEqual([
      { role: "user", text: "reply with ping" },
      { role: "assistant", text: "ping" },
    ]);
  });

  it("sends, starts chats and stops through the Hub", async () => {
    expect((await call("cursor_send", { composerId: CHAT, text: "hi", mode: "Ask" })).json).toMatchObject({ sent: true });
    expect((await call("cursor_new_chat", { projectId: "workspace:185f", text: "hello" })).json).toMatchObject({
      started: true,
    });
    expect((await call("cursor_stop", { composerId: OTHER })).isError).toBe(false);
  });

  it("reports Hub refusals as tool errors instead of guessing", async () => {
    const res = await call("cursor_send", { composerId: "11111111-2222-3333-4444-555555555555", text: "hi" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/CHAT_NOT_IN_SIDEBAR/);
    expect((await call("cursor_send", { composerId: "bc-123", text: "hi" })).text).toMatch(/Not a local Cursor chat id/);
  });

  it("refuses to send while Cursor's agent runtime needs Reload Window, and says so in status", async () => {
    const real = live.scrapeSidebar.bind(live);
    live.scrapeSidebar = async () => {
      const r = await real();
      return r.ok
        ? { ...r, alerts: [{ title: "Agent Execution Timed Out", message: "not responding", actions: ["Reload Window"], error: true, needsReload: true }] }
        : r;
    };
    try {
      const sent = await call("cursor_send", { composerId: CHAT, text: "hi" });
      expect(sent.isError).toBe(true);
      expect(sent.text).toMatch(/CURSOR_NEEDS_RELOAD.*Reload Window/);
      expect((await call("cursor_new_chat", { projectId: "workspace:185f", text: "x" })).text).toMatch(/CURSOR_NEEDS_RELOAD/);
      expect((await call("cursor_status")).json).toMatchObject({ cursor: "needs_reload", canDriveCursor: false });
      expect((await call("cursor_list_projects")).json.cursorAlerts[0]).toMatch(/Agent Execution Timed Out/);
    } finally {
      live.scrapeSidebar = real;
    }
  });

  it("lists changes and renders a diff", async () => {
    expect((await call("cursor_changes", { composerId: CHAT })).json[0]).toMatchObject({ path: "a.ts", index: 0 });
    expect((await call("cursor_diff", { composerId: CHAT, index: 0 })).text).toBe(
      "--- a.ts (+1 -1)\n@@ -1,1 +1,1 @@\n-old\n+new",
    );
  });

  it("re-pairs when the Hub revokes its token", async () => {
    const old = tokens.load();
    pairing.pruneStale(new Date(Date.now() + 60_000), []);
    expect((await call("cursor_status")).json).toMatchObject({ hub: "up", cursor: "cdp_ok", canDriveCursor: true });
    expect((await call("cursor_list_projects")).isError).toBe(false);
    expect(tokens.load()).not.toBe(old);
  });
});

describe("HubClient pairing", () => {
  it("parallel first calls pair once", async () => {
    const store = memoryTokenStore();
    const hub = new HubClient({ baseUrl, tokens: store });
    const before = pairing.listDevices().length;
    await Promise.all([1, 2, 3, 4].map(() => hub.call("GET", "/v1/agents")));
    expect(pairing.listDevices().length).toBe(before + 1);
  });
});

describe("waitForAgent", () => {
  function fakeHub(statuses: string[]) {
    let i = 0;
    return {
      call: async (_m: string, path: string) => {
        if (path === "/v1/agents") {
          const status = statuses[Math.min(i++, statuses.length - 1)];
          return { source: "sidebar", note: null, projects: [{ projectId: "p", name: "p", path: null, hasMore: false, chats: [{ composerId: CHAT, title: "t", status }] }] };
        }
        return {
          truncated: false,
          messages: [
            { id: "1", role: "user", content: "old", createdAt: "" },
            { id: "2", role: "assistant", content: "old reply", createdAt: "" },
            { id: "3", role: "user", content: "new", createdAt: "" },
            { id: "4", role: "system", content: "Used grep", createdAt: "" },
            { id: "5", role: "assistant", content: "done", createdAt: "" },
          ],
        };
      },
    } as unknown as HubClient;
  }
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it("waits for working → idle and returns the reply after the last prompt", async () => {
    const res = await waitForAgent(fakeHub(["idle", "working", "working", "idle"]), CHAT, { timeoutMs: 60_000, pollMs: 1000, ...clock() });
    expect(res).toMatchObject({ status: "idle", finished: true, timedOut: false });
    expect(res.reply.map((m) => m.content)).toEqual(["Used grep", "done"]);
  });

  it("stops early when the agent needs approval", async () => {
    const res = await waitForAgent(fakeHub(["waiting_approval"]), CHAT, { timeoutMs: 60_000, ...clock() });
    expect(res.status).toBe("waiting_approval");
  });

  it("times out while still working", async () => {
    const res = await waitForAgent(fakeHub(["working"]), CHAT, { timeoutMs: 5_000, pollMs: 1000, ...clock() });
    expect(res).toMatchObject({ timedOut: true, finished: false, reply: [] });
  });

  it("returns the reply after the prompt it sent, even with mention chips in front", async () => {
    const res = await waitForAgent(fakeHub(["working", "idle"]), CHAT, { timeoutMs: 60_000, expectPrompt: "old", ...clock() });
    expect(res).toMatchObject({ promptLanded: true });
    expect(res.reply.map((m) => m.content)).toEqual(["old reply", "new", "Used grep", "done"]);
  });

  it("says so when the sent prompt never reached the transcript (Cursor failed the run)", async () => {
    const res = await waitForAgent(fakeHub(["working", "idle"]), CHAT, {
      timeoutMs: 60_000,
      expectPrompt: "reply with pong",
      ...clock(),
    });
    expect(res).toMatchObject({ finished: false, promptLanded: false, reply: [] });
    expect(res.warning).toMatch(/Agent Execution Timed Out/);
  });

  it("replyAfterLastPrompt keeps everything when there is no user turn", () => {
    expect(replyAfterLastPrompt([{ id: "a", role: "assistant", content: "x", createdAt: "" }])).toHaveLength(1);
  });
});

describe("findPrompt", () => {
  it("matches the typed text after mention chips", () => {
    const msgs = [{ id: "1", role: "user" as const, content: "AGENTS.md  Reply with the heading", createdAt: "" }];
    expect(findPrompt(msgs, "Reply with  the heading")).toBe(0);
    expect(findPrompt(msgs, "something else")).toBe(-1);
  });
});

describe("assertLoopbackUrl", () => {
  it("accepts only the local Hub", () => {
    expect(assertLoopbackUrl("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(assertLoopbackUrl("http://localhost:8787")).toBe("http://localhost:8787");
    expect(() => assertLoopbackUrl("http://100.108.160.99:8787")).toThrow(/local Hub/);
    expect(() => assertLoopbackUrl("https://127.0.0.1:8787")).toThrow(/local Hub/);
  });
});
