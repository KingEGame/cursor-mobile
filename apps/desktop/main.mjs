/**
 * Electron main process — starts the embedded Hub on this PC and shows a status UI.
 * Product locks: Hub + CDP stay on the operator PC; phone is remote UI over Tailscale.
 */
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('electron').BrowserWindow | null} */
let mainWindow = null;
/** @type {{ close: () => Promise<void> } | null} */
let hubHandle = null;
/** @type {Record<string, unknown>} */
let lastStatus = {
  running: false,
  listenUrl: null,
  cdpUrl: null,
  workspace: null,
  liveState: null,
  tailscaleHint: null,
  error: null,
  pairUrl: null,
  healthUrl: null,
};

function defaultDataDir() {
  return join(homedir(), ".cursor-mobile", "hub-data");
}

function applyDefaultEnv() {
  if (!process.env.HUB_HOST?.trim()) process.env.HUB_HOST = "0.0.0.0";
  if (!process.env.HUB_PORT?.trim()) process.env.HUB_PORT = "8787";
  if (!process.env.CDP_URL?.trim()) process.env.CDP_URL = "http://127.0.0.1:9222";
  if (!process.env.HUB_DATA_DIR?.trim()) process.env.HUB_DATA_DIR = defaultDataDir();
  if (!process.env.HUB_DISPLAY_NAME?.trim()) process.env.HUB_DISPLAY_NAME = "Desk PC";
  mkdirSync(process.env.HUB_DATA_DIR, { recursive: true });
}

async function detectTailscaleHint() {
  try {
    const { stdout } = await execFileAsync("tailscale", ["ip", "-4"], {
      timeout: 3000,
      windowsHide: true,
    });
    const ip = stdout.trim().split(/\s+/)[0];
    if (ip) return ip;
  } catch {
    /* optional */
  }
  return process.env.TAILSCALE_HOSTNAME?.trim() || null;
}

async function loadHubApi() {
  const vendor = join(__dirname, "vendor", "hub-bundle.mjs");
  if (existsSync(vendor)) {
    return import(pathToFileURL(vendor).href);
  }
  // Dev fallback: monorepo ESM package (npm run build first).
  return import("@cursor-mobile/hub");
}

async function startHub() {
  applyDefaultEnv();
  const hub = await loadHubApi();
  const config = hub.loadConfig(process.env);
  const ctx = hub.createHubContext(config);
  const server = hub.createHubServer(ctx);
  await server.listen();
  hubHandle = server;

  const port = config.hubPort;
  const listenUrl = `http://127.0.0.1:${port}`;
  const ts = await detectTailscaleHint();
  lastStatus = {
    running: true,
    listenUrl,
    meshHint: ts ? `http://${ts}:${port}` : null,
    cdpUrl: config.cdpUrl,
    workspace: config.cursorWorkspace,
    liveState: null,
    tailscaleHint: ts,
    error: null,
    pairUrl: `http://127.0.0.1:${port}/pair`,
    healthUrl: `http://127.0.0.1:${port}/v1/health`,
  };
  await refreshLiveState(ctx);
  broadcastStatus();
  return { config, ctx };
}

async function refreshLiveState(ctx) {
  try {
    const health = await ctx.live.getHealth();
    lastStatus = { ...lastStatus, liveState: health.state };
  } catch (err) {
    lastStatus = {
      ...lastStatus,
      liveState: "unknown",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function broadcastStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("hub:status", lastStatus);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 560,
    height: 640,
    minWidth: 420,
    minHeight: 520,
    title: "Cursor Mobile Hub",
    backgroundColor: "#f4f5f7",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(join(__dirname, "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.handle("hub:status", async () => lastStatus);
ipcMain.handle("hub:refresh", async () => {
  if (hubHandle && lastStatus.running && lastStatus.healthUrl) {
    try {
      const res = await fetch(String(lastStatus.healthUrl));
      if (res.ok) {
        const body = await res.json();
        lastStatus = {
          ...lastStatus,
          liveState: body?.liveAdapter?.state ?? body?.state ?? lastStatus.liveState,
          error: null,
        };
      }
    } catch (err) {
      lastStatus = {
        ...lastStatus,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  broadcastStatus();
  return lastStatus;
});
ipcMain.handle("hub:open-pair", async () => {
  const url = lastStatus.pairUrl;
  if (url) await shell.openExternal(String(url));
  return { ok: Boolean(url) };
});
ipcMain.handle("hub:open-health", async () => {
  const url = lastStatus.healthUrl;
  if (url) await shell.openExternal(String(url));
  return { ok: Boolean(url) };
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    createWindow();
    try {
      await startHub();
    } catch (err) {
      lastStatus = {
        ...lastStatus,
        running: false,
        error: err instanceof Error ? err.message : String(err),
      };
      broadcastStatus();
    }
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", () => {
    void hubHandle?.close?.();
  });
}
