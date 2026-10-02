/**
 * Phase 1 — Workspace models / files / tools + session create/attachments (New Session)
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
import { parseModelsEnv, DEFAULT_MODELS } from "../../src/workspace/models.js";
import { validateAttachmentPaths } from "../../src/workspace/files.js";
import { REPO_ROOT } from "../repo-root.js";

const WORKSPACE = REPO_ROOT;

function setup(opts?: {
  healthState?: "cursor_down" | "extractor_stale" | "cdp_ok";
  cursorModels?: string | null;
  cursorMcpServers?: string | null;
}) {
  const config = loadConfig({
    HUB_HOST: "127.0.0.1",
    HUB_PORT: "8787",
    CDP_URL: "http://127.0.0.1:9222",
    PAIRING_REQUIRED: "true",
    CURSOR_WORKSPACE: WORKSPACE,
    CURSOR_MODELS: opts?.cursorModels ?? undefined,
    CURSOR_MCP_SERVERS: opts?.cursorMcpServers ?? "filesystem:3",
  });
  config.cursorWorkspace = WORKSPACE;
  if (opts?.cursorModels !== undefined) {
    config.cursorModels = opts.cursorModels;
  }
  if (opts?.cursorMcpServers !== undefined) {
    config.cursorMcpServers = opts.cursorMcpServers;
  }
  const healthState = opts?.healthState ?? "extractor_stale";
  const pairing = new PairingStore();
  const live = createMockLiveCursorAdapter({
    healthState,
    windowsDetected: healthState === "cursor_down" ? 0 : 1,
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

describe("workspace models parse", () => {
  it("defaults when env empty", () => {
    const models = parseModelsEnv(null);
    expect(models.length).toBe(DEFAULT_MODELS.length);
    expect(models.some((m) => m.default)).toBe(true);
  });

  it("parses id:label:family and * default", () => {
    const models = parseModelsEnv("gpt-x:GPT X:openai,composer*:Composer:composer");
    expect(models).toHaveLength(2);
    expect(models[1]!.default).toBe(true);
    expect(models[1]!.id).toBe("composer");
    expect(models[0]!.family).toBe("openai");
  });

  it("CURSOR_MODELS=__empty__ returns empty catalog (AC-050-03)", () => {
    expect(parseModelsEnv("__empty__")).toEqual([]);
    expect(parseModelsEnv("__none__")).toEqual([]);
  });
});

describe("phase1 / workspace models files tools", () => {
  it("GET /workspace/models returns env_stub_default catalog", async () => {
    const { app } = setup({ cursorModels: null });
    const token = await pair(app);
    const res = await request(app)
      .get("/v1/workspace/models")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.workspaceId).toMatch(/^ws_/);
    expect(res.body.models.length).toBeGreaterThan(0);
    expect(res.body.models[0].id).toBeTruthy();
    expect(res.body.source).toBe("env_stub_default");
    expect(res.body.note).toMatch(/FALLBACK|DESIGNED|defaults/i);
    expect(res.body.domSelectVerified).toBe(false);
  });

  it("GET /workspace/models uses CURSOR_MODELS", async () => {
    const { app } = setup({ cursorModels: "my-model:My Model:custom" });
    const token = await pair(app);
    const res = await request(app)
      .get("/workspace/models")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.models).toHaveLength(1);
    expect(res.body.models[0].id).toBe("my-model");
    expect(res.body.source).toBe("env");
    expect(res.body.domSelectVerified).toBe(false);
    expect(res.body.note).toMatch(/CURSOR_MODELS/i);
  });

  it("GET /workspace/models returns empty when CURSOR_MODELS=__empty__ (AC-050-03)", async () => {
    const { app } = setup({
      cursorModels: "__empty__",
      healthState: "extractor_stale",
    });
    const token = await pair(app);
    const res = await request(app)
      .get("/v1/workspace/models")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.models).toEqual([]);
    expect(res.body.source).toBe("env_empty");
    expect(res.body.note).toMatch(/EMPTY|__empty__/i);
  });

  it("GET /workspace/models prefers CDP scrape when cdp_ok + scrapedModels", async () => {
    const config = loadConfig({
      HUB_HOST: "127.0.0.1",
      HUB_PORT: "8787",
      CDP_URL: "http://127.0.0.1:9222",
      PAIRING_REQUIRED: "true",
      CURSOR_WORKSPACE: WORKSPACE,
    });
    config.cursorWorkspace = WORKSPACE;
    config.cursorModels = null;
    const pairing = new PairingStore();
    const live = createMockLiveCursorAdapter({
      healthState: "cdp_ok",
      windowsDetected: 1,
      scrapedModels: [
        {
          id: "auto",
          label: "Auto",
          family: "auto",
          available: true,
          default: true,
        },
        {
          id: "composer-1",
          label: "composer-1",
          family: "composer",
          available: true,
          default: false,
        },
      ],
    });
    const ctx = createHubContext(config, { pairing, live });
    const app = createApp(ctx);
    const token = await pair(app);
    const res = await request(app)
      .get("/v1/workspace/models")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.source).toBe("cdp_scrape");
    expect(res.body.domSelectVerified).toBe(true);
    expect(res.body.models).toHaveLength(2);
    expect(res.body.models[0].id).toBe("auto");
    expect(res.body.note).toMatch(/scraped/i);
  });

  it("GET /workspace/files?q= scans workspace", async () => {
    const { app } = setup();
    const token = await pair(app);
    const res = await request(app)
      .get("/v1/workspace/files")
      .query({ q: "package.json", limit: 20 })
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.workspaceId).toMatch(/^ws_/);
    expect(res.body.items.some((i: { path: string }) => i.path.includes("package.json"))).toBe(
      true,
    );
    expect(res.body.note).toMatch(/DESIGNED/i);
  });

  it("GET /workspace/file?path= returns text preview under roots", async () => {
    const { app } = setup();
    const token = await pair(app);
    const res = await request(app)
      .get("/v1/workspace/file")
      .query({ path: "package.json" })
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.path).toBe("package.json");
    expect(res.body.binary).toBe(false);
    expect(res.body.content).toMatch(/"name"/);
    expect(res.body.note).toMatch(/Phase 3|preview|PC/i);
  });

  it("GET /workspace/file rejects path outside roots", async () => {
    const { app } = setup();
    const token = await pair(app);
    await request(app)
      .get("/v1/workspace/file")
      .query({ path: "../etc/passwd" })
      .set("Authorization", `Bearer ${token}`)
      .expect(400)
      .expect((r) => {
        expect(r.body.error.code).toBe("PATH_OUTSIDE_ROOT");
      });
  });

  it("GET /workspace/tools summarizes adapter health + env MCP", async () => {
    const { app } = setup({
      healthState: "extractor_stale",
      cursorMcpServers: "filesystem:12",
    });
    const token = await pair(app);
    const res = await request(app)
      .get("/workspace/tools")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.summary.mcpServers[0].name).toBe("filesystem");
    expect(res.body.summary.mcpServers[0].toolCount).toBe(12);
    expect(res.body.summary.note).toMatch(/phone approves/i);
    expect(res.body.liveAdapter.state).toBe("extractor_stale");
    expect(res.body.source).toBe("env");
  });

  it("workspace routes require pair + bound workspace", async () => {
    const { app } = setup();
    await request(app).get("/workspace/models").expect(401);

    const config = loadConfig({ PAIRING_REQUIRED: "true" });
    config.cursorWorkspace = null;
    const pairing = new PairingStore();
    const ctx = createHubContext(config, {
      pairing,
      live: createMockLiveCursorAdapter({ healthState: "cursor_down" }),
    });
    const emptyApp = createApp(ctx);
    const token = await pair(emptyApp);
    await request(emptyApp)
      .get("/workspace/files")
      .set("Authorization", `Bearer ${token}`)
      .expect(409)
      .expect((r) => {
        expect(r.body.error.code).toBe("EMPTY_WORKSPACE");
      });
  });
});

describe("phase1 / POST sessions create + attachments", () => {
  it("creates live session id via adapter; requires Idempotency-Key", async () => {
    const { app } = setup({ healthState: "extractor_stale" });
    const token = await pair(app);
    const ws = resolveWorkspace(WORKSPACE);

    await request(app)
      .post("/sessions")
      .set("Authorization", `Bearer ${token}`)
      .send({ workspaceId: ws.workspaceId, model: "composer" })
      .expect(400)
      .expect((r) => {
        expect(r.body.error.code).toBe("IDEMPOTENCY_KEY_MISSING");
      });

    const res = await request(app)
      .post("/v1/sessions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "create-1")
      .send({
        workspaceId: ws.workspaceId,
        model: "composer",
        prompt: "Wire New Session APIs",
        attachments: ["packages/hub/package.json"],
      })
      .expect(201);

    expect(res.body.id).toMatch(/^sess_live_/);
    expect(res.body.sessionId).toBe(res.body.id);
    expect(res.body.mode).toBe("live");
    expect(res.body.domApplied).toBe(false);
    expect(res.body.attachments).toContain("packages/hub/package.json");
    expect(res.body.note).toMatch(/not driven|extractor_stale|DOM/i);

    const detail = await request(app)
      .get(`/sessions/${res.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(detail.body.attachments).toContain("packages/hub/package.json");

    // Create still lists under live mode even when DOM was not driven
    const list = await request(app)
      .get("/v1/sessions")
      .query({ workspaceId: ws.workspaceId, mode: "live" })
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(list.body.items.some((s: { id: string }) => s.id === res.body.id)).toBe(
      true,
    );
  });

  it("rejects unknown model and outside-root attachments", async () => {
    const { app } = setup({ cursorModels: "composer:Composer:composer" });
    const token = await pair(app);
    const ws = resolveWorkspace(WORKSPACE);

    await request(app)
      .post("/sessions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "bad-model")
      .send({ workspaceId: ws.workspaceId, model: "cloud-only-model" })
      .expect(400)
      .expect((r) => {
        expect(r.body.error.code).toBe("MODEL_UNAVAILABLE");
      });

    await request(app)
      .post("/sessions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "bad-attach")
      .send({
        workspaceId: ws.workspaceId,
        model: "composer",
        attachments: ["../../etc/passwd"],
      })
      .expect(400)
      .expect((r) => {
        expect(r.body.error.code).toBe("ATTACHMENT_OUTSIDE_ROOTS");
      });
  });

  it("POST attachments registers Hub paths with domApplied false (no fake CDP)", async () => {
    const { app } = setup({ healthState: "extractor_stale" });
    const token = await pair(app);
    const ws = resolveWorkspace(WORKSPACE);

    const created = await request(app)
      .post("/sessions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "create-attach")
      .send({ workspaceId: ws.workspaceId, model: "composer" })
      .expect(201);

    const res = await request(app)
      .post(`/v1/sessions/${created.body.id}/attachments`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "attach-1")
      .send({
        attachments: ["packages/hub/README.md"],
        mode: "add",
      })
      .expect(200);

    expect(res.body.sessionId).toBe(created.body.id);
    expect(res.body.added).toContain("packages/hub/README.md");
    expect(res.body.attachments).toContain("packages/hub/README.md");
    expect(res.body.domApplied).toBe(false);
    expect(res.body.note).toMatch(/not applied|DESIGNED|VERIFIED|register/i);
  });

  it("POST attachments fails closed when cursor_down", async () => {
    const { app, live } = setup({ healthState: "extractor_stale" });
    const token = await pair(app);
    const ws = resolveWorkspace(WORKSPACE);
    const created = await request(app)
      .post("/sessions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "create-down")
      .send({ workspaceId: ws.workspaceId, model: "composer" })
      .expect(201);

    // Force health to cursor_down for attachment attempt
    (live as { getHealth: () => Promise<unknown> }).getHealth = async () => ({
      state: "cursor_down",
      cdpUrl: "http://127.0.0.1:9222",
      selectorPack: null,
      windowId: null,
      workspaceId: null,
      extractorReady: false,
      lastError: "down",
      attachedAt: null,
      probe: {
        status: "disconnected",
        urlConfigured: "http://127.0.0.1:9222",
        lastAttachAt: null,
        error: "down",
        cursor: { status: "not_detected", windowsDetected: 0 },
      },
    });

    await request(app)
      .post(`/sessions/${created.body.id}/attachments`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "attach-down")
      .send({ attachments: ["packages/hub/README.md"], mode: "add" })
      .expect(503)
      .expect((r) => {
        expect(r.body.error.code).toBe("CDP_UNAVAILABLE");
      });
  });

  it("validateAttachmentPaths rejects escapes", () => {
    const { ok, invalid } = validateAttachmentPaths(WORKSPACE, [
      "packages/hub/package.json",
      "../outside.txt",
    ]);
    expect(ok).toEqual(["packages/hub/package.json"]);
    expect(invalid.length).toBe(1);
  });
});
