/**
 * Electron main process — starts the embedded Hub on this PC and shows a status UI.
 * Product locks: Hub + CDP stay on the operator PC; phone is remote UI over Tailscale.
 */
import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
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
/** @type {import('electron').Tray | null} */
let tray = null;
/** True once the operator chose Quit: only then does closing the window stop the Hub. */
let quitting = false;
const ICON_PATH = join(__dirname, "assets", "tray.png");
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

/** Where the Windows installer puts the Tailscale CLI (it is usually not on PATH). */
const TAILSCALE_CLI = [
  "tailscale",
  "C:\\Program Files\\Tailscale\\tailscale.exe",
  "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

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
  const ts = await detectTailscaleHint(hub);
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
    icon: existsSync(ICON_PATH) ? ICON_PATH : undefined,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(join(__dirname, "renderer", "index.html"));
  // Closing the window hides it: the Hub keeps running and the tray icon (or launching the app
  // again) brings the window back. Only Quit stops the Hub.
  mainWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/** Show the status window again, recreating it if it was destroyed. */
function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  broadcastStatus();
}

function quitHub() {
  quitting = true;
  app.quit();
}

/** Tray icon (Windows notification area, Linux StatusNotifier, macOS menu bar). */
function createTray() {
  try {
    const image = existsSync(ICON_PATH) ? nativeImage.createFromPath(ICON_PATH).resize({ width: 22, height: 22 }) : nativeImage.createEmpty();
    tray = new Tray(image);
    tray.setToolTip("Cursor Mobile Hub — running");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Hub", click: showWindow },
        {
          label: "Open pairing page (QR)",
          click: () => {
            if (lastStatus.pairUrl) void shell.openExternal(String(lastStatus.pairUrl));
          },
        },
        { type: "separator" },
        { label: "Quit Hub", click: quitHub },
      ]),
    );
    tray.on("click", showWindow);
    tray.on("double-click", showWindow);
  } catch {
    // No tray on this desktop (e.g. GNOME without an indicator extension): launching the app
    // again still reopens the window through the single-instance handler.
    tray = null;
  }
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
  app.on("second-instance", () => showWindow());
  app.on("activate", () => showWindow());

  app.whenReady().then(async () => {
    createWindow();
    createTray();
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

  // The Hub must outlive its window: stay running until Quit.
  app.on("window-all-closed", () => {});

  app.on("before-quit", () => {
    quitting = true;
    void hubHandle?.close?.();
  });
}
