import { createHash, randomBytes, randomInt } from "node:crypto";
import { detectTailscaleIp } from "./mesh-host.js";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  createLiveCursorAdapter,
  normalizeCdpUrl,
  type LiveCursorAdapter,
} from "@cursor-mobile/live-cursor";
import {
  createHistoryAdapter,
  type HistoryAdapter,
} from "@cursor-mobile/history";
import { IdempotencyStore } from "./idempotency.js";
import { SessionAttachmentStore } from "./session-attachments.js";
import { SessionCreateQueue } from "./session-create-queue.js";
import { defaultAgentsIndex, type AgentsIndex } from "./agents.js";
import {
  devicesFilePath,
  loadDevicesFromDisk,
  saveDevicesToDisk,
} from "./pairing-persist.js";

/** Minimal fan-out for WS clients (implemented by HubWsHub). */
export interface HubEventBus {
  broadcast(event: Record<string, unknown> & { type: string }): void;
}

export interface HubConfig {
  /** Interface to bind. Use Tailscale IP; 0.0.0.0 only behind Tailscale ACLs. */
  hubHost: string;
  hubPort: number;
  /** Must be loopback — default http://127.0.0.1:9222 */
  cdpUrl: string;
  pairingRequired: boolean;
  pairingCodeTtlSec: number;
  /** null = non-expiring device tokens (Phase 0). */
  pairingTokenTtlSec: number | null;
  tailscaleHostname: string;
  hubDisplayName: string;
  /** Optional env stub for workspace when CDP detection is unavailable. */
  cursorWorkspace: string | null;
  /**
   * Optional extra absolute roots for multi-root PC-open workspaces (Phase 3).
   * Comma-separated paths merged with primary `CURSOR_WORKSPACE` / `.code-workspace` folders.
   */
  cursorWorkspaceRoots: string[];
  /**
   * DESIGNED stub: comma-separated model ids (`id`, `id:label`, `id:label:family`).
   * Empty → built-in defaults (composer, auto). Not scraped from Cursor CDP.
   */
  cursorModels: string | null;
  /** Optional MCP inventory stub: `name[:toolCount][,…]`. */
  cursorMcpServers: string | null;
  /** Optional plugin name list stub. */
  cursorPlugins: string | null;
  hubVersion: string;
  apiVersion: string;
  /**
   * Directory for durable Hub state (paired devices).
   * Default `./data` → `data/devices.json`. Empty disables disk persist (tests).
   */
  hubDataDir: string | null;
  /**
   * Phone self-update feed: `latest.json` + signed APK written by
   * `scripts/publish-apk-to-hub.mjs`. Default `<hubDataDir>/releases`; null disables.
   */
  hubReleasesDir: string | null;
  /**
   * Dev/UAT: allow POST …/approvals/synthetic from non-loopback when set.
   * Loopback always allowed. Never enables live Cursor DOM clicks.
   */
  allowSyntheticApprovals: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const tokenTtlRaw = env.PAIRING_TOKEN_TTL_SEC?.trim();
  const pairingTokenTtlSec =
    tokenTtlRaw && tokenTtlRaw.length > 0
      ? Number.parseInt(tokenTtlRaw, 10)
      : null;

  // Product lock: CDP_URL must be loopback — reject Tailscale/LAN at Hub boot
  // (AC-001-02 / AC-X-02), not only inside LiveCursorAdapter.
  const cdpUrl = normalizeCdpUrl(
    env.CDP_URL?.trim() || "http://127.0.0.1:9222",
  );

