/**
 * Phase 4 — phone self-update feed (GET /v1/app/latest, /v1/app/apk). PC-local only.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createMockLiveCursorAdapter } from "@cursor-mobile/live-cursor";
import { createApp } from "../../src/app.js";
import { createHubContext, loadConfig } from "../../src/config.js";
import { hashFile, parseManifest } from "../../src/app-release.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hub-app-release-"));
  tempDirs.push(dir);
  return dir;
}

function freshApp(releasesDir: string | null) {
  const config = loadConfig({ ...process.env, PAIRING_REQUIRED: "true", HUB_DATA_DIR: "" });
  config.hubReleasesDir = releasesDir;
  const ctx = createHubContext(config, {
    live: createMockLiveCursorAdapter({ healthState: "cursor_down" }),
  });
  return createApp(ctx);
}

async function pairToken(app: ReturnType<typeof createApp>): Promise<string> {
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

async function publishFake(dir: string, overrides: Record<string, unknown> = {}) {
  const apkPath = join(dir, "cursor-mobile-0.1.1-101.apk");
  writeFileSync(apkPath, Buffer.from("PK\u0003\u0004 fake apk bytes for tests"));
  const h = await hashFile(apkPath);
  const manifest = {
    versionName: "0.1.1",
    versionCode: 101,
    apkFile: "cursor-mobile-0.1.1-101.apk",
    sizeBytes: h.sizeBytes,
    sha256: h.sha256,
    md5: h.md5,
    publishedAt: "2026-10-01T12:00:00.000Z",
    notes: ["Self-update from Account"],
    gitSha: "abc1234",
    ciRunUrl: null,
    testsPassed: 214,
    source: "local",
    ...overrides,
  };
  writeFileSync(join(dir, "latest.json"), JSON.stringify(manifest));
  return { manifest, bytes: h.sizeBytes };
}

describe("phase4 / app self-update feed", () => {
  it("requires a paired device token", async () => {
    const app = freshApp(tempDir());
    await request(app).get("/v1/app/latest").expect(401);
    await request(app).get("/v1/app/apk").expect(401);
  });

  it("reports available:false when nothing is published", async () => {
    const app = freshApp(tempDir());
    const token = await pairToken(app);
    const res = await request(app)
      .get("/v1/app/latest")
      .set("authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body).toMatchObject({ available: false, reason: "NO_RELEASE" });
    await request(app).get("/v1/app/apk").set("authorization", `Bearer ${token}`).expect(404);
  });

  it("reports available:false when the releases dir is disabled", async () => {
    const app = freshApp(null);
    const token = await pairToken(app);
    const res = await request(app)
      .get("/v1/app/latest")
      .set("authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.reason).toBe("NO_RELEASES_DIR");
  });

  it("serves manifest and APK bytes for a valid release", async () => {
    const dir = tempDir();
    const { manifest, bytes } = await publishFake(dir);
    const app = freshApp(dir);
    const token = await pairToken(app);

    const latest = await request(app)
      .get("/v1/app/latest")
      .set("authorization", `Bearer ${token}`)
      .expect(200);
    expect(latest.body).toMatchObject({
      available: true,
      versionName: "0.1.1",
      versionCode: 101,
      sha256: manifest.sha256,
      md5: manifest.md5,
      sizeBytes: bytes,
      testsPassed: 214,
      downloadPath: "/v1/app/apk",
    });
    // The on-disk file name is an implementation detail; never leak it.
    expect(latest.body.apkFile).toBeUndefined();

    const apk = await request(app)
      .get("/v1/app/apk")
      .set("authorization", `Bearer ${token}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(apk.headers["content-type"]).toBe("application/vnd.android.package-archive");
    expect(apk.headers["x-app-sha256"]).toBe(manifest.sha256);
    expect((apk.body as Buffer).length).toBe(bytes);
  });

  it("refuses a half-copied APK (size mismatch)", async () => {
    const dir = tempDir();
    await publishFake(dir, { sizeBytes: 999_999 });
    const app = freshApp(dir);
    const token = await pairToken(app);
    const res = await request(app)
      .get("/v1/app/latest")
      .set("authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body).toMatchObject({ available: false, reason: "APK_MISMATCH" });
  });

  it("refuses an APK that is missing on disk", async () => {
    const dir = tempDir();
    await publishFake(dir, { apkFile: "gone.apk" });
    const app = freshApp(dir);
    const token = await pairToken(app);
    const res = await request(app)
      .get("/v1/app/latest")
      .set("authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.reason).toBe("APK_MISSING");
  });
});

describe("parseManifest", () => {
  const good = {
    versionName: "0.1.1",
    versionCode: 101,
    apkFile: "a.apk",
    sizeBytes: 10,
    sha256: "a".repeat(64),
    md5: "b".repeat(32),
  };

  it("accepts a minimal valid manifest", () => {
    expect(parseManifest(good)?.versionCode).toBe(101);
  });

  it("rejects path traversal in apkFile", () => {
    expect(parseManifest({ ...good, apkFile: "../../etc/passwd.apk" })).toBeNull();
    expect(parseManifest({ ...good, apkFile: "sub/a.apk" })).toBeNull();
  });

  it("rejects non-apk files, bad hashes and bad version codes", () => {
    expect(parseManifest({ ...good, apkFile: "a.sh" })).toBeNull();
    expect(parseManifest({ ...good, sha256: "xyz" })).toBeNull();
    expect(parseManifest({ ...good, md5: "a".repeat(64) })).toBeNull();
    expect(parseManifest({ ...good, versionCode: 0 })).toBeNull();
    expect(parseManifest({ ...good, versionCode: 1.5 })).toBeNull();
    expect(parseManifest(null)).toBeNull();
  });
});
