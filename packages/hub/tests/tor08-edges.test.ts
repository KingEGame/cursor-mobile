/**
 * TOR-08 edge ACs — WS reconnect, large message, approval race, binary preview,
 * folder-switch binding refresh, long path (in-process; no live Cursor kill).
 */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { WebSocket } from "ws";
import { createMockLiveCursorAdapter } from "@cursor-mobile/live-cursor";
import { createApp } from "../src/app.js";
import {
  createHubContext,
  loadConfig,
  PairingStore,
  resolveWorkspace,
} from "../src/config.js";
import { createHubServer } from "../src/server.js";
import { readWorkspaceFilePreview } from "../src/workspace/files.js";
import { parseModelsEnv } from "../src/workspace/models.js";

const WORKSPACE = "/data/projects/cursor_mobile";
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function pairApp(app: ReturnType<typeof createApp>): Promise<string> {
  const start = await request(app).post("/pair/start").send({}).expect(201);
  const confirm = await request(app)
    .post("/pair/confirm")
    .send({
      code: start.body.code,
      pairId: start.body.pairId,
      deviceName: "edge-test",
      platform: "android",
      appVersion: "0.1.0",
    })
    .expect(201);
  return confirm.body.deviceToken as string;
}

function baseConfig(extra: Record<string, string> = {}) {
  const config = loadConfig({
    HUB_HOST: "127.0.0.1",
    HUB_PORT: "8787",
    CDP_URL: "http://127.0.0.1:9222",
    PAIRING_REQUIRED: "true",
    CURSOR_WORKSPACE: WORKSPACE,
    HUB_DATA_DIR: "none",
    ...extra,
  });
  config.cursorWorkspace = WORKSPACE;
  config.hubDataDir = null;
  return config;
}

describe("AC-010-02 / AC-011-03 workspace bind refresh + long path", () => {
  it("switching CURSOR_WORKSPACE path changes Hub payload (folder switch sim)", () => {
    const a = tempDir("cm-ws-a-");
    const b = tempDir("cm-ws-b-");
    writeFileSync(join(a, "README.md"), "a\n");
    writeFileSync(join(b, "README.md"), "b\n");
    const snapA = resolveWorkspace(a);
    const snapB = resolveWorkspace(b);
    expect(snapA.workspaceId).not.toBeNull();
    expect(snapB.workspaceId).not.toBeNull();
    expect(snapA.path).toBe(a);
    expect(snapB.path).toBe(b);
    expect(snapA.workspaceId).not.toBe(snapB.workspaceId);
  });

  it("long absolute path is returned in full (banner clamps UI only)", () => {
    const base = tempDir("cm-long-");
    let cur = base;
    for (let i = 0; i < 8; i++) {
      cur = join(cur, `segment_with_a_rather_long_name_${i}`);
      mkdirSync(cur);
    }
    writeFileSync(join(cur, "marker.txt"), "ok\n");
    const snap = resolveWorkspace(cur);
    expect(snap.path).toBe(cur);
    expect((snap.path ?? "").length).toBeGreaterThan(120);
  });
});

describe("AC-032-04 binary / large file preview policy", () => {
  it("marks binary preview with warn note (reject-or-warn)", () => {
    const dir = tempDir("cm-bin-");
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 0, 10]));
    const preview = readWorkspaceFilePreview({
      rootPath: dir,
      relativePath: "blob.bin",
    });
    expect(preview.binary).toBe(true);
    expect(preview.content).toBe("");
    expect(preview.note).toMatch(/Binary|non-text|PC/i);
  });

  it("truncates oversized text preview", () => {
    const dir = tempDir("cm-big-");
    writeFileSync(join(dir, "big.txt"), "x".repeat(80 * 1024));
    const preview = readWorkspaceFilePreview({
      rootPath: dir,
      relativePath: "big.txt",
      maxBytes: 64 * 1024,
    });
    expect(preview.binary).toBe(false);
    expect(preview.truncated).toBe(true);
    expect(preview.content.length).toBeLessThanOrEqual(64 * 1024);
  });
});