  return {
    hubHost: env.HUB_HOST?.trim() || "127.0.0.1",
    hubPort: Number.parseInt(env.HUB_PORT || "8787", 10),
    cdpUrl,
    pairingRequired: (env.PAIRING_REQUIRED ?? "true").toLowerCase() !== "false",
    pairingCodeTtlSec: Number.parseInt(env.PAIRING_CODE_TTL_SEC || "300", 10),
    pairingTokenTtlSec:
      pairingTokenTtlSec !== null && Number.isFinite(pairingTokenTtlSec)
        ? pairingTokenTtlSec
        : null,
    tailscaleHostname: env.TAILSCALE_HOSTNAME?.trim() || "",
    hubDisplayName: env.HUB_DISPLAY_NAME?.trim() || "Desk PC",
    cursorWorkspace: env.CURSOR_WORKSPACE?.trim() || null,
    cursorWorkspaceRoots: parseWorkspaceRootsEnv(env.CURSOR_WORKSPACE_ROOTS),
    cursorModels: env.CURSOR_MODELS?.trim() || null,
    cursorMcpServers: env.CURSOR_MCP_SERVERS?.trim() || null,
    cursorPlugins: env.CURSOR_PLUGINS?.trim() || null,
    hubVersion: env.HUB_VERSION?.trim() || "0.1.0",
    apiVersion: "1",
    hubDataDir: resolveHubDataDir(env.HUB_DATA_DIR),
    hubReleasesDir: resolveHubReleasesDir(
      env.HUB_RELEASES_DIR,
      resolveHubDataDir(env.HUB_DATA_DIR),
    ),
    allowSyntheticApprovals:
      (env.HUB_ALLOW_SYNTHETIC_APPROVALS ?? "").trim() === "1",
  };
}

/** Unset → `<dataDir>/releases` (null when there is no data dir). Empty/none/off → null. */
function resolveHubReleasesDir(
  raw: string | undefined,
  dataDir: string | null,
): string | null {
  if (raw === undefined) return dataDir ? join(dataDir, "releases") : null;
  const trimmed = raw.trim();
  if (["", "none", "off"].includes(trimmed.toLowerCase())) return null;
  return resolve(trimmed);
}

/** Empty / "none" / "off" → null (in-memory only). Unset → ./data. */
function resolveHubDataDir(raw: string | undefined): string | null {
  if (raw === undefined) {
    return resolve("data");
  }
  const trimmed = raw.trim();
  if (
    trimmed === "" ||
    trimmed.toLowerCase() === "none" ||
    trimmed.toLowerCase() === "off"
  ) {
    return null;
  }
  return resolve(trimmed);
}

/** lastSeenAt is written to disk at most this often per device. */
const LAST_SEEN_PERSIST_MS = 5 * 60_000;

export interface PendingPair {
  pairId: string;
  code: string;
  label: string;
  expiresAt: Date;
  used: boolean;
}

export interface PairedDevice {
  deviceId: string;
  deviceToken: string;
  deviceName: string;
  platform: "android";
  appVersion: string;
  pairedAt: string;
  lastSeenAt: string;
  revoked: boolean;
  expiresAt: string | null;
}

export interface BoundWorkspace {
  workspaceId: string;
  name: string;
  path: string;
  roots: Array<{ name: string; path: string }>;
  windowId: string;
  windows: Array<{
    windowId: string;
    title: string;
    workspaceId: string;
    path: string;
    selected: boolean;
  }>;
  updatedAt: string;
}

export interface EmptyWorkspace {
  workspaceId: null;
  name: null;
  path: null;
  roots: [];
  windowId: null;
  windows: [];
  updatedAt: string;
  emptyReason: "NO_FOLDER_OPEN";
}

export type WorkspaceSnapshot = BoundWorkspace | EmptyWorkspace;

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function hashPathToWorkspaceId(path: string): string {
  const digest = createHash("sha256").update(path).digest("hex").slice(0, 12);
  return `ws_${digest}`;
}

function generatePairCode(): string {
  return String(randomInt(100000, 999999));
}

export class PairingStore {
  private pending = new Map<string, PendingPair>();
  private devices = new Map<string, PairedDevice>();
  private tokenIndex = new Map<string, string>();
  private readonly persistPath: string | null;

