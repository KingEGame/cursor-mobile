/**
 * Phase 1 — Live sessions, messages, approvals (TOR-03 / TOR-06)
 */
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createMockLiveCursorAdapter } from "@cursor-mobile/live-cursor";
import { createApp } from "../../src/app.js";
import {
  createHubContext,
  loadConfig,
  PairingStore,
  resolveWorkspace,
} from "../../src/config.js";
import { REPO_ROOT } from "../repo-root.js";

const WORKSPACE = REPO_ROOT;

function setup(opts: {
  healthState: "cursor_down" | "extractor_stale" | "cdp_ok";
  sessions?: Parameters<typeof createMockLiveCursorAdapter>[0]["sessions"];
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
    sessions: opts.sessions,
  });
  const ctx = createHubContext(config, { pairing, live });
  return { app: createApp(ctx), ctx, live };
}

async function pair(app: ReturnType<typeof createApp>) {
  const start = await request(app).post("/pair/start").send({}).expect(201);
  const confirm = await request(app)
    .post("/pair/confirm")
    .send({
      code: start.body.code,
      pairId: start.body.pairId,
      deviceName: "Pixel-test",
      platform: "android",
      appVersion: "0.1.0",
    })
    .expect(201);
  return confirm.body.deviceToken as string;
}

describe("phase1 / sessions live list", () => {
  it("GET /sessions?mode=live returns empty when cursor_down (degraded)", async () => {
    const { app } = setup({ healthState: "cursor_down" });
    const token = await pair(app);
    const ws = resolveWorkspace(WORKSPACE);
    const res = await request(app)
      .get("/sessions")
      .query({ workspaceId: ws.workspaceId, mode: "live" })
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.liveAdapter.state).toBe("cursor_down");
  });

  it("GET /sessions?mode=live returns rows when extractor_stale with CDP sessions", async () => {
    const now = new Date().toISOString();
    const { app } = setup({
      healthState: "extractor_stale",
      sessions: [
        {
          id: "sess_live_mock1",
          workspaceId: "",
          mode: "live",
          title: "Continue wire-up",
          preview: "…",
          model: null,
          updatedAt: now,
          createdAt: now,
          pendingApprovals: 0,
          windowId: "win_1",
          targetId: "t1",
        },
      ],
    });
    const token = await pair(app);
    const ws = resolveWorkspace(WORKSPACE);
    const res = await request(app)
      .get("/v1/sessions")
      .query({ workspaceId: ws.workspaceId, mode: "live" })
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe("sess_live_mock1");
    expect(res.body.items[0].mode).toBe("live");
    expect(res.body.liveAdapter.state).toBe("extractor_stale");
  });

  it("GET /sessions rejects empty / foreign workspace", async () => {
    const config = loadConfig({
      PAIRING_REQUIRED: "true",
      CURSOR_WORKSPACE: "",
    });
    config.cursorWorkspace = null;
    const pairing = new PairingStore();
    const ctx = createHubContext(config, {
      pairing,
      live: createMockLiveCursorAdapter({ healthState: "cursor_down" }),
    });
    const app = createApp(ctx);
    const token = await pair(app);
    await request(app)
      .get("/sessions")
      .query({ workspaceId: "ws_x", mode: "live" })
      .set("Authorization", `Bearer ${token}`)
      .expect(409)
      .expect((r) => {
        expect(r.body.error.code).toBe("EMPTY_WORKSPACE");
      });
  });

  it("GET /sessions foreign workspaceId → FOREIGN_WORKSPACE", async () => {
    const { app } = setup({ healthState: "extractor_stale" });
    const token = await pair(app);
    await request(app)
      .get("/sessions")
      .query({ workspaceId: "ws_foreign", mode: "live" })
      .set("Authorization", `Bearer ${token}`)
      .expect(400)
      .expect((r) => {
        expect(r.body.error.code).toBe("FOREIGN_WORKSPACE");
      });
  });
});

