/**
 * TOR-08 P0 AC expand — simulated / fail-closed cases (no live Cursor).
 * Raises AUTOMATED share for PARTIAL items that Hub/adapters can prove in-process.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import request from "supertest";
import {
  LiveCursorAdapterImpl,
  createMockLiveCursorAdapter,
} from "@cursor-mobile/live-cursor";
import { MemoryHistoryAdapter } from "@cursor-mobile/history";
import type { HistorySessionDetail } from "@cursor-mobile/history";
import { createApp } from "../src/app.js";
import {
  createHubContext,
  loadConfig,
  PairingStore,
  resolveWorkspace,
} from "../src/config.js";
import { ApiError, errorBody } from "../src/errors.js";
import { createApiRouter } from "../src/routes/api.js";

const WORKSPACE = "/data/projects/cursor_mobile";
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hub-tor08-expand-"));
  tempDirs.push(dir);
  return dir;
}

/** Forge remoteAddress before Hub routes (supertest cannot spoof socket). */
function appWithRemoteAddress(
  ctx: ReturnType<typeof createHubContext>,
  remoteAddress: string,
): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, "remoteAddress", {
      value: remoteAddress,
      configurable: true,
    });
    next();
  });
  const api = createApiRouter(ctx);
  app.use("/v1", api);
  app.use(api);
  app.use((_req, _res, next) => {
    next(new ApiError(404, "NOT_FOUND", "Route not found"));
  });
  app.use(
    (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (err instanceof ApiError) {
        res.status(err.status).json(errorBody(err));
        return;
      }
      res.status(500).json({
        error: { code: "INTERNAL", message: "Internal server error" },
      });
    },
  );
  return app;
}

async function mockCdpServer(opts: {
  targets?: Array<Record<string, unknown>>;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.startsWith("/json/version")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ Browser: "Cursor/mock", "Protocol-Version": "1.3" }),
      );
      return;
    }
    if (req.url?.startsWith("/json/list")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(opts.targets ?? []));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("failed to bind mock CDP");
  }
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

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
    messages: [],
    truncated: false,
    capabilities: { canOpenOnPc: true, readOnly: true },
    ...overrides,
  };
}

async function pairDevice(app: Express): Promise<string> {
  const start = await request(app).post("/pair/start").send({}).expect(201);
  const confirm = await request(app)
    .post("/pair/confirm")
    .send({
      code: start.body.code,
      pairId: start.body.pairId,
      deviceName: "Pixel-expand",
      platform: "android",
      appVersion: "0.1.0",
    })
    .expect(201);
  return confirm.body.deviceToken as string;
}