  constructor(opts?: { persistPath?: string | null; dataDir?: string | null }) {
    const path =
      opts?.persistPath !== undefined
        ? opts.persistPath
        : opts?.dataDir
          ? devicesFilePath(opts.dataDir)
          : null;
    this.persistPath = path && path.trim() ? path : null;
    if (this.persistPath) {
      this.hydrateFromDisk(this.persistPath);
    }
  }

  /** Absolute path to devices.json when persistence is enabled. */
  getPersistPath(): string | null {
    return this.persistPath;
  }

  private hydrateFromDisk(filePath: string): void {
    let devices: PairedDevice[];
    try {
      devices = loadDevicesFromDisk(filePath);
    } catch (err) {
      console.warn(
        "[hub] failed to load devices.json — starting with empty pairing store",
        err instanceof Error ? err.message : err,
      );
      return;
    }
    for (const device of devices) {
      this.devices.set(device.deviceId, device);
      if (!device.revoked) {
        this.tokenIndex.set(device.deviceToken, device.deviceId);
      }
    }
  }

  private persist(): void {
    if (!this.persistPath) return;
    try {
      // Revoked devices are left out: an unknown token is rejected exactly like a revoked one.
      saveDevicesToDisk(this.persistPath, this.listDevices().filter((d) => !d.revoked));
    } catch (err) {
      console.error(
        "[hub] failed to persist devices.json",
        err instanceof Error ? err.message : err,
      );
    }
  }

  start(opts: {
    ttlSec: number;
    label: string;
  }): PendingPair {
    const pairId = newId("pair");
    const code = generatePairCode();
    const pending: PendingPair = {
      pairId,
      code,
      label: opts.label,
      expiresAt: new Date(Date.now() + opts.ttlSec * 1000),
      used: false,
    };
    this.pending.set(pairId, pending);
    return pending;
  }

  /** Status of one pairing code, for the PC pairing page. */
  pendingStatus(pairId: string): "waiting" | "paired" | "expired" | "unknown" {
    const p = this.pending.get(pairId);
    if (!p) return "unknown";
    if (p.used) return "paired";
    return p.expiresAt.getTime() < Date.now() ? "expired" : "waiting";
  }

  findPending(code: string, pairId?: string): PendingPair | undefined {
    if (pairId) {
      const byId = this.pending.get(pairId);
      if (byId && byId.code === code) return byId;
      return undefined;
    }
    for (const p of this.pending.values()) {
      if (p.code === code) return p;
    }
    return undefined;
  }

  complete(
    pending: PendingPair,
    input: {
      deviceName: string;
      platform: "android";
      appVersion: string;
      tokenTtlSec: number | null;
    },
  ): PairedDevice {
    if (pending.used) {
      const err = new Error("PAIR_CODE_USED") as Error & { code: string };
      err.code = "PAIR_CODE_USED";
      throw err;
    }
    if (pending.expiresAt.getTime() < Date.now()) {
      const err = new Error("PAIR_CODE_EXPIRED") as Error & { code: string };
      err.code = "PAIR_CODE_EXPIRED";
      throw err;
    }
    pending.used = true;
    const now = new Date().toISOString();
    const deviceToken = randomBytes(32).toString("base64url");
    const device: PairedDevice = {
      deviceId: newId("dev"),
      deviceToken,
      deviceName: input.deviceName,
      platform: input.platform,
      appVersion: input.appVersion,
      pairedAt: now,
      lastSeenAt: now,
      revoked: false,
      expiresAt:
        input.tokenTtlSec !== null
          ? new Date(Date.now() + input.tokenTtlSec * 1000).toISOString()
          : null,
    };
    this.devices.set(device.deviceId, device);
    this.tokenIndex.set(deviceToken, device.deviceId);
    this.persist();
    return device;
  }

