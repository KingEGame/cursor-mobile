/**
 * Electron main process — starts the embedded Hub on this PC and shows a status UI.
 * Product locks: Hub + CDP stay on the operator PC; phone is remote UI over Tailscale.
 */
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, shell, Tray } from "electron";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { fork } from "node:child_process";
import { createSupervisor, initialStatus } from "./hub-supervisor.mjs";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { checkForUpdate, downloadAsset, posixSwapScript, verifyDownload, windowsSwapScript } from "./updater.mjs";
import { createLogger } from "./logger.mjs";
import { createHeartbeat } from "./heartbeat.mjs";
import { runDiagnostics } from "./diagnostics.mjs";
import { getAutostart, HIDDEN_ARG, setAutostart } from "./autostart.mjs";

// The status window is a few text rows: GPU compositing buys nothing and is the usual cause of
// blank/frozen windows on old drivers, VMs and remote desktops. Software rendering is always safe.
app.disableHardwareAcceleration();
// Also skip the GPU process entirely: where it cannot start, Chromium aborts with "GPU process isn't usable".
app.commandLine.appendSwitch("disable-gpu");

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('electron').BrowserWindow | null} */
let mainWindow = null;
/** @type {import('electron').Tray | null} */
let tray = null;
/** True once the operator chose Quit: only then does closing the window stop the Hub. */
let quitting = false;
const ICON_PATH = join(__dirname, "assets", "tray.png");
/** @type {ReturnType<typeof createSupervisor> | null} */
let supervisor = null;
/** @type {ReturnType<typeof createLogger> | null} */
let log = null;
/** @type {ReturnType<typeof createHeartbeat> | null} */
let heartbeat = null;
const startHidden = process.argv.includes(HIDDEN_ARG);
const updatesDir = () => join(process.env.HUB_DATA_DIR || defaultDataDir(), "updates");
/** @type {Record<string, unknown>} */
let lastStatus = initialStatus();

/** @type {Record<string, unknown>} */
let updateState = { phase: "idle", current: app.getVersion() };

function setUpdate(patch) {
  updateState = { ...updateState, ...patch };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("update:state", updateState);
}

async function runCheck() {
  if (["checking", "downloading", "installing"].includes(String(updateState.phase))) return updateState;
  setUpdate({ phase: "checking", message: undefined });
  try {
    const r = await checkForUpdate({ current: app.getVersion(), platform: process.platform, arch: process.arch });
    const wasAvailable = updateState.phase === "available";
    setUpdate(r.available ? { phase: "available", latest: r.latest, asset: r.asset, sumsUrl: r.sumsUrl } : { phase: "up-to-date", latest: r.latest });
    if (r.available && !wasAvailable && Notification.isSupported()) {
      const n = new Notification({ title: "Cursor Mobile Hub", body: `Version ${r.latest} is available` });
      n.on("click", showWindow);
      n.show();
    }
  } catch (err) {
    setUpdate({ phase: "error", message: err instanceof Error ? err.message : String(err) });
  }
  return updateState;
}

/** Download the new build, then swap it in and relaunch (or hand over the file on macOS). */
async function runInstall() {
  const asset = updateState.asset;
  if (updateState.phase !== "available" || !asset) return updateState;
  const dir = join(process.env.HUB_DATA_DIR || defaultDataDir(), "updates");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, asset.name);
  let lastPct = -1;
  setUpdate({ phase: "downloading", percent: 0 });
  try {
    await downloadAsset({
      asset,
      dest,
      onProgress: ({ received, total }) => {
        const pct = total ? Math.floor((received / total) * 100) : 0;
        if (pct !== lastPct) {
          lastPct = pct;
          setUpdate({ percent: pct });
        }
      },
    });
    setUpdate({ phase: "verifying" });
    await verifyDownload({ file: dest, name: asset.name, sumsUrl: updateState.sumsUrl });
    if (process.platform === "darwin" || !(process.env.APPIMAGE || process.env.PORTABLE_EXECUTABLE_FILE)) {
      // macOS builds are unsigned zips and a dev checkout has no single file to replace.
      shell.showItemInFolder(dest);
      setUpdate({ phase: "manual", message: "unpack it over the old app, then reopen." });
      return updateState;
    }
    setUpdate({ phase: "installing" });
    if (process.platform === "win32") {
      const target = process.env.PORTABLE_EXECUTABLE_FILE;
      const swap = windowsSwapScript({ pid: process.pid, newFile: dest, targetFile: target, scriptFile: join(dir, "swap.ps1"), okFile: join(dir, "ok") });
      writeFileSync(swap.file, swap.body, "utf8");
      spawn(swap.command, swap.args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } else {
      const swap = posixSwapScript({ pid: process.pid, newFile: dest, targetFile: process.env.APPIMAGE, scriptFile: join(dir, "swap.sh"), okFile: join(dir, "ok") });
      writeFileSync(swap.file, swap.body, { mode: 0o755 });
      spawn(swap.command, swap.args, { detached: true, stdio: "ignore" }).unref();
    }
    log?.info(`update to ${String(updateState.latest)} handed to swap script`);
    quitHub();
  } catch (err) {
    setUpdate({ phase: "error", message: err instanceof Error ? err.message : String(err) });
  }
  return updateState;
}