describe("TOR-08 expand / pair/start remote 403 (TOR-03)", () => {
  it("POST /pair/start → 403 FORBIDDEN for Tailscale peer address", async () => {
    const config = loadConfig({
      HUB_DATA_DIR: "none",
      PAIRING_REQUIRED: "true",
      CURSOR_WORKSPACE: "",
    });
    const ctx = createHubContext(config, {
      live: createMockLiveCursorAdapter({ healthState: "cursor_down" }),
      pairing: new PairingStore(),
    });
    const app = appWithRemoteAddress(ctx, "100.64.1.2");
    const res = await request(app).post("/v1/pair/start").send({}).expect(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(res.body.error.message).toMatch(/local-only|loopback|pair\/complete/i);
  });

  it("POST /pair/start still 201 for forged loopback", async () => {
    const config = loadConfig({
      HUB_DATA_DIR: "none",
      PAIRING_REQUIRED: "true",
    });
    const ctx = createHubContext(config, {
      live: createMockLiveCursorAdapter({ healthState: "cursor_down" }),
      pairing: new PairingStore(),
    });
    const app = appWithRemoteAddress(ctx, "127.0.0.1");
    await request(app).post("/pair/start").send({}).expect(201);
  });
});

describe("TOR-08 expand / device persist across Hub restart (NFR-REL-06)", () => {
  it("paired token authenticates after PairingStore reload from disk", async () => {
    const dataDir = tempDataDir();
    const pairing1 = new PairingStore({ dataDir });
    const config = loadConfig({
      HUB_DATA_DIR: dataDir,
      PAIRING_REQUIRED: "true",
      CURSOR_WORKSPACE: WORKSPACE,
    });
    config.cursorWorkspace = WORKSPACE;
    config.hubDataDir = dataDir;

    const app1 = createApp(
      createHubContext(config, {
        pairing: pairing1,
        live: createMockLiveCursorAdapter({
          healthState: "extractor_stale",
          windowsDetected: 1,
        }),
      }),
    );
    const token = await pairDevice(app1);
    expect(pairing1.pairedCount()).toBe(1);

    // Simulate Hub process restart: new store + app, same dataDir.
    const pairing2 = new PairingStore({ dataDir });
    expect(pairing2.pairedCount()).toBe(1);
    const app2 = createApp(
      createHubContext(config, {
        pairing: pairing2,
        live: createMockLiveCursorAdapter({
          healthState: "extractor_stale",
          windowsDetected: 1,
        }),
      }),
    );
    const ws = await request(app2)
      .get("/v1/workspace")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(ws.body.workspaceId).toMatch(/^ws_/);
    expect(ws.body.path).toBe(WORKSPACE);
    // Health after restart still counts the rehydrated device.
    const health = await request(app2).get("/health").expect(200);
    expect(health.body.pairing.devicesPaired).toBe(1);
  });
});

describe("TOR-08 expand / workspace files q= + roots (AC-051-01 / AC-051-04)", () => {
  function setupFiles() {
    const config = loadConfig({
      HUB_DATA_DIR: "none",
      PAIRING_REQUIRED: "true",
      CURSOR_WORKSPACE: WORKSPACE,
    });
    config.cursorWorkspace = WORKSPACE;
    const pairing = new PairingStore();
    const ctx = createHubContext(config, {
      pairing,
      live: createMockLiveCursorAdapter({
        healthState: "extractor_stale",
        windowsDetected: 1,
      }),
    });
    return { app: createApp(ctx) };
  }

  it("GET /workspace/files?q= returns matches under bound workspace", async () => {
    const { app } = setupFiles();
    const token = await pairDevice(app);
    const res = await request(app)
      .get("/v1/workspace/files")
      .query({ q: "vitest.config", limit: 50 })
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.workspaceId).toMatch(/^ws_/);
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const item of res.body.items as Array<{ path: string }>) {
      expect(item.path.toLowerCase()).toContain("vitest.config");
      expect(item.path).not.toMatch(/\.\./);
    }
  });

  it("GET /workspace/files?root= scopes scan under declared root filter", async () => {
    const { app } = setupFiles();
    const token = await pairDevice(app);
    const res = await request(app)
      .get("/workspace/files")
      .query({ q: "package.json", root: "packages/hub", limit: 100 })
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const item of res.body.items as Array<{ path: string }>) {
      expect(item.path.startsWith("packages/hub")).toBe(true);
    }
  });

  it("GET /workspace/files?root= escape outside workspace → empty (fail-closed)", async () => {
    const { app } = setupFiles();
    const token = await pairDevice(app);
    const res = await request(app)
      .get("/v1/workspace/files")
      .query({ root: "../etc", q: "passwd" })
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.items).toEqual([]);
  });
});

describe("TOR-08 expand / sessions mode=history empty", () => {
  it("GET /sessions?mode=history → empty items when index empty", async () => {
    const config = loadConfig({
      HUB_DATA_DIR: "none",
      PAIRING_REQUIRED: "true",
      CURSOR_WORKSPACE: WORKSPACE,
    });
    config.cursorWorkspace = WORKSPACE;
    const pairing = new PairingStore();
    const app = createApp(
      createHubContext(config, {
        pairing,
        live: createMockLiveCursorAdapter({
          healthState: "extractor_stale",
          windowsDetected: 1,
        }),
        history: new MemoryHistoryAdapter([]),
      }),
    );
    const token = await pairDevice(app);
    const ws = resolveWorkspace(WORKSPACE);
    const res = await request(app)
      .get("/v1/sessions")
      .query({ workspaceId: ws.workspaceId, mode: "history" })
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.history.sessionCountForBind).toBe(0);
  });
});

