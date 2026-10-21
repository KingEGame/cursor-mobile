/**
 * Multi-PC pairing: the Hub names itself, the QR carries that identity, wrong codes explain
 * themselves (restart vs other PC vs typo), and guessing codes over the mesh is throttled.
 */
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createMockLiveCursorAdapter } from "@cursor-mobile/live-cursor";
import { createApp } from "../../src/app.js";
import {
  buildQrPayload,
  computeHubId,
  createHubContext,
  defaultHubDisplayName,
  loadConfig,
  PairingStore,
} from "../../src/config.js";
import { PairAttemptLimiter } from "../../src/pair-limiter.js";
import { qrTarget } from "../../src/pair-page.js";

function freshApp(env: Record<string, string> = {}, limiter?: PairAttemptLimiter) {
  const config = loadConfig({
    ...process.env,
    CURSOR_WORKSPACE: "",
    PAIRING_REQUIRED: "true",
    HUB_DATA_DIR: "",
    TAILSCALE_HOSTNAME: "100.64.0.9",
    ...env,
  });
  config.cursorWorkspace = null;
  const ctx = createHubContext(config, {
    live: createMockLiveCursorAdapter({ healthState: "cursor_down" }),
    ...(limiter ? { pairLimiter: limiter } : {}),
  });
  return { app: createApp(ctx), ctx };
}

const phone = { deviceName: "Pixel", platform: "android", appVersion: "0.1.8" };

describe("Hub identity", () => {
  it("defaults the display name to the short hostname", () => {
    expect(defaultHubDisplayName("kingwarpc.local")).toBe("kingwarpc");
    expect(defaultHubDisplayName("  ")).toBe("PC");
    expect(loadConfig({ HUB_DISPLAY_NAME: "Laptop", HUB_DATA_DIR: "" }).hubDisplayName).toBe("Laptop");
  });

  it("hubId is stable per host + data dir and differs across PCs", () => {
    expect(computeHubId("/a", "pc1")).toBe(computeHubId("/a", "PC1"));
    expect(computeHubId("/a", "pc1")).not.toBe(computeHubId("/a", "pc2"));
    expect(computeHubId("/a", "pc1")).not.toBe(computeHubId("/b", "pc1"));
    expect(computeHubId("/a", "pc1")).toMatch(/^[0-9a-f]{12}$/);
  });

  it("QR payload names the PC and carries the hub id next to host/code", () => {
    const { ctx } = freshApp({ HUB_DISPLAY_NAME: "Desk Tower" });
    const pending = ctx.pairing.start({ ttlSec: 60, label: ctx.config.hubDisplayName });
    const payload = buildQrPayload(ctx.config, pending, () => null);
    const qs = new URL(payload.replace("cursor-companion://", "http://")).searchParams;
    expect(qs.get("host")).toBe("100.64.0.9");
    expect(qs.get("name")).toBe("Desk Tower");
    expect(qs.get("hub")).toBe(ctx.config.hubId);
    expect(qrTarget(payload)).toEqual({ host: "100.64.0.9", port: "8787" });
  });

  it("GET /health and pair/complete report displayName + hubId", async () => {
    const { app, ctx } = freshApp({ HUB_DISPLAY_NAME: "Desk Tower" });
    const health = await request(app).get("/v1/health").expect(200);
    expect(health.body.hub.displayName).toBe("Desk Tower");
    expect(health.body.hub.hubId).toBe(ctx.config.hubId);

    const start = await request(app).post("/v1/pair/start").send({}).expect(201);
    const done = await request(app)
      .post("/v1/pair/complete")
      .send({ code: start.body.code, pairId: start.body.pairId, ...phone })
      .expect(201);
    expect(done.body.hub.displayName).toBe("Desk Tower");
    expect(done.body.hub.hubId).toBe(ctx.config.hubId);
  });
});

