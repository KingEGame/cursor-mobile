#!/usr/bin/env node
/**
 * Launch a packaged Hub desktop build and wait for /v1/health. Catches what unit tests cannot:
 * asar import of the Hub bundle from the forked child, a disabled RunAsNode fuse, a crashing shell.
 *
 * Usage: node scripts/smoke-desktop.mjs <path-to-AppImage-or-binary> [--port 18787]
 * Linux without DISPLAY: re-run under `xvfb-run -a`.
 * Exit codes: 0 ok · 1 failed · 78 skipped (missing system libraries on the runner).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = process.argv[2];
const portArg = process.argv.indexOf("--port");
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 18787;
if (!bin) {
  console.error("usage: smoke-desktop.mjs <binary> [--port N]");
  process.exit(2);
}

const data = mkdtempSync(join(tmpdir(), "hub-smoke-"));
const child = spawn(bin, ["--no-sandbox", "--hidden"], {
  env: { ...process.env, HUB_PORT: String(port), HUB_HOST: "127.0.0.1", HUB_DATA_DIR: data, APPIMAGE_EXTRACT_AND_RUN: "1" },
  stdio: ["ignore", "inherit", "inherit"],
  detached: true, // own process group: AppImage runners fork the real app, so kill the whole group
});
let exited = null;
child.on("exit", (code) => (exited = code ?? "signal"));

const deadline = Date.now() + 60_000;
let ok = false;
while (Date.now() < deadline && exited === null) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      ok = true;
      break;
    }
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 1000));
}
if (ok) {
  // Still alive a few seconds later? (catches crashes right after startup, e.g. GPU/renderer aborts)
  await new Promise((r) => setTimeout(r, 6000));
  try {
    ok = (await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    ok = false;
  }
}
const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { /* gone */ } };
const logFile = join(data, "logs", "hub.log");
const logged = existsSync(logFile);
killGroup("SIGTERM");
await new Promise((r) => setTimeout(r, 1500));
killGroup("SIGKILL");
rmSync(data, { recursive: true, force: true });
if (ok && !logged) { console.error("smoke: Hub answered but wrote no log file"); process.exit(1); }
if (!ok && exited === 127) {
  // Shell could not load a system library (e.g. libgtk-3 on a headless CI box): not a Hub defect.
  console.warn("smoke: SKIPPED, the app could not start because a system library is missing (exit 127)");
  process.exit(78);
}
if (!ok) {
  console.error(exited !== null ? `smoke: app exited early (${exited})` : "smoke: /v1/health never answered within 60s");
  process.exit(1);
}
console.log("smoke: Hub desktop build answers /v1/health");