/** Windows blocks inbound connections to a new exe: add a private+public rule for the Hub port (UAC prompt). */
function allowFirewall() {
  if (process.platform !== "win32") return { ok: false };
  const port = String(process.env.HUB_PORT || "8787");
  const cmd = `netsh advfirewall firewall add rule name="Cursor Mobile Hub" dir=in action=allow protocol=TCP localport=${port} profile=any`;
  spawn("powershell.exe", ["-NoProfile", "-Command", `Start-Process cmd -Verb RunAs -WindowStyle Hidden -ArgumentList '/c ${cmd}'`], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
  return { ok: true };
}

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

/**
 * The Hub runs in a separate process (hub-child.mjs) so slow synchronous work can never freeze this
 * one. ELECTRON_RUN_AS_NODE makes the Electron binary behave as plain Node for the child.
 */
function spawnHubChild({ onMessage, onExit }) {
  const child = fork(join(__dirname, "hub-child.mjs"), [], {
    execPath: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  child.stdout?.on("data", (d) => log?.write("hub", d));
  child.stderr?.on("data", (d) => log?.write("hub-err", d));
  child.on("message", onMessage);
  child.on("error", (err) => onMessage({ type: "fatal", error: err.message }));
  child.on("exit", (code, signal) => onExit(code, signal));
  return {
    send(message) {
      try {
        if (child.connected) child.send(message);
      } catch {
        /* child is exiting */
      }
    },
    kill() {
      try {
        if (child.connected) child.send({ type: "shutdown" });
      } catch {
        /* already gone */
      }
      // Hard stop if it ignores the polite request (e.g. blocked in a sync call).
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    },
  };
}

function startHub() {
  applyDefaultEnv();
  log = createLogger(join(process.env.HUB_DATA_DIR, "logs"));
  log.info(`shell ${app.getVersion()} starting on ${process.platform}/${process.arch}`);
  supervisor = createSupervisor({
    spawn: spawnHubChild,
    onStatus: (status) => {
      if (status.phase !== lastStatus.phase) log?.info(`hub ${String(status.phase)}: ${status.stateLabel}${status.error ? ` (${status.error})` : ""}`);
      lastStatus = status;
      // Tell a pending self-update swap script that the new build came up healthy (else it rolls back).
      if (status.running) {
        try {
          mkdirSync(updatesDir(), { recursive: true });
          writeFileSync(join(updatesDir(), "ok"), String(Date.now()));
        } catch {
          /* best effort */
        }
      }
      tray?.setToolTip(`Cursor Mobile Hub — ${status.stateLabel}`);
      broadcastStatus();
    },
  });
  supervisor.start();
  // A Hub that is alive but blocked never exits; restart it after repeated failed health pings.
  heartbeat = createHeartbeat({
    ping: async () => {
      if (!lastStatus.running) return true; // supervisor already owns start/restart states
      const res = await fetch(String(lastStatus.healthUrl), { signal: AbortSignal.timeout(5000) });
      return res.ok;
    },
    onDead: () => {
      log?.info("hub unresponsive (3 missed health pings): restarting");
      supervisor?.restartNow();
    },
  });
  heartbeat.start();
}

function broadcastStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("hub:status", { ...lastStatus, platform: process.platform });
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
    // Without a tray icon a hidden window cannot be found again: minimize so it stays in the taskbar.
    if (tray) mainWindow?.hide();
    else mainWindow?.minimize();
  });
  // A wedged renderer must never leave a dead window: reload it (the Hub runs in its own process).
  mainWindow.on("unresponsive", () => mainWindow?.webContents.reload());
  mainWindow.webContents.on("render-process-gone", () => mainWindow?.webContents.reload());
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
    tray.setToolTip(`Cursor Mobile Hub — ${lastStatus.stateLabel}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Hub", click: showWindow },
        {
          label: "Open pairing page (QR)",
          click: () => {
            if (lastStatus.pairUrl) void shell.openExternal(String(lastStatus.pairUrl));
          },
        },
        {
          label: "Start with system",
          type: "checkbox",
          checked: getAutostart(app),
          click: (item) => setAutostart(app, item.checked),
        },
        { label: "Open log folder", click: () => log && void shell.openPath(log.dir) },
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

ipcMain.handle("hub:status", async () => ({ ...lastStatus, platform: process.platform }));
ipcMain.handle("update:check", () => runCheck());
ipcMain.handle("update:install", () => runInstall());
ipcMain.handle("hub:allow-firewall", () => allowFirewall());
ipcMain.handle("hub:diagnostics", () => runDiagnostics({ status: lastStatus, platform: process.platform }));
ipcMain.handle("hub:open-logs", async () => {
  if (log) await shell.openPath(log.dir);
  return { ok: Boolean(log) };
});
ipcMain.handle("hub:autostart", (_e, enabled) => {
  if (typeof enabled === "boolean") setAutostart(app, enabled);
  return { enabled: getAutostart(app) };
});
ipcMain.handle("hub:refresh", async () => {
  // The child re-probes CDP on its own clock and reports back; never block this process on it.
  supervisor?.requestRefresh();
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
    if (startHidden && tray) mainWindow?.hide();
    startHub();
    void runCheck();
  });

  // The Hub must outlive its window: stay running until Quit.
  app.on("window-all-closed", () => {});

  app.on("before-quit", () => {
    quitting = true;
    heartbeat?.stop();
    supervisor?.stop();
  });
}