describe("phase1 / messages + approvals fail-closed", () => {
  it("POST messages returns EXTRACTOR_STALE (no fake success)", async () => {
    const now = new Date().toISOString();
    const { app } = setup({
      healthState: "extractor_stale",
      sessions: [
        {
          id: "sess_live_1",
          workspaceId: "ws_abc",
          mode: "live",
          title: "t",
          preview: null,
          model: "m",
          updatedAt: now,
          createdAt: now,
          pendingApprovals: 0,
          windowId: "win_1",
          targetId: "t1",
        },
      ],
    });
    const token = await pair(app);
    const res = await request(app)
      .post("/sessions/sess_live_1/messages")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "msg-key-1")
      .send({ content: "Ship health next" })
      .expect(503);
    expect(res.body.error.code).toBe("EXTRACTOR_STALE");
  });

  it("POST approvals returns EXTRACTOR_STALE (no fake success)", async () => {
    const now = new Date().toISOString();
    const { app, live } = setup({
      healthState: "extractor_stale",
      sessions: [
        {
          id: "sess_live_1",
          workspaceId: "ws_abc",
          mode: "live",
          title: "t",
          preview: null,
          model: null,
          updatedAt: now,
          createdAt: now,
          pendingApprovals: 0,
          windowId: "win_1",
          targetId: "t1",
        },
      ],
    });
    await live.enqueuePendingApproval({
      sessionId: "sess_live_1",
      approvalId: "apr_1",
      synthetic: false,
      tool: { name: "shell" },
      summary: "Real pending tool",
    });
    const token = await pair(app);
    const res = await request(app)
      .post("/sessions/sess_live_1/approvals")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "apr-key-1")
      .send({ approvalId: "apr_1", decision: "deny" })
      .expect(503);
    expect(res.body.error.code).toBe("EXTRACTOR_STALE");
    expect(res.body.error.message).toMatch(/not VERIFIED|extractor_stale/i);
  });

  it("synthetic enqueue + decide records without claiming DOM", async () => {
    const now = new Date().toISOString();
    const { app, live } = setup({
      healthState: "extractor_stale",
      sessions: [
        {
          id: "sess_live_1",
          workspaceId: "ws_abc",
          mode: "live",
          title: "t",
          preview: null,
          model: null,
          updatedAt: now,
          createdAt: now,
          pendingApprovals: 0,
          windowId: "win_1",
          targetId: "t1",
        },
      ],
    });
    const create = await request(app)
      .post("/sessions/sess_live_1/approvals/synthetic")
      .send({ summary: "UAT synthetic tool" })
      .expect(201);
    expect(create.body.synthetic).toBe(true);
    expect(create.body.note).toMatch(/does not prove live/i);
    expect(create.body.approvalId).toMatch(/^apr_/);

    const listed = await live.listPendingApprovals("sess_live_1");
    expect(listed).toHaveLength(1);

    const token = await pair(app);
    const getList = await request(app)
      .get("/sessions/sess_live_1/approvals")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(getList.body.items).toHaveLength(1);
    expect(getList.body.items[0].synthetic).toBe(true);

    const decide = await request(app)
      .post("/sessions/sess_live_1/approvals")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "apr-synth-1")
      .send({ approvalId: create.body.approvalId, decision: "approve" })
      .expect(200);
    expect(decide.body.status).toBe("recorded");
    expect(decide.body.domApplied).toBe(false);
    expect(decide.body.synthetic).toBe(true);
    expect(decide.body.note).toMatch(/DOM was NOT clicked/i);
  });

  it("synthetic route gate: non-loopback requires HUB_ALLOW_SYNTHETIC_APPROVALS=1", async () => {
    const { requireLocalOrSyntheticFlag, isLocalClient } = await import(
      "../../src/local-guard.js"
    );
    expect(
      isLocalClient({ socket: { remoteAddress: "100.91.47.1" } } as never),
    ).toBe(false);
    expect(
      isLocalClient({ socket: { remoteAddress: "127.0.0.1" } } as never),
    ).toBe(true);

    let blocked = false;
    requireLocalOrSyntheticFlag(false)(
      { socket: { remoteAddress: "100.91.47.1" } } as never,
      {} as never,
      (err?: unknown) => {
        blocked = Boolean(err);
      },
    );
    expect(blocked).toBe(true);

    let allowed = false;
    requireLocalOrSyntheticFlag(true)(
      { socket: { remoteAddress: "100.91.47.1" } } as never,
      {} as never,
      (err?: unknown) => {
        allowed = err === undefined;
      },
    );
    expect(allowed).toBe(true);
  });

  it("POST messages requires Idempotency-Key", async () => {
    const { app } = setup({ healthState: "cdp_ok" });
    const token = await pair(app);
    const res = await request(app)
      .post("/sessions/sess_x/messages")
      .set("Authorization", `Bearer ${token}`)
      .send({ content: "hi" })
      .expect(400);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_MISSING");
  });
});

describe("phase1 / health liveAdapter triad", () => {
  it("exposes liveAdapter.state on /health", async () => {
    const { app } = setup({ healthState: "extractor_stale" });
    const res = await request(app).get("/health").expect(200);
    expect(res.body.liveAdapter.state).toBe("extractor_stale");
    expect(res.body.liveAdapter.cdpUrl).toMatch(/127\.0\.0\.1/);
    expect(res.body.cdp.urlConfigured).not.toMatch(/100\./);
  });
});