describe("AC-050-03 / AC-050-04 empty models + mid-flow clear", () => {
  it("parseModelsEnv __empty__ yields []", () => {
    expect(parseModelsEnv("__empty__")).toEqual([]);
  });

  it("GET models empty then create with vanished model fails", async () => {
    const config = baseConfig({ CURSOR_MODELS: "__empty__" });
    config.cursorModels = "__empty__";
    const pairing = new PairingStore({ dataDir: null });
    const live = createMockLiveCursorAdapter({
      healthState: "extractor_stale",
      windowsDetected: 1,
    });
    const ctx = createHubContext(config, { pairing, live });
    const app = createApp(ctx);
    const token = await pairApp(app);
    const models = await request(app)
      .get("/v1/workspace/models")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(models.body.models).toEqual([]);
    expect(models.body.source).toBe("env_empty");

    const create = await request(app)
      .post("/v1/sessions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "empty-models-create")
      .send({ workspaceId: models.body.workspaceId, model: "composer" });
    expect(create.status).toBeGreaterThanOrEqual(400);
  });
});

describe("AC-030-04 large message body limit", () => {
  it("rejects JSON body over express 256kb limit", async () => {
    const config = baseConfig();
    const pairing = new PairingStore({ dataDir: null });
    const live = createMockLiveCursorAdapter({
      healthState: "cdp_ok",
      windowsDetected: 1,
    });
    const created = await live.createSession({
      workspaceId: resolveWorkspace(WORKSPACE).workspaceId!,
      model: "composer",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const ctx = createHubContext(config, { pairing, live });
    const app = createApp(ctx);
    const token = await pairApp(app);
    const huge = "H".repeat(300 * 1024);
    const res = await request(app)
      .post(`/v1/sessions/${created.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "large-msg-1")
      .send({ content: huge });
    expect([413, 400, 500]).toContain(res.status);
    expect(res.status).not.toBe(202);
  });

  it("accepts large-but-under-limit message", async () => {
    const config = baseConfig();
    const pairing = new PairingStore({ dataDir: null });
    const live = createMockLiveCursorAdapter({
      healthState: "cdp_ok",
      windowsDetected: 1,
    });
    const created = await live.createSession({
      workspaceId: resolveWorkspace(WORKSPACE).workspaceId!,
      model: "composer",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const ctx = createHubContext(config, { pairing, live });
    const app = createApp(ctx);
    const token = await pairApp(app);
    const res = await request(app)
      .post(`/v1/sessions/${created.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "large-msg-ok")
      .send({ content: "M".repeat(100 * 1024) });
    expect(res.status).toBe(202);
  });
});

describe("AC-030-05 concurrent message posts", () => {
  it("parallel sends both complete without hang (best-effort)", async () => {
    const config = baseConfig();
    const pairing = new PairingStore({ dataDir: null });
    const live = createMockLiveCursorAdapter({
      healthState: "cdp_ok",
      windowsDetected: 1,
    });
    const created = await live.createSession({
      workspaceId: resolveWorkspace(WORKSPACE).workspaceId!,
      model: "composer",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const ctx = createHubContext(config, { pairing, live });
    const app = createApp(ctx);
    const token = await pairApp(app);
    const [a, b] = await Promise.all([
      request(app)
        .post(`/v1/sessions/${created.id}/messages`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", "conc-a")
        .send({ content: "concurrent-a" }),
      request(app)
        .post(`/v1/sessions/${created.id}/messages`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", "conc-b")
        .send({ content: "concurrent-b" }),
    ]);
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
  });
});

describe("AC-031-05 approve/deny race deterministic", () => {
  it("second decision fails closed after first resolves", async () => {
    const config = baseConfig({ HUB_ALLOW_SYNTHETIC_APPROVALS: "1" });
    config.allowSyntheticApprovals = true;
    const pairing = new PairingStore({ dataDir: null });
    const live = createMockLiveCursorAdapter({
      healthState: "cdp_ok",
      windowsDetected: 1,
    });
    const created = await live.createSession({
      workspaceId: resolveWorkspace(WORKSPACE).workspaceId!,
      model: "composer",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const syn = await live.enqueuePendingApproval({
      sessionId: created.id,
      tool: { name: "shell", kind: "synthetic" },
      summary: "race uat",
      synthetic: true,
    });
    const ctx = createHubContext(config, { pairing, live });
    const app = createApp(ctx);
    const token = await pairApp(app);

    const approve = await request(app)
      .post(`/v1/sessions/${created.id}/approvals`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "race-approve")
      .send({ approvalId: syn.approvalId, decision: "approve" })
      .expect(200);
    expect(approve.body.decision).toBe("approve");

    const deny = await request(app)
      .post(`/v1/sessions/${created.id}/approvals`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "race-deny")
      .send({ approvalId: syn.approvalId, decision: "deny" });
    expect(deny.status).toBeGreaterThanOrEqual(400);
    expect(String(deny.body?.error?.code ?? "")).toMatch(/APPROVAL/);
  });
});

describe("AC-030-02 / AC-031-03 WS reconnect + pending survives drop", () => {
  it("reconnects with same token without re-pair; pending approval stays", async () => {
    const config = baseConfig({
      HUB_PORT: "0",
      HUB_ALLOW_SYNTHETIC_APPROVALS: "1",
    });
    config.hubPort = 0;
    config.allowSyntheticApprovals = true;
    const pairing = new PairingStore({ dataDir: null });
    const live = createMockLiveCursorAdapter({
      healthState: "cdp_ok",
      windowsDetected: 1,
    });
    const created = await live.createSession({
      workspaceId: resolveWorkspace(WORKSPACE).workspaceId!,
      model: "composer",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const syn = await live.enqueuePendingApproval({
      sessionId: created.id,
      tool: { name: "shell", kind: "synthetic" },
      summary: "ws drop uat",
      synthetic: true,
    });
    const ctx = createHubContext(config, { pairing, live });
    const hub = createHubServer(ctx);
    await hub.listen();
    const bound = hub.server.address();
    if (!bound || typeof bound === "string") {
      await hub.close();
      throw new Error("failed to bind ephemeral Hub port");
    }
    const listenPort = bound.port;
    const base = `http://127.0.0.1:${listenPort}`;

    const start = await request(base).post("/v1/pair/start").send({}).expect(201);
    const confirm = await request(base)
      .post("/v1/pair/confirm")
      .send({
        code: start.body.code,
        pairId: start.body.pairId,
        deviceName: "ws-edge",
        platform: "android",
        appVersion: "0.1.0",
      })
      .expect(201);
    const token = confirm.body.deviceToken as string;

    const hello1 = await wsHello(listenPort, token);
    expect(hello1.type).toBe("server.hello");
    const hello2 = await wsHello(listenPort, token);
    expect(hello2.type).toBe("server.hello");
    expect(hello2.connectionId).not.toBe(hello1.connectionId);

    const pending = await request(base)
      .get(`/v1/sessions/${created.id}/approvals`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(pending.body.items.length).toBeGreaterThanOrEqual(1);
    expect(pending.body.items[0].approvalId).toBe(syn.approvalId);
    expect(pending.body.items[0].status).toBe("pending");

    await hub.close();
  });
});

describe("health.changed push on liveAdapter state flip", () => {
  it("broadcasts health.changed when poller sees cdp_ok → cursor_down", async () => {
    const prevPoll = process.env.HUB_LIVE_POLL_MS;
    process.env.HUB_LIVE_POLL_MS = "40";

    const config = baseConfig({ HUB_PORT: "0" });
    config.hubPort = 0;
    const pairing = new PairingStore({ dataDir: null });
    const live = createMockLiveCursorAdapter({
      healthState: "cdp_ok",
      windowsDetected: 1,
    });
    let state: "cdp_ok" | "cursor_down" | "extractor_stale" = "cdp_ok";
    const origGetHealth = live.getHealth.bind(live);
    live.getHealth = async () => {
      const h = await origGetHealth();
      return {
        ...h,
        state,
        extractorReady: state === "cdp_ok",
        probe: {
          ...h.probe,
          status: state === "cursor_down" ? "disconnected" : "connected",
          cursor: {
            status: state === "cursor_down" ? "not_detected" : "running",
            windowsDetected: state === "cursor_down" ? 0 : 1,
          },
        },
      };
    };

    const ctx = createHubContext(config, { pairing, live });
    const hub = createHubServer(ctx);
    await hub.listen();
    const bound = hub.server.address();
    if (!bound || typeof bound === "string") {
      await hub.close();
      if (prevPoll === undefined) delete process.env.HUB_LIVE_POLL_MS;
      else process.env.HUB_LIVE_POLL_MS = prevPoll;
      throw new Error("failed to bind ephemeral Hub port");
    }
    const listenPort = bound.port;

    const start = await request(`http://127.0.0.1:${listenPort}`)
      .post("/v1/pair/start")
      .send({})
      .expect(201);
    const confirm = await request(`http://127.0.0.1:${listenPort}`)
      .post("/v1/pair/confirm")
      .send({
        code: start.body.code,
        pairId: start.body.pairId,
        deviceName: "health-push",
        platform: "android",
        appVersion: "0.1.0",
      })
      .expect(201);
    const token = confirm.body.deviceToken as string;

    const healthEvents: Array<{ type: string; liveAdapter?: { state?: string } }> =
      [];
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${listenPort}/v1/ws?access_token=${encodeURIComponent(token)}`,
      );
      const t = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error("health.changed timeout"));
      }, 4000);
      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            type: "client.hello",
            apiVersion: 1,
            subscriptions: { health: true, workspace: true, sessions: [] },
          }),
        );
      });
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(String(data)) as {
            type: string;
            liveAdapter?: { state?: string };
          };
          if (msg.type === "server.hello") {
            // Seed poller lastHealthState, then flip.
            void (async () => {
              await new Promise((r) => setTimeout(r, 60));
              state = "cursor_down";
            })();
            return;
          }
          if (msg.type === "health.changed") {
            healthEvents.push(msg);
            if (msg.liveAdapter?.state === "cursor_down") {
              clearTimeout(t);
              ws.close();
              resolve();
            }
          }
        } catch (err) {
          clearTimeout(t);
          reject(err);
        }
      });
      ws.on("error", (err) => {
        clearTimeout(t);
        reject(err);
      });
    });

    expect(
      healthEvents.some((e) => e.liveAdapter?.state === "cursor_down"),
    ).toBe(true);

    await hub.close();
    if (prevPoll === undefined) delete process.env.HUB_LIVE_POLL_MS;
    else process.env.HUB_LIVE_POLL_MS = prevPoll;
  });
});

function wsHello(
  port: number,
  token: string,
): Promise<{ type: string; connectionId?: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/v1/ws?access_token=${encodeURIComponent(token)}`,
    );
    const t = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error("WS hello timeout"));
    }, 5000);
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(String(data)) as {
          type: string;
          connectionId?: string;
        };
        if (msg.type === "server.hello") {
          clearTimeout(t);
          ws.close();
          resolve(msg);
        }
      } catch (err) {
        clearTimeout(t);
        reject(err);
      }
    });
    ws.on("error", (err) => {
      clearTimeout(t);
      reject(err);
    });
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "client.hello",
          apiVersion: 1,
          subscriptions: { health: true, workspace: true, sessions: [] },
        }),
      );
    });
  });
}