  authenticate(token: string): PairedDevice | null {
    const deviceId = this.tokenIndex.get(token);
    if (!deviceId) return null;
    const device = this.devices.get(deviceId);
    if (!device || device.revoked) return null;
    if (device.expiresAt && new Date(device.expiresAt).getTime() < Date.now()) {
      return null;
    }
    const now = Date.now();
    const previous = Date.parse(device.lastSeenAt);
    device.lastSeenAt = new Date(now).toISOString();
    // Persist lastSeen at most every 5 min per device so stale devices can be pruned
    // after a restart (frequent polls must not hammer the disk).
    if (!Number.isFinite(previous) || now - previous > LAST_SEEN_PERSIST_MS) {
      this.persist();
    }
    return device;
  }

  /**
   * Revoke devices not seen since `cutoff` (never the ones in `keepDeviceIds`).
   * Returns the revoked device ids. Revoked devices are dropped from disk on save.
   */
  pruneStale(cutoff: Date, keepDeviceIds: string[] = []): string[] {
    const keep = new Set(keepDeviceIds);
    const revoked: string[] = [];
    for (const device of this.devices.values()) {
      if (device.revoked || keep.has(device.deviceId)) continue;
      if (Date.parse(device.lastSeenAt) < cutoff.getTime()) {
        device.revoked = true;
        revoked.push(device.deviceId);
      }
    }
    if (revoked.length > 0) this.persist();
    return revoked;
  }

  listDevices(): PairedDevice[] {
    return [...this.devices.values()];
  }

  pairedCount(): number {
    return [...this.devices.values()].filter((d) => !d.revoked).length;
  }

  /** FR-002 / AC-002-04 — revoke by device token (immediate reject). */
  revokeByToken(token: string): boolean {
    const deviceId = this.tokenIndex.get(token);
    if (!deviceId) return false;
    const device = this.devices.get(deviceId);
    if (!device) return false;
    device.revoked = true;
    this.tokenIndex.delete(token);
    this.persist();
    return true;
  }

  revokeByDeviceId(deviceId: string): boolean {
    const device = this.devices.get(deviceId);
    if (!device) return false;
    device.revoked = true;
    this.tokenIndex.delete(device.deviceToken);
    this.persist();
    return true;
  }
}

/** Parse CURSOR_WORKSPACE_ROOTS — comma-separated absolute (or cwd-relative) paths. */
export function parseWorkspaceRootsEnv(raw: string | undefined | null): string[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolve(p));
}

export interface ResolveWorkspaceOptions {
  now?: Date;
  /** Extra absolute roots (CURSOR_WORKSPACE_ROOTS). */
  extraRoots?: string[] | null;
}

/**
 * Resolve bound workspace from CURSOR_WORKSPACE / `.code-workspace` / vscode path env,
 * plus optional multi-root extras. Phase 0 does not yet detect via CDP window titles.
 */
