/**
 * Hub child process — runs the Hub OFF the Electron main process so slow synchronous work
 * (SQLite reads of Cursor's state.vscdb, history scans, CDP calls) can never freeze the window.
 *
 * Forked by main.mjs with ELECTRON_RUN_AS_NODE=1 (plain Node semantics, IPC via process.send).
 * Protocol: see hub-supervisor.mjs. Product locks unchanged: Hub + CDP stay on this PC.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

/** The CDP probe may hang on a wedged Cursor; the first status must not wait for it. */
const LIVE_PROBE_TIMEOUT_MS = 4000;
const LIVE_REFRESH_MS = 15_000;

/** Where the Windows/macOS installers put the Tailscale CLI (often not on PATH). */
const TAILSCALE_CLI = [
  "tailscale",
  "C:\\Program Files\\Tailscale\\tailscale.exe",
  "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

function send(message) {
  if (process.connected) process.send?.(message);
}

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

/** Tailscale address of this PC: network interfaces first (no CLI), then the CLI, then env. */
async function detectTailscaleHint(hub) {
  try {
    const ip = hub?.detectTailscaleIp?.();
    if (ip) return ip;
  } catch {
    /* fall through to the CLI */
  }
  for (const bin of TAILSCALE_CLI) {
    try {
      const { stdout } = await execFileAsync(bin, ["ip", "-4"], { timeout: 3000, windowsHide: true });
      const ip = stdout.trim().split(/\s+/)[0];
      if (ip) return ip;
    } catch {
      /* try the next location */
    }
  }
  return process.env.TAILSCALE_HOSTNAME?.trim() || null;
}

async function loadHubApi() {
  const vendor = join(__dirname, "vendor", "hub-bundle.mjs");
  if (existsSync(vendor)) return import(pathToFileURL(vendor).href);
  // Dev fallback: monorepo ESM package (npm run build first).
  return import("@cursor-mobile/hub");
}

/** Resolve with { liveState, error } — never rejects and never takes longer than the timeout. */
function probeLive(ctx) {
  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve({ liveState: "unknown", error: `CDP probe timed out after ${LIVE_PROBE_TIMEOUT_MS / 1000}s` }), LIVE_PROBE_TIMEOUT_MS).unref(),
  );
  const probe = (async () => {
    try {
      const health = await ctx.live.getHealth();
      return { liveState: health.state, error: null };
    } catch (err) {
      return { liveState: "unknown", error: errText(err) };
    }
  })();
  return Promise.race([probe, timeout]);
}

async function main() {
  const hub = await loadHubApi();
  const config = hub.loadConfig(process.env);
  const ctx = hub.createHubContext(config);
  const server = hub.createHubServer(ctx);
  await server.listen();

  const port = config.hubPort;
  const ts = await detectTailscaleHint(hub);
  // First status goes out now: liveState is filled in by the time-boxed probe below.
  send({
    type: "ready",
    status: {
      listenUrl: `http://127.0.0.1:${port}`,
      meshHint: ts ? `http://${ts}:${port}` : null,
      cdpUrl: config.cdpUrl,
      workspace: config.cursorWorkspace,
      liveState: null,
      tailscaleHint: ts,
      error: null,
      pairUrl: `http://127.0.0.1:${port}/pair`,
      healthUrl: `http://127.0.0.1:${port}/v1/health`,
    },
  });

  const refreshLive = async () => {
    const [live, tsNow] = await Promise.all([probeLive(ctx), detectTailscaleHint(hub)]);
    send({ type: "live", ...live, tailscaleHint: tsNow, meshHint: tsNow ? `http://${tsNow}:${port}` : null });
  };
  void refreshLive();
  setInterval(refreshLive, LIVE_REFRESH_MS).unref();

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await Promise.race([server.close?.(), new Promise((r) => setTimeout(r, 3000))]);
    } finally {
      process.exit(0);
    }
  };
  process.on("message", (m) => {
    if (m?.type === "shutdown") void shutdown();
    if (m?.type === "refresh") void refreshLive();
  });
  // Parent gone (crash / force-quit): never leave an orphan Hub holding the port.
  process.on("disconnect", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  send({ type: "fatal", error: errText(err) });
  // Let the message flush before exiting so the supervisor can show the cause.
  setTimeout(() => process.exit(1), 100);
});
