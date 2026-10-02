/**
 * Unit + API tests — New-session create queue (CURSOR_DOWN → drain on cdp_ok).
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
import { drainSessionCreateQueueForCtx } from "../../src/routes/api.js";
import {
  SessionCreateQueue,
  enqueueSessionCreate,
  flushSessionCreateQueue,
  pendingSessionCreateCount,
  snapshotSessionCreateQueue,
} from "../../src/session-create-queue.js";
import { REPO_ROOT } from "../repo-root.js";

const WORKSPACE = REPO_ROOT;

describe("session-create-queue", () => {
  it("enqueues prompt/model/attaches and dedupes by idempotency key", () => {
    const { items, item } = enqueueSessionCreate([], {
      workspaceId: "ws_1",
      model: "composer",
      attachments: ["/a.ts", "/b.ts"],
      prompt: "hello queue",
      agentMode: "agent",
      idempotencyKey: "create-fixed",
    });
    expect(items).toHaveLength(1);
    expect(item.status).toBe("pending");
    expect(item.prompt).toBe("hello queue");
    expect(item.attachments).toEqual(["/a.ts", "/b.ts"]);
    expect(pendingSessionCreateCount(items)).toBe(1);

    const again = enqueueSessionCreate(items, {
      workspaceId: "ws_1",
      model: "composer",
      attachments: ["/a.ts"],
      prompt: "different",
      idempotencyKey: "create-fixed",
    });
    expect(again.deduped).toBe(true);
    expect(again.items).toHaveLength(1);
    expect(again.item.prompt).toBe("hello queue");
  });

  it("flush skipped when not cdp_ok", async () => {
    const { items } = enqueueSessionCreate([], {
      workspaceId: "ws_1",
      model: "composer",
      attachments: [],
      prompt: "wait",
      idempotencyKey: "k1",
    });
    let called = 0;
    const result = await flushSessionCreateQueue(items, {
      isCdpOk: false,
      createSession: async () => {
        called += 1;
        return { ok: true, id: "sess_x" };
      },
    });
    expect(result.skipped).toBe(true);
    expect(called).toBe(0);
    expect(result.items).toHaveLength(1);
  });

  it("flush creates session and drops done item", async () => {
    const { items, item } = enqueueSessionCreate([], {
      workspaceId: "ws_1",
      model: "composer",
      attachments: ["pkg.json"],
      prompt: "ship it",
      idempotencyKey: "k2",
    });
    const payloads: unknown[] = [];
    const result = await flushSessionCreateQueue(items, {
      isCdpOk: true,
      createSession: async (input) => {
        payloads.push(input);
        return { ok: true, id: "sess_live_ok" };
      },
    });
    expect(payloads).toEqual([
      {
        workspaceId: "ws_1",
        model: "composer",
        attachments: ["pkg.json"],
        prompt: "ship it",
        agentMode: undefined,
      },
    ]);
    expect(result.flushedIds).toEqual([item.id]);
    expect(result.items).toHaveLength(0);
    expect(result.lastDrained?.ok).toBe(true);
    expect(result.lastDrained?.sessionId).toBe("sess_live_ok");
  });

  it("flush leaves pending when create still CURSOR_DOWN", async () => {
    const { items } = enqueueSessionCreate([], {
      workspaceId: "ws_1",
      model: "composer",
      attachments: [],
      prompt: "retry later",
      idempotencyKey: "k3",
    });
    const result = await flushSessionCreateQueue(items, {
      isCdpOk: true,
      createSession: async () => ({
        ok: false,
        code: "CURSOR_DOWN",
        message: "still down",
      }),
    });
    expect(result.flushedIds).toHaveLength(0);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe("pending");
    expect(result.lastDrained?.ok).toBe(false);
  });

  it("SessionCreateQueue class snapshot + drain", async () => {
    const q = new SessionCreateQueue();
    q.enqueue({
      workspaceId: "ws_1",
      model: "auto",
      attachments: [],
      prompt: "class",
      idempotencyKey: "cls-1",
    });
    const snap = snapshotSessionCreateQueue(q.list(), null);
    expect(snap.pending).toBe(1);
    expect(snap.items[0]!.promptPrefix).toBe("class");

    const drained = await q.drain({
      isCdpOk: true,
      createSession: async () => ({ ok: true, id: "sess_cls" }),
    });
    expect(drained.flushedIds).toHaveLength(1);
    expect(q.pendingCount()).toBe(0);
    expect(q.snapshot().lastDrained?.sessionId).toBe("sess_cls");
  });
});

describe("POST /sessions CURSOR_DOWN → queue → drain", () => {
  it("returns 202 queued then drains when liveAdapter becomes cdp_ok", async () => {
    const config = loadConfig({
      HUB_HOST: "127.0.0.1",
      HUB_PORT: "8787",
      CDP_URL: "http://127.0.0.1:9222",
      PAIRING_REQUIRED: "true",
      CURSOR_WORKSPACE: WORKSPACE,
    });
    config.cursorWorkspace = WORKSPACE;
    const pairing = new PairingStore();
    const downLive = createMockLiveCursorAdapter({
      healthState: "cursor_down",
      windowsDetected: 0,
    });
    const ctx = createHubContext(config, { pairing, live: downLive });
    const app = createApp(ctx);

    const start = await request(app).post("/pair/start").send({}).expect(201);
    const confirm = await request(app)
      .post("/pair/confirm")
      .send({
        code: start.body.code,
        pairId: start.body.pairId,
        deviceName: "Pixel-queue",
        platform: "android",
        appVersion: "0.1.0",
      })
      .expect(201);
    const token = confirm.body.deviceToken as string;
    const ws = resolveWorkspace(WORKSPACE);

    const queued = await request(app)
      .post("/v1/sessions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "queue-create-1")
      .send({
        workspaceId: ws.workspaceId,
        model: "composer",
        prompt: "queued-new-session-prompt",
        attachments: ["packages/hub/package.json"],
      })
      .expect(202);

    expect(queued.body.queued).toBe(true);
    expect(queued.body.queueId).toMatch(/^q_create_/);
    expect(queued.body.promptLen).toBe("queued-new-session-prompt".length);
    expect(ctx.sessionCreateQueue.pendingCount()).toBe(1);

    const healthDown = await request(app).get("/v1/health").expect(200);
    expect(healthDown.body.sessionCreateQueue.pending).toBe(1);
    expect(
      healthDown.body.liveAdapter.lastSessionCreateAttempt?.queued,
    ).toBe(true);

    // Swap to cdp_ok adapter and drain (same as watcher / health poller).
    ctx.live = createMockLiveCursorAdapter({
      healthState: "cdp_ok",
      windowsDetected: 1,
    });
    const drain = await drainSessionCreateQueueForCtx(ctx);
    expect(drain.skipped).toBe(false);
    expect(drain.flushedIds).toHaveLength(1);
    expect(drain.pending).toBe(0);
    expect(drain.lastDrained?.ok).toBe(true);
    expect(drain.lastDrained?.sessionId).toMatch(/^sess_live_/);

    const healthUp = await request(app).get("/v1/health").expect(200);
    expect(healthUp.body.sessionCreateQueue.pending).toBe(0);
    expect(healthUp.body.sessionCreateQueue.lastDrained?.ok).toBe(true);

    const localDrain = await request(app)
      .post("/v1/sessions/create-queue/drain")
      .expect(200);
    expect(localDrain.body.pending).toBe(0);
  });
});