export function resolveWorkspace(
  cursorWorkspace: string | null,
  nowOrOpts: Date | ResolveWorkspaceOptions = new Date(),
): WorkspaceSnapshot {
  const opts: ResolveWorkspaceOptions =
    nowOrOpts instanceof Date ? { now: nowOrOpts } : nowOrOpts;
  const updatedAt = (opts.now ?? new Date()).toISOString();
  const extraRoots = (opts.extraRoots ?? []).filter((p) => Boolean(p?.trim()));

  const candidates = [
    cursorWorkspace,
    process.env.VSCODE_WORKSPACE,
    process.env.PWD && existsSync(resolve(process.env.PWD, ".code-workspace"))
      ? process.env.PWD
      : null,
  ].filter((v): v is string => Boolean(v && v.trim()));

  const raw = candidates[0];
  if (!raw && extraRoots.length === 0) {
    return emptyWorkspace(updatedAt);
  }

  // Prefer explicit multi-root extras alone when primary unset.
  if (!raw) {
    const roots = uniqueExistingRoots(
      extraRoots.map((p) => ({ name: basename(resolve(p)), path: resolve(p) })),
    );
    if (roots.length === 0) return emptyWorkspace(updatedAt);
    return boundFromRoots(roots, updatedAt);
  }

  const path = resolve(raw);
  if (!existsSync(path)) {
    return emptyWorkspace(updatedAt);
  }

  let roots: Array<{ name: string; path: string }> = [];

  if (isCodeWorkspaceFile(path)) {
    roots = parseCodeWorkspaceFolders(path);
  } else {
    const st = statSync(path);
    if (!st.isDirectory()) {
      return emptyWorkspace(updatedAt);
    }
    roots = [{ name: basename(path), path }];
  }

  for (const extra of extraRoots) {
    const abs = resolve(extra);
    if (!existsSync(abs)) continue;
    try {
      if (!statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    roots.push({ name: basename(abs), path: abs });
  }

  roots = uniqueExistingRoots(roots);
  if (roots.length === 0) return emptyWorkspace(updatedAt);
  return boundFromRoots(roots, updatedAt);
}

function emptyWorkspace(updatedAt: string): EmptyWorkspace {
  return {
    workspaceId: null,
    name: null,
    path: null,
    roots: [],
    windowId: null,
    windows: [],
    updatedAt,
    emptyReason: "NO_FOLDER_OPEN",
  };
}

function boundFromRoots(
  roots: Array<{ name: string; path: string }>,
  updatedAt: string,
): BoundWorkspace {
  const primary = roots[0]!;
  const name = primary.name;
  const path = primary.path;
  const workspaceId = hashPathToWorkspaceId(path);
  const windowId = "win_1";
  return {
    workspaceId,
    name,
    path,
    roots,
    windowId,
    windows: [
      {
        windowId,
        title: name,
        workspaceId,
        path,
        selected: true,
      },
    ],
    updatedAt,
  };
}

function isCodeWorkspaceFile(path: string): boolean {
  return path.endsWith(".code-workspace");
}

/**
 * Parse VS Code / Cursor multi-root `.code-workspace` folders.
 * Paths in the file are relative to the workspace file's directory.
 */
export function parseCodeWorkspaceFolders(
  workspaceFile: string,
): Array<{ name: string; path: string }> {
  const absFile = resolve(workspaceFile);
  let raw: string;
  try {
    raw = readFileSync(absFile, "utf8");
  } catch {
    return [];
  }
  let parsed: { folders?: Array<{ path?: string; name?: string }> };
  try {
    parsed = JSON.parse(raw) as {
      folders?: Array<{ path?: string; name?: string }>;
    };
  } catch {
    return [];
  }
  const baseDir = dirname(absFile);
  const folders = Array.isArray(parsed.folders) ? parsed.folders : [];
  const roots: Array<{ name: string; path: string }> = [];
  for (const folder of folders) {
    if (!folder?.path || typeof folder.path !== "string") continue;
    const folderPath = folder.path.trim();
    if (!folderPath) continue;
    const abs = isAbsolute(folderPath)
      ? resolve(folderPath)
      : resolve(join(baseDir, folderPath));
    if (!existsSync(abs)) continue;
    try {
      if (!statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    const name =
      (typeof folder.name === "string" && folder.name.trim()) || basename(abs);
    roots.push({ name, path: abs });
  }
  return uniqueExistingRoots(roots);
}

function uniqueExistingRoots(
  roots: Array<{ name: string; path: string }>,
): Array<{ name: string; path: string }> {
  const seen = new Set<string>();
  const nameCounts = new Map<string, number>();
  const out: Array<{ name: string; path: string }> = [];
  for (const r of roots) {
    const abs = resolve(r.path);
    if (seen.has(abs)) continue;
    if (!existsSync(abs)) continue;
    seen.add(abs);
    let name = r.name.trim() || basename(abs);
    const count = (nameCounts.get(name) ?? 0) + 1;
    nameCounts.set(name, count);
    if (count > 1) name = `${name}_${count}`;
    out.push({ name, path: abs });
  }
  return out;
}

/** Resolve workspace using HubConfig (primary + CURSOR_WORKSPACE_ROOTS). */
export function resolveWorkspaceFromConfig(
  config: Pick<HubConfig, "cursorWorkspace" | "cursorWorkspaceRoots">,
  now: Date = new Date(),
): WorkspaceSnapshot {
  return resolveWorkspace(config.cursorWorkspace, {
    now,
    extraRoots: config.cursorWorkspaceRoots,
  });
}

export interface HubContext {
  config: HubConfig;
  startedAt: number;
  pairing: PairingStore;
  live: LiveCursorAdapter;
  history: HistoryAdapter;
  /** Agents-window chat details from Cursor's local DB (injectable for tests). */
  agentsIndex: AgentsIndex;
  idempotency: IdempotencyStore;
  attachments: SessionAttachmentStore;
  /** Set when HTTP server attaches WebSocket upgrade handler. */
  ws: HubEventBus | null;
  /**
   * Last POST /sessions attempt (UAT evidence when CDP is down).
   * Includes prompt length/prefix so deep-link inject can be verified without CDP.
   */
  lastSessionCreateAttempt: {
    at: string;
    promptLen: number;
    promptPrefix: string;
    attachmentCount: number;
    model: string;
    ok: boolean;
    code?: string;
    queued?: boolean;
    queueId?: string;
  } | null;
  /** Pending New-session creates while liveAdapter is cursor_down (PC-local). */
  sessionCreateQueue: SessionCreateQueue;
}

export function createHubContext(
  config: HubConfig = loadConfig(),
  overrides?: Partial<{
    live: LiveCursorAdapter;
    history: HistoryAdapter;
    agentsIndex: AgentsIndex;
    pairing: PairingStore;
    startedAt: number;
    idempotency: IdempotencyStore;
    attachments: SessionAttachmentStore;
    ws: HubEventBus | null;
    sessionCreateQueue: SessionCreateQueue;
  }>,
): HubContext {
  return {
    config,
    startedAt: overrides?.startedAt ?? Date.now(),
    pairing:
      overrides?.pairing ??
      new PairingStore({ dataDir: config.hubDataDir }),
    live: overrides?.live ?? createLiveCursorAdapter(config.cdpUrl),
    history: overrides?.history ?? createHistoryAdapter(),
    agentsIndex: overrides?.agentsIndex ?? defaultAgentsIndex,
    idempotency: overrides?.idempotency ?? new IdempotencyStore(),
    attachments: overrides?.attachments ?? new SessionAttachmentStore(),
    ws: overrides?.ws ?? null,
    lastSessionCreateAttempt: null,
    sessionCreateQueue: overrides?.sessionCreateQueue ?? new SessionCreateQueue(),
  };
}

/**
 * Address the phone should use. An explicit TAILSCALE_HOSTNAME wins; otherwise the Tailscale
 * address found on this PC right now (so Windows/macOS desktop installs work without any env
 * var, and Tailscale starting after the Hub is picked up on the next pairing).
 */
export function baseUrlHint(config: HubConfig, detect: () => string | null = detectTailscaleIp): string {
  const host =
    config.tailscaleHostname ||
    detect() ||
    (config.hubHost === "0.0.0.0" || config.hubHost === "::"
      ? ""
      : config.hubHost);
  if (!host || host === "127.0.0.1" || host === "localhost") {
    // Last resort for local-only smoke; phone UAT must set TAILSCALE_HOSTNAME.
    return `http://127.0.0.1:${config.hubPort}`;
  }
  return `http://${host}:${config.hubPort}`;
}

export function buildQrPayload(
  config: HubConfig,
  pending: PendingPair,
  detect: () => string | null = detectTailscaleIp,
): string {
  const hint = baseUrlHint(config, detect);
  let host = "127.0.0.1";
  try {
    host = new URL(hint).hostname;
  } catch {
    host =
      config.tailscaleHostname ||
      detect() ||
      (config.hubHost === "0.0.0.0" ? "127.0.0.1" : config.hubHost);
  }
  const params = new URLSearchParams({
    host,
    port: String(config.hubPort),
    code: pending.code,
    pairId: pending.pairId,
  });
  return `cursor-companion://pair?${params.toString()}`;
}
