/**
 * Phase 0 — Pairing (FR-002) + auth gate
 */
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createMockLiveCursorAdapter } from "@cursor-mobile/live-cursor";
import { createApp } from "../../src/app.js";
import { createHubContext, loadConfig } from "../../src/config.js";
import { REPO_ROOT } from "../repo-root.js";

function freshApp(cursorWorkspace: string | null = null) {
  const config = loadConfig({
    ...process.env,
    CURSOR_WORKSPACE: cursorWorkspace ?? "",
    PAIRING_REQUIRED: "true",
  });
  config.cursorWorkspace = cursorWorkspace;
  const ctx = createHubContext(config, {
    live: createMockLiveCursorAdapter({ healthState: "cursor_down" }),
  });
  return { app: createApp(ctx), ctx };
}

async function pairDevice(app: ReturnType<typeof createApp>) {
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
  return {
    deviceToken: confirm.body.deviceToken as string,
    deviceId: confirm.body.deviceId as string,
    code: start.body.code as string,
    pairId: start.body.pairId as string,
  };
}

describe("phase0 / pair (FR-002)", () => {
  it("AC-002-01: valid pair code issues device token", async () => {
    const { app } = freshApp(REPO_ROOT);
    const paired = await pairDevice(app);
    expect(paired.deviceToken.length).toBeGreaterThan(16);

    const ws = await request(app)
      .get("/workspace")
      .set("authorization", `Bearer ${paired.deviceToken}`)
      .expect(200);
    expect(ws.body.workspaceId).toMatch(/^ws_/);
    expect(ws.body.path).toBe(REPO_ROOT);
  });

  it("AC-002-02: GET /workspace without pair → 401", async () => {
    const { app } = freshApp();
    const res = await request(app).get("/workspace").expect(401);
    expect(res.body.error.code).toMatch(/UNAUTHORIZED|DEVICE_REVOKED/);
  });

  it("AC-002-03: expired pair code → clear error; no token", async () => {
    const { app, ctx } = freshApp();
    const start = await request(app).post("/pair/start").send({}).expect(201);
    const pending = ctx.pairing.findPending(start.body.code);
    expect(pending).toBeTruthy();
    if (pending) {
      pending.expiresAt = new Date(Date.now() - 1_000);
    }

    const res = await request(app)
      .post("/pair/confirm")
      .send({
        code: start.body.code,
        pairId: start.body.pairId,
        deviceName: "Pixel-test",
        platform: "android",
        appVersion: "0.0.0",
      })
      .expect(410);
    expect(res.body.error.code).toBe("PAIR_CODE_EXPIRED");
  });

  it("AC-002-04: re-pair after revoke — new token works; old rejected", async () => {
    const { app, ctx } = freshApp(REPO_ROOT);
    const first = await pairDevice(app);
    expect(ctx.pairing.revokeByToken(first.deviceToken)).toBe(true);

    await request(app)
      .get("/workspace")
      .set("authorization", `Bearer ${first.deviceToken}`)
      .expect(401);

    const second = await pairDevice(app);
    expect(second.deviceToken).not.toBe(first.deviceToken);
    await request(app)
      .get("/workspace")
      .set("authorization", `Bearer ${second.deviceToken}`)
      .expect(200);
  });

  it("AC-003-03: invalid/missing pair → unauthorized workspace", async () => {
    const { app } = freshApp();
    const res = await request(app)
      .get("/workspace")
      .set("authorization", "Bearer not-a-real-token")
      .expect(401);
    expect(res.body.error).toBeTruthy();
  });
});
