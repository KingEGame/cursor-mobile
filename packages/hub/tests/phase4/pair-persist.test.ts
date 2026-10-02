/**
 * Phase 4 — Pairing persist (NFR-REL-06) + local-only pair/start (TOR-03)
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createMockLiveCursorAdapter } from "@cursor-mobile/live-cursor";
import { createApp } from "../../src/app.js";
import {
  createHubContext,
  loadConfig,
  PairingStore,
} from "../../src/config.js";
import {
  isLoopbackAddress,
  isLocalClient,
  requireLocal,
} from "../../src/local-guard.js";
import {
  devicesFilePath,
  loadDevicesFromDisk,
} from "../../src/pairing-persist.js";
import { ApiError } from "../../src/errors.js";
import type { Request, Response, NextFunction } from "express";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hub-pair-persist-"));
  tempDirs.push(dir);
  return dir;
}

describe("isLoopbackAddress / local guard", () => {
  it("accepts loopback forms", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("localhost")).toBe(true);
    expect(isLoopbackAddress(undefined)).toBe(true);
    expect(isLoopbackAddress("")).toBe(true);
  });

  it("rejects Tailscale / LAN peers", () => {
    expect(isLoopbackAddress("100.64.1.2")).toBe(false);
    expect(isLoopbackAddress("10.0.0.5")).toBe(false);
    expect(isLoopbackAddress("192.168.1.10")).toBe(false);
  });

  it("requireLocal next(FORBIDDEN) for non-loopback", () => {
    const mw = requireLocal();
    const req = {
      socket: { remoteAddress: "100.64.0.1" },
      ip: "100.64.0.1",
    } as unknown as Request;
    let err: unknown;
    const next: NextFunction = (e?: unknown) => {
      err = e;
    };
    mw(req, {} as Response, next);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).code).toBe("FORBIDDEN");
  });

  it("isLocalClient true for in-process / missing address", () => {
    const req = { socket: {}, ip: undefined } as unknown as Request;
    expect(isLocalClient(req)).toBe(true);
  });
});

describe("PairingStore disk persist", () => {
  it("survives Hub restart via data/devices.json", () => {
    const dataDir = tempDataDir();
    const path = devicesFilePath(dataDir);

    const store1 = new PairingStore({ dataDir });
    const pending = store1.start({ ttlSec: 300, label: "Desk" });
    const device = store1.complete(pending, {
      deviceName: "Pixel",
      platform: "android",
      appVersion: "0.1.0",
      tokenTtlSec: null,
    });

    const onDisk = loadDevicesFromDisk(path);
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]?.deviceId).toBe(device.deviceId);
    // Token present on disk but never asserted in logs
    expect(onDisk[0]?.deviceToken).toBe(device.deviceToken);
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);

    const store2 = new PairingStore({ dataDir });
    expect(store2.pairedCount()).toBe(1);
    expect(store2.authenticate(device.deviceToken)?.deviceId).toBe(
      device.deviceId,
    );

    expect(store2.revokeByToken(device.deviceToken)).toBe(true);
    const store3 = new PairingStore({ dataDir });
    expect(store3.authenticate(device.deviceToken)).toBeNull();
    expect(store3.pairedCount()).toBe(0);
  });

  it("HUB_DATA_DIR=none keeps pairing in-memory only", () => {
    const config = loadConfig({
      HUB_DATA_DIR: "none",
      PAIRING_REQUIRED: "true",
    });
    expect(config.hubDataDir).toBeNull();
    const store = new PairingStore({ dataDir: config.hubDataDir });
    expect(store.getPersistPath()).toBeNull();
  });
});

describe("POST /pair/start local-only (TOR-03)", () => {
  it("allows in-process / loopback start (supertest)", async () => {
    const config = loadConfig({
      HUB_DATA_DIR: "none",
      PAIRING_REQUIRED: "true",
      CURSOR_WORKSPACE: "",
    });
    const ctx = createHubContext(config, {
      live: createMockLiveCursorAdapter({ healthState: "cursor_down" }),
      pairing: new PairingStore(),
    });
    const app = createApp(ctx);
    const res = await request(app).post("/pair/start").send({}).expect(201);
    expect(res.body.code).toMatch(/^\d{6}$/);
  });

  it("rejects forged non-loopback via middleware unit path", () => {
    // Integration: Express+supertest cannot easily spoof remoteAddress;
    // covered by requireLocal unit test above (FORBIDDEN).
    expect(isLoopbackAddress("100.100.100.100")).toBe(false);
  });
});