describe("wrong pair codes explain themselves", () => {
  it("unknown pairId → restarted-or-other-PC message", async () => {
    const { app } = freshApp({ HUB_DISPLAY_NAME: "Desk Tower" });
    const res = await request(app)
      .post("/v1/pair/complete")
      .send({ code: "123456", pairId: "pair_from_other_pc", ...phone })
      .expect(400);
    expect(res.body.error.code).toBe("PAIR_CODE_INVALID");
    expect(res.body.error.details.reason).toBe("unknown_pair");
    expect(res.body.error.message).toMatch(/another PC|restarted/);
    expect(res.body.error.message).toContain("Desk Tower");
  });

  it("known pairId with a different code → mismatch", async () => {
    const { app } = freshApp();
    const start = await request(app).post("/v1/pair/start").send({}).expect(201);
    const wrong = start.body.code === "000000" ? "000001" : "000000";
    const res = await request(app)
      .post("/v1/pair/complete")
      .send({ code: wrong, pairId: start.body.pairId, ...phone })
      .expect(400);
    expect(res.body.error.details.reason).toBe("code_mismatch");
  });

  it("manual code that matches nothing → unknown_code, and the right manual code pairs", async () => {
    const { app } = freshApp();
    const start = await request(app).post("/v1/pair/start").send({}).expect(201);
    const bad = await request(app)
      .post("/v1/pair/complete")
      .send({ code: "999999", ...phone })
      .expect(400);
    expect(bad.body.error.details.reason).toBe("unknown_code");
    await request(app)
      .post("/v1/pair/complete")
      .send({ code: start.body.code, ...phone })
      .expect(201);
  });

  it("expired codes are swept after the grace period, not before", () => {
    const store = new PairingStore({ persistPath: null });
    // Negative TTL: already expired, without sleeping in the test.
    const p = store.start({ ttlSec: -1, label: "x" });
    const expiredAt = p.expiresAt.getTime();
    expect(store.sweepExpired(expiredAt + 1_000)).toBe(0);
    expect(store.pendingStatus(p.pairId)).toBe("expired");
    expect(store.sweepExpired(expiredAt + 11 * 60_000)).toBe(1);
    expect(store.pendingStatus(p.pairId)).toBe("unknown");
  });
});

describe("pair/complete throttling", () => {
  it("limiter blocks after max failures inside the window and clears on success", () => {
    let t = 0;
    const lim = new PairAttemptLimiter({ maxFailures: 3, windowMs: 1000, now: () => t });
    expect(lim.retryAfterSec("a")).toBe(0);
    lim.recordFailure("a"); lim.recordFailure("a");
    expect(lim.retryAfterSec("a")).toBe(0);
    lim.recordFailure("a");
    expect(lim.retryAfterSec("a")).toBe(1);
    expect(lim.retryAfterSec("b")).toBe(0);
    t = 1500;
    expect(lim.retryAfterSec("a")).toBe(0);
    lim.recordFailure("a"); lim.recordFailure("a"); lim.recordFailure("a");
    lim.clear("a");
    expect(lim.retryAfterSec("a")).toBe(0);
  });

  it("HTTP: wrong codes → 429 RATE_LIMITED with Retry-After; a good code after the window pairs", async () => {
    let t = 0;
    const lim = new PairAttemptLimiter({ maxFailures: 2, windowMs: 60_000, now: () => t });
    const { app } = freshApp({}, lim);
    const start = await request(app).post("/v1/pair/start").send({}).expect(201);
    for (let i = 0; i < 2; i += 1) {
      await request(app).post("/v1/pair/complete").send({ code: "000000", ...phone }).expect(400);
    }
    const blocked = await request(app)
      .post("/v1/pair/complete")
      .send({ code: start.body.code, pairId: start.body.pairId, ...phone })
      .expect(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    expect(blocked.body.error.details.bucket).toBe("pair");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    t = 61_000;
    await request(app)
      .post("/v1/pair/complete")
      .send({ code: start.body.code, pairId: start.body.pairId, ...phone })
      .expect(201);
  });
});

describe("GET /pair page", () => {
  it("names the PC, shows the manual address + code, and warns when no mesh address exists", async () => {
    const named = freshApp({ HUB_DISPLAY_NAME: "Desk Tower" });
    const page = await request(named.app).get("/pair").expect(200);
    expect(page.text).toContain("Desk Tower");
    expect(page.text).toContain("100.64.0.9:8787");
    expect(page.text).toMatch(/manual-code">\d{6}</);
    expect(page.text).not.toContain("No Tailscale address found");

    // Pin the advertised host to loopback: on a PC with Tailscale up, auto-detect would find a mesh IP.
    const bare = freshApp({ TAILSCALE_HOSTNAME: "127.0.0.1", HUB_HOST: "127.0.0.1" });
    const warn = await request(bare.app).get("/pair").expect(200);
    expect(warn.text).toContain("No Tailscale address found");
  });

  it("status says unknown for a pairId this process never issued", async () => {
    const { app } = freshApp();
    const res = await request(app).get("/pair/status?pairId=pair_gone").expect(200);
    expect(res.body.status).toBe("unknown");
  });
});
