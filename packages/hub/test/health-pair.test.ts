import { describe, expect, it } from "vitest";
import request from "supertest";
import { createMockLiveCursorAdapter } from "@cursor-mobile/live-cursor";
import { createApp } from "../src/app.js";
import {
  createHubContext,
  loadConfig,
  PairingStore,
  type HubConfig,
} from "../src/config.js";

function testConfig(overrides: Partial<HubConfig> = {}): HubConfig {
  return {
    ...loadConfig({
      // Never touch the operator's real data/devices.json from tests.
      HUB_DATA_DIR: "none",
      HUB_HOST: "127.0.0.1",
      HUB_PORT: "8787",
      CDP_URL: "http://127.0.0.1:9222",
      PAIRING_REQUIRED: "true",
      PAIRING_CODE_TTL_SEC: "300",
      HUB_DISPLAY_NAME: "Test Hub",
      TAILSCALE_HOSTNAME: "pc.tailnet.ts.net",
    }),
    ...overrides,
  };
}

describe("GET /health", () => {
  it("returns TOR-03 health shape with hub up and CDP status", async () => {
    const live = createMockLiveCursorAdapter({
      healthState: "extractor_stale",
      windowsDetected: 1,
    });

    const ctx = createHubContext(testConfig({ cursorWorkspace: null }), {
      live,
      pairing: new PairingStore(),
      startedAt: Date.now() - 5_000,
    });
    const app = createApp(ctx);

    const res = await request(app).get("/v1/health").expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.apiVersion).toBe("1");
    expect(res.body.hub.status).toBe("up");
    expect(res.body.hub.uptimeSec).toBeGreaterThanOrEqual(5);
    expect(res.body.cdp.status).toBe("connected");
    expect(res.body.cdp.urlConfigured).toBe("http://127.0.0.1:9222");
    expect(res.body.cursor.status).toBe("running");
    expect(res.body.liveAdapter.state).toBe("extractor_stale");
    expect(res.body.workspace.bound).toBe(false);
    expect(res.body.pairing.required).toBe(true);
    expect(res.body.pairing.devicesPaired).toBe(0);
  });

  it("also serves unversioned /health alias", async () => {
    const ctx = createHubContext(testConfig(), {
      live: createMockLiveCursorAdapter({ healthState: "cursor_down" }),
    });
    const app = createApp(ctx);
    const res = await request(app).get("/health").expect(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("pairing flow", () => {
  it("start → confirm issues a device token; workspace requires Bearer", async () => {
    const ctx = createHubContext(
      testConfig({
        cursorWorkspace: process.cwd(),
      }),
      { live: createMockLiveCursorAdapter({ healthState: "cursor_down" }) },
    );
    const app = createApp(ctx);

    const start = await request(app)
      .post("/v1/pair/start")
      .send({ ttlSec: 300, label: "Desk PC" })
      .expect(201);

    expect(start.body.pairId).toMatch(/^pair_/);
    expect(start.body.code).toMatch(/^\d{6}$/);
    expect(start.body.qrPayload).toContain("cursor-companion://pair?");

    const deny = await request(app).get("/v1/workspace").expect(401);
    expect(deny.body.error.code).toBe("UNAUTHORIZED");

    const confirm = await request(app)
      .post("/v1/pair/confirm")
      .send({
        code: start.body.code,
        pairId: start.body.pairId,
        deviceName: "Pixel Test",
        platform: "android",
        appVersion: "0.1.0",
      })
      .expect(201);

    expect(confirm.body.deviceId).toMatch(/^dev_/);
    expect(confirm.body.deviceToken).toBeTruthy();
    expect(confirm.body.tokenType).toBe("Bearer");
    expect(confirm.body.hub.displayName).toBe("Desk PC");

    const ws = await request(app)
      .get("/v1/workspace")
      .set("Authorization", `Bearer ${confirm.body.deviceToken}`)
      .expect(200);

    expect(ws.body.workspaceId).toMatch(/^ws_/);
    expect(ws.body.path).toBeTruthy();
    expect(ws.body.emptyReason).toBeUndefined();

    await request(app)
      .post("/v1/pair/complete")
      .send({
        code: start.body.code,
        pairId: start.body.pairId,
        deviceName: "Other",
        platform: "android",
        appVersion: "0.1.0",
      })
      .expect(409);
  });

  it("rejects invalid pair codes", async () => {
    const ctx = createHubContext(testConfig(), {
      live: createMockLiveCursorAdapter({ healthState: "cursor_down" }),
    });
    const app = createApp(ctx);

    const res = await request(app)
      .post("/pair/confirm")
      .send({
        code: "000000",
        deviceName: "Pixel",
        platform: "android",
        appVersion: "0.1.0",
      })
      .expect(400);

    expect(res.body.error.code).toBe("PAIR_CODE_INVALID");
  });

  it("returns empty workspace when CURSOR_WORKSPACE unset", async () => {
    const pairing = new PairingStore();
    const pending = pairing.start({ ttlSec: 300, label: "Desk" });
    const device = pairing.complete(pending, {
      deviceName: "Phone",
      platform: "android",
      appVersion: "0.1.0",
      tokenTtlSec: null,
    });

    const ctx = createHubContext(testConfig({ cursorWorkspace: null }), {
      live: createMockLiveCursorAdapter({ healthState: "cursor_down" }),
      pairing,
    });
    const app = createApp(ctx);

    const res = await request(app)
      .get("/v1/workspace")
      .set("Authorization", `Bearer ${device.deviceToken}`)
      .expect(200);

    expect(res.body.workspaceId).toBeNull();
    expect(res.body.emptyReason).toBe("NO_FOLDER_OPEN");
    expect(res.body.roots).toEqual([]);
  });
});
