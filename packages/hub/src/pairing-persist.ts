import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PairedDevice } from "./config.js";

export interface DevicesFileV1 {
  version: 1;
  updatedAt: string;
  devices: PairedDevice[];
}

export function devicesFilePath(dataDir: string): string {
  return `${dataDir.replace(/\/+$/, "")}/devices.json`;
}

/**
 * Load paired devices from disk. Missing file → empty list.
 * Corrupt/unsupported version → empty list (fail closed, log via caller).
 */
export function loadDevicesFromDisk(filePath: string): PairedDevice[] {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as DevicesFileV1;
    if (parsed?.version !== 1 || !Array.isArray(parsed.devices)) {
      return [];
    }
    return parsed.devices.filter(isPairedDeviceShape);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

function isPairedDeviceShape(d: unknown): d is PairedDevice {
  if (!d || typeof d !== "object") return false;
  const o = d as Record<string, unknown>;
  return (
    typeof o.deviceId === "string" &&
    typeof o.deviceToken === "string" &&
    typeof o.deviceName === "string" &&
    o.platform === "android" &&
    typeof o.appVersion === "string" &&
    typeof o.pairedAt === "string" &&
    typeof o.lastSeenAt === "string" &&
    typeof o.revoked === "boolean" &&
    (o.expiresAt === null || typeof o.expiresAt === "string")
  );
}

/** Atomic-ish write: temp file + rename. Never logs tokens. */
export function saveDevicesToDisk(
  filePath: string,
  devices: PairedDevice[],
): void {
  const payload: DevicesFileV1 = {
    version: 1,
    updatedAt: new Date().toISOString(),
    devices,
  };
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, filePath);
}
