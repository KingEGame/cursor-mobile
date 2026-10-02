/**
 * Phase 2 — History list / messages / open-on-pc
 */
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createMockLiveCursorAdapter } from "@cursor-mobile/live-cursor";
import { MemoryHistoryAdapter } from "@cursor-mobile/history";
import type { HistorySessionDetail } from "@cursor-mobile/history";
import { createApp } from "../../src/app.js";
import {
  createHubContext,
  loadConfig,
  PairingStore,
  resolveWorkspace,
} from "../../src/config.js";
import { REPO_ROOT } from "../repo-root.js";

const WORKSPACE = REPO_ROOT;

function histSession(
  overrides: Partial<HistorySessionDetail> & {
    sessionId: string;
    workspaceId: string;
  },
): HistorySessionDetail {
  const now = "2026-09-25T12:00:00.000Z";
  return {
    title: "Past chat",
    preview: "hello",
    model: "composer",
    updatedAt: now,
    createdAt: now,
    mode: "history",
    nativeKeyFingerprint: "sha256:deadbeef",
    backend: "desktop_globalStorage",
    correlationKey: "ck_deadbeef",
    messages: [
      {
        messageId: "m_1",
        role: "user",
        content: "hello history",
        createdAt: now,
      },
    ],
    truncated: false,
    capabilities: { canOpenOnPc: true, readOnly: true },
    ...overrides,
  };
}

function setup(opts: {
  healthState: "cursor_down" | "extractor_stale" | "cdp_ok";
  history?: HistorySessionDetail[];
}) {
  const config = loadConfig({
    HUB_HOST: "127.0.0.1",
    HUB_PORT: "8787",
    CDP_URL: "http://127.0.0.1:9222",
    PAIRING_REQUIRED: "true",
    CURSOR_WORKSPACE: WORKSPACE,
  });
  config.cursorWorkspace = WORKSPACE;
  const pairing = new PairingStore();
  const live = createMockLiveCursorAdapter({
    healthState: opts.healthState,
    windowsDetected: opts.healthState === "cursor_down" ? 0 : 1,
  });
  const history = new MemoryHistoryAdapter(opts.history ?? []);
  const ctx = createHubContext(config, { pairing, live, history });
  return { app: createApp(ctx), ctx, live };
}

async function pair(app: ReturnType<typeof createApp>) {
  const start = await request(app).post("/pair/start").send({}).expect(201);
  const confirm = await request(app)
    .post("/pair/confirm")
    .send({
      code: start.body.code,
      pairId: start.body.pairId,
      deviceName: "Pixel-hist",
      platform: "android",
      appVersion: "0.1.0",
    })
    .expect(201);
  return confirm.body.deviceToken as string;
}

describe("phase2 / history empty + filter", () => {
  it("GET /sessions?mode=history returns empty when index empty", async () => {
    const { app } = setup({ healthState: "extractor_stale", history: [] });
    const token = await pair(app);
    const ws = resolveWorkspace(WORKSPACE);
    const res = await request(app)
      .get("/sessions")
      .query({ workspaceId: ws.workspaceId, mode: "history" })
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.history.sessionCountForBind).toBe(0);
  });

  it("GET /sessions?mode=history filters by bound workspaceId", async () => {
    const ws = resolveWorkspace(WORKSPACE);
    const { app } = setup({
      healthState: "extractor_stale",
      history: [
        histSession({
          sessionId: "hist_in",
          workspaceId: ws.workspaceId!,
          title: "In bind",
        }),
        histSession({
          sessionId: "hist_out",
          workspaceId: "ws_other",
          title: "Other project",
        }),
      ],
    });
    const token = await pair(app);
    const res = await request(app)
      .get("/v1/sessions")
      .query({ workspaceId: ws.workspaceId, mode: "history" })
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe("hist_in");
    expect(res.body.items[0].mode).toBe("history");
  });

  it("GET /sessions/:id/messages returns history transcript", async () => {
    const ws = resolveWorkspace(WORKSPACE);
    const { app } = setup({
      healthState: "extractor_stale",
      history: [
        histSession({
          sessionId: "hist_msg",
          workspaceId: ws.workspaceId!,
        }),
      ],
    });
    const token = await pair(app);
    const res = await request(app)
      .get("/sessions/hist_msg/messages")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.mode).toBe("history");
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].content).toBe("hello history");
  });
});

