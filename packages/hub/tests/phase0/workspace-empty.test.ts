/**
 * Phase 0 — Workspace empty-state (FR-010–013)
 * Aligns with TOR-03 GET /v1/workspace empty payload.
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

function appWithWorkspace(
  cursorWorkspace: string | null,
  healthState: "cursor_down" | "extractor_stale" = "extractor_stale",
) {
  const config = loadConfig({
    HUB_HOST: "127.0.0.1",
    HUB_PORT: "8787",
    CDP_URL: "http://127.0.0.1:9222",
    PAIRING_REQUIRED: "true",
  });
  config.cursorWorkspace = cursorWorkspace;
  const pairing = new PairingStore();
  const ctx = createHubContext(config, {
    pairing,
    live: createMockLiveCursorAdapter({
      healthState,
      windowsDetected: healthState === "cursor_down" ? 0 : 1,
    }),
  });
  return { app: createApp(ctx), pairing, ctx };
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
      appVersion: "0.0.0",
    })
    .expect(201);
  return confirm.body.deviceToken as string;
}

describe("phase0 / workspace empty-state (FR-012)", () => {
  it("AC-012-01: no CURSOR_WORKSPACE → emptyReason NO_FOLDER_OPEN", () => {
    const ws = resolveWorkspace(null);
    expect(ws.workspaceId).toBeNull();
    expect(ws.name).toBeNull();
    expect(ws.path).toBeNull();
    expect(ws.roots).toEqual([]);
    expect("emptyReason" in ws && ws.emptyReason).toBe("NO_FOLDER_OPEN");
  });

  it("AC-012-02: empty state invents no fake project id", () => {
    const ws = resolveWorkspace(null);
    expect(ws.workspaceId).toBeNull();
    expect(JSON.stringify(ws)).not.toMatch(/cloud/i);
  });

  it("AC-012-03: GET /workspace empty when paired and unset", async () => {
    const { app } = appWithWorkspace(null);
    const token = await pair(app);
    const res = await request(app)
      .get("/workspace")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.workspaceId).toBeNull();
    expect(res.body.emptyReason).toBe("NO_FOLDER_OPEN");
  });

  it("AC-010-01: bound workspace exposes name/path/roots", async () => {
    const { app } = appWithWorkspace("/data/projects/cursor_mobile");
    const token = await pair(app);
    const res = await request(app)
      .get("/workspace")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.workspaceId).toMatch(/^ws_/);
    expect(res.body.name).toBe("cursor_mobile");
    expect(res.body.path).toBe("/data/projects/cursor_mobile");
    expect(res.body.roots.length).toBeGreaterThan(0);
  });

  it("AC-012-01 empty: POST /sessions rejected with EMPTY_WORKSPACE", async () => {
    const { app } = appWithWorkspace(null);
    const token = await pair(app);
    const res = await request(app)
      .post("/sessions")
      .set("Authorization", `Bearer ${token}`)
      .send({ workspaceId: "ws_anything", model: "x" })
      .expect(409);
    expect(res.body.error.code).toBe("EMPTY_WORKSPACE");
    expect(res.body.error.message).toMatch(/Open a project in Cursor/i);
  });

  it("AC-013-02 / AC-013-04: foreign workspaceId rejected", async () => {
    const { app } = appWithWorkspace("/data/projects/cursor_mobile");
    const token = await pair(app);
    const res = await request(app)
      .post("/sessions")
      .set("Authorization", `Bearer ${token}`)
      .send({ workspaceId: "ws_foreign", model: "composer-1" })
      .expect(400);
    expect(res.body.error.code).toBe("FOREIGN_WORKSPACE");
  });

  it("AC-013-01: bound workspaceId create succeeds (Hub register; DOM may be deferred)", async () => {
    const { app } = appWithWorkspace(
      "/data/projects/cursor_mobile",
      "extractor_stale",
    );
    const token = await pair(app);
    const ws = await request(app)
      .get("/workspace")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const res = await request(app)
      .post("/sessions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "phase0-create-1")
      .send({ workspaceId: ws.body.workspaceId, model: "composer" })
      .expect(201);
    expect(res.body.workspaceId).toBe(ws.body.workspaceId);
    expect(res.body.id).toMatch(/^sess_live_/);
    expect(res.body.mode).toBe("live");
    expect(res.body.domApplied).toBe(false);
  });
});
