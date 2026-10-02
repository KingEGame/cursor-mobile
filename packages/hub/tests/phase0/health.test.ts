/**
 * Phase 0 — Health (FR-004 / TOR-08 AC-004-*)
 */
import { describe, expect, it } from "vitest";
import request from "supertest";
import {
  createLiveCursorAdapter,
  createMockLiveCursorAdapter,
} from "@cursor-mobile/live-cursor";
import { createApp } from "../../src/app.js";
import { createHubContext, loadConfig } from "../../src/config.js";

function testCtx(overrides?: {
  cursorWorkspace?: string | null;
  liveProbe?: "connected" | "disconnected";
}) {
  const config = loadConfig({
    ...process.env,
    CURSOR_WORKSPACE: overrides?.cursorWorkspace ?? "",
    PAIRING_REQUIRED: "true",
  });
  config.cursorWorkspace = overrides?.cursorWorkspace ?? null;

  const live =
    overrides?.liveProbe === "connected"
      ? createMockLiveCursorAdapter({
          healthState: "extractor_stale",
          windowsDetected: 1,
        })
      : createMockLiveCursorAdapter({
          healthState: "cursor_down",
        });

  return createHubContext(config, { live });
}

describe("phase0 / health (FR-004)", () => {
  it("AC-004-01: Hub+CDP OK → health reports hub up + CDP connected", async () => {
    const ctx = testCtx({
      liveProbe: "connected",
      cursorWorkspace: "/data/projects/cursor_mobile",
    });
    const res = await request(createApp(ctx)).get("/health").expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.hub.status).toBe("up");
    expect(res.body.cdp.status).toBe("connected");
    expect(res.body.liveAdapter.state).toBe("extractor_stale");
    expect(res.body.workspace.bound).toBe(true);
    expect(res.body.workspace.workspaceId).toMatch(/^ws_/);
  });

  it("AC-004-02: CDP off, Hub up → hub up + CDP disconnected", async () => {
    const ctx = testCtx({ liveProbe: "disconnected", cursorWorkspace: null });
    const res = await request(createApp(ctx)).get("/v1/health").expect(200);
    expect(res.body.hub.status).toBe("up");
    expect(res.body.cdp.status).toBe("disconnected");
    expect(res.body.liveAdapter.state).toBe("cursor_down");
    expect(res.body.workspace.bound).toBe(false);
    expect(res.body.workspace.workspaceId).toBeNull();
  });

  it("health payload never includes pair codes or device tokens", async () => {
    const ctx = testCtx({ liveProbe: "disconnected" });
    const start = await request(createApp(ctx))
      .post("/pair/start")
      .send({})
      .expect(201);
    const code = start.body.code as string;

    const confirm = await request(createApp(ctx))
      .post("/pair/confirm")
      .send({
        code,
        pairId: start.body.pairId,
        deviceName: "Pixel-test",
        platform: "android",
        appVersion: "0.0.0",
      })
      .expect(201);

    const healthText = JSON.stringify(
      (await request(createApp(ctx)).get("/health").expect(200)).body,
    );
    expect(healthText).not.toContain(code);
    expect(healthText).not.toContain(confirm.body.deviceToken);
  });

  it("AC-001-03: live adapter rejects non-loopback CDP URL", () => {
    expect(() =>
      createLiveCursorAdapter("http://100.64.1.2:9222"),
    ).toThrow(/loopback/i);
    expect(() => createLiveCursorAdapter("http://127.0.0.1:9222")).not.toThrow();
  });
});