describe("phase2 / open-on-pc", () => {
  it("POST open-on-pc → 503 when cursor_down", async () => {
    const ws = resolveWorkspace(WORKSPACE);
    const { app } = setup({
      healthState: "cursor_down",
      history: [
        histSession({
          sessionId: "hist_open",
          workspaceId: ws.workspaceId!,
        }),
      ],
    });
    const token = await pair(app);
    await request(app)
      .post("/sessions/hist_open/open-on-pc")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "oop-1")
      .send({})
      .expect(503)
      .expect((r) => {
        expect(r.body.error.code).toBe("OPEN_ON_PC_CDP_DOWN");
      });
  });

  it("POST open-on-pc uses strategy B (ui_reopen) when mock CDP ready", async () => {
    const ws = resolveWorkspace(WORKSPACE);
    const { app } = setup({
      healthState: "cdp_ok",
      history: [
        histSession({
          sessionId: "hist_open2",
          workspaceId: ws.workspaceId!,
          title: "Resume me",
        }),
      ],
    });
    const token = await pair(app);
    const res = await request(app)
      .post("/sessions/hist_open2/open-on-pc")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "oop-2")
      .send({})
      .expect(200);
    expect(res.body.mode).toBe("live");
    expect(res.body.previousMode).toBe("history");
    expect(res.body.historySessionId).toBe("hist_open2");
    expect(res.body.composerChatId).toBe("open2");
    expect(res.body.strategy).toBe("ui_reopen");
    expect(res.body.strategyB.status).toBe("applied");
    expect(res.body.domApplied).toBe(true);
    expect(res.body.sessionId).toBeTruthy();
  });

  it("POST open-on-pc falls back to strategy C when strategy B is CANDIDATE", async () => {
    const ws = resolveWorkspace(WORKSPACE);
    const { app } = setup({
      healthState: "extractor_stale",
      history: [
        histSession({
          sessionId: "hist_candidate",
          workspaceId: ws.workspaceId!,
          title: "Past chat",
        }),
      ],
    });
    const token = await pair(app);
    const res = await request(app)
      .post("/sessions/hist_candidate/open-on-pc")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "oop-3")
      .send({})
      .expect(200);
    expect(res.body.mode).toBe("live");
    expect(res.body.strategy).toBe("new_live_context");
    expect(res.body.composerChatId).toBe("candidate");
    expect(res.body.strategyB.attempted).toBe(true);
    expect(res.body.strategyB.status).toBe("selector_candidate");
    expect(res.body.strategyB.code).toBe("OPEN_ON_PC_SELECTOR_CANDIDATE");
    expect(res.body.note).toMatch(/strategy B/i);
    expect(res.body.note).toMatch(/CANDIDATE|strategy C/i);
  });

  it("POST open-on-pc skips strategy B for agent-cli history ids", async () => {
    const ws = resolveWorkspace(WORKSPACE);
    const { app } = setup({
      healthState: "extractor_stale",
      history: [
        histSession({
          sessionId: "hist_cli_abc123",
          workspaceId: ws.workspaceId!,
          backend: "agent_cli_chats",
          title: "CLI chat",
        }),
      ],
    });
    const token = await pair(app);
    const res = await request(app)
      .post("/sessions/hist_cli_abc123/open-on-pc")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "oop-4")
      .send({})
      .expect(200);
    expect(res.body.strategy).toBe("new_live_context");
    expect(res.body.composerChatId).toBeNull();
    expect(res.body.strategyB.status).toBe("no_composer_chat_id");
    expect(res.body.strategyB.attempted).toBe(false);
  });
});