describe("TOR-08 expand / health extractor_stale when pack CANDIDATE", () => {
  it("GET /health liveAdapter.state=extractor_stale with mock CDP + CANDIDATE pack", async () => {
    const mock = await mockCdpServer({
      targets: [
        {
          id: "t1",
          title: "cursor_mobile — Cursor",
          type: "page",
          url: "vscode-file://cursor",
          webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/t1",
        },
      ],
    });
    try {
      const live = new LiveCursorAdapterImpl({
        cdpUrl: mock.url,
        fetchTimeoutMs: 500,
        selectorPack: {
          id: "cursor-ui@candidate-expand",
          verified: false,
          reason: "Selector pack actions still CANDIDATE — mutations blocked",
        },
      });
      await live.attach();
      const health = await live.getHealth();
      expect(health.state).toBe("extractor_stale");
      expect(health.extractorReady).toBe(false);
      expect(health.probe.status).toBe("connected");

      const config = loadConfig({
        HUB_DATA_DIR: "none",
        PAIRING_REQUIRED: "true",
        CURSOR_WORKSPACE: WORKSPACE,
        CDP_URL: mock.url,
      });
      config.cursorWorkspace = WORKSPACE;
      const app = createApp(createHubContext(config, { live }));
      const res = await request(app).get("/v1/health").expect(200);
      expect(res.body.hub.status).toBe("up");
      expect(res.body.cdp.status).toBe("connected");
      expect(res.body.liveAdapter.state).toBe("extractor_stale");
      expect(res.body.liveAdapter.extractorReady).toBe(false);
    } finally {
      await mock.close();
    }
  });
});

describe("TOR-08 expand / open-on-pc 503 when CDP down", () => {
  it("POST open-on-pc → 503 OPEN_ON_PC_CDP_DOWN (fail-closed, no fake reopen)", async () => {
    const ws = resolveWorkspace(WORKSPACE);
    const config = loadConfig({
      HUB_DATA_DIR: "none",
      PAIRING_REQUIRED: "true",
      CURSOR_WORKSPACE: WORKSPACE,
    });
    config.cursorWorkspace = WORKSPACE;
    const pairing = new PairingStore();
    const app = createApp(
      createHubContext(config, {
        pairing,
        live: createMockLiveCursorAdapter({ healthState: "cursor_down" }),
        history: new MemoryHistoryAdapter([
          histSession({
            sessionId: "hist_cdp_down",
            workspaceId: ws.workspaceId!,
          }),
        ]),
      }),
    );
    const token = await pairDevice(app);
    await request(app)
      .post("/v1/sessions/hist_cdp_down/open-on-pc")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "oop-expand-1")
      .send({})
      .expect(503)
      .expect((r) => {
        expect(r.body.error.code).toBe("OPEN_ON_PC_CDP_DOWN");
      });
  });
});

describe("TOR-08 expand / CDP_URL loopback lock (AC-001-02 / AC-X-02)", () => {
  it("loadConfig rejects Tailscale / non-loopback CDP_URL at Hub boot", () => {
    expect(() =>
      loadConfig({
        HUB_DATA_DIR: "none",
        CDP_URL: "http://100.91.47.68:9222",
      }),
    ).toThrow(/loopback/i);
    expect(() =>
      loadConfig({
        HUB_DATA_DIR: "none",
        CDP_URL: "http://192.168.1.10:9222",
      }),
    ).toThrow(/loopback/i);
  });

  it("loadConfig normalizes default and trailing slash to loopback", () => {
    const cfg = loadConfig({
      HUB_DATA_DIR: "none",
      CDP_URL: "http://127.0.0.1:9222/",
    });
    expect(cfg.cdpUrl).toBe("http://127.0.0.1:9222");
  });
});

describe("TOR-08 expand / empty message content (sender UX)", () => {
  it("POST messages with blank content → 400 VALIDATION_ERROR (no CDP mutation)", async () => {
    const config = loadConfig({
      HUB_DATA_DIR: "none",
      PAIRING_REQUIRED: "true",
      CURSOR_WORKSPACE: WORKSPACE,
    });
    config.cursorWorkspace = WORKSPACE;
    const app = createApp(
      createHubContext(config, {
        pairing: new PairingStore(),
        live: createMockLiveCursorAdapter({ healthState: "extractor_stale" }),
      }),
    );
    const token = await pairDevice(app);
    const res = await request(app)
      .post("/v1/sessions/sess_any/messages")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "empty-msg-1")
      .send({ content: "   " })
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.message).toMatch(/non-empty/i);
  });
});
