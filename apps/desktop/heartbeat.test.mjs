import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHeartbeat } from "./heartbeat.mjs";
import { createLogger } from "./logger.mjs";
import { runDiagnostics } from "./diagnostics.mjs";
import { desktopEntry } from "./autostart.mjs";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("heartbeat", () => {
  it("declares the Hub dead only after N consecutive misses", async () => {
    let ok = false;
    let dead = 0;
    const hb = createHeartbeat({ ping: async () => ok, onDead: () => dead++, maxMisses: 3 });
    await hb.tick(); await hb.tick();
    assert.equal(dead, 0);
    ok = true; await hb.tick();
    ok = false; await hb.tick(); await hb.tick();
    assert.equal(dead, 0, "a good ping resets the streak");
    await hb.tick();
    assert.equal(dead, 1);
  });
  it("treats a throwing ping as a miss", async () => {
    let dead = 0;
    const hb = createHeartbeat({ ping: async () => { throw new Error("x"); }, onDead: () => dead++, maxMisses: 2 });
    await hb.tick(); await hb.tick();
    assert.equal(dead, 1);
  });
});

describe("logger", () => {
  it("prefixes lines and rotates by size", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-"));
    const log = createLogger(dir, { now: () => new Date("2026-01-01T00:00:00Z") });
    log.write("hub", "a\nb");
    assert.match(readFileSync(log.file, "utf8"), /2026-01-01T00:00:00.000Z \[hub\] a\n.*\[hub\] b\n/);
    writeFileSync(log.file, "x".repeat(1_100_000));
    log.write("hub", "after");
    assert.ok(existsSync(`${log.file}.1`));
    assert.match(readFileSync(log.file, "utf8"), /after/);
  });
});

describe("diagnostics", () => {
  const running = { running: true, listenUrl: "http://127.0.0.1:8787", tailscaleHint: "100.1.2.3", liveState: "cursor_down" };
  it("flags a missing Tailscale address", async () => {
    const r = await runDiagnostics({ status: { ...running, tailscaleHint: null }, platform: "linux" });
    assert.equal(r.find((c) => c.id === "tailscale").ok, false);
    assert.ok(!r.find((c) => c.id === "reachable"));
  });
  it("points at the firewall on Windows when the mesh address is unreachable", async () => {
    const r = await runDiagnostics({ status: running, platform: "win32", fetchImpl: async () => { throw new Error("timeout"); } });
    const c = r.find((x) => x.id === "reachable");
    assert.equal(c.ok, false);
    assert.match(c.detail, /firewall/i);
  });
  it("passes when everything answers", async () => {
    const r = await runDiagnostics({ status: { ...running, liveState: "cdp_ok" }, platform: "linux", fetchImpl: async () => ({ ok: true, status: 200 }) });
    assert.ok(r.every((c) => c.ok === true));
  });
});

describe("autostart", () => {
  it("launches hidden", () => assert.match(desktopEntry("/x/app"), /Exec="\/x\/app" --hidden/));
});
