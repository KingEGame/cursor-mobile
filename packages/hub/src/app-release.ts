import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Phone self-update feed (PC-local). The Hub only serves an APK that
 * `scripts/publish-apk-to-hub.mjs` dropped into the releases dir:
 *
 *   <releasesDir>/latest.json   manifest (below)
 *   <releasesDir>/<apkFile>     the signed release APK it names
 *
 * Nothing is fetched from the internet here; the phone downloads over Tailscale
 * with its paired device token.
 */
export interface AppReleaseManifest {
  versionName: string;
  versionCode: number;
  apkFile: string;
  sizeBytes: number;
  sha256: string;
  md5: string;
  publishedAt: string;
  notes: string[];
  gitSha: string | null;
  ciRunUrl: string | null;
  testsPassed: number | null;
  source: "local" | "github";
}

export type ReleaseLookup =
  | { ok: true; manifest: AppReleaseManifest; apkPath: string }
  | { ok: false; reason: "NO_RELEASES_DIR" | "NO_RELEASE" | "INVALID_MANIFEST" | "APK_MISSING" | "APK_MISMATCH"; message: string };

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_32 = /^[0-9a-f]{32}$/;

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/** Validate a parsed latest.json; returns null when anything required is off. */
export function parseManifest(raw: unknown): AppReleaseManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const versionName = asString(o.versionName);
  const apkFile = asString(o.apkFile);
  const sha256 = asString(o.sha256)?.toLowerCase() ?? null;
  const md5 = asString(o.md5)?.toLowerCase() ?? null;
  const versionCode = Number(o.versionCode);
  const sizeBytes = Number(o.sizeBytes);
  if (!versionName || !apkFile || !sha256 || !md5) return null;
  // apkFile must be a bare file name inside the releases dir.
  if (basename(apkFile) !== apkFile || !apkFile.endsWith(".apk")) return null;
  if (!HEX_64.test(sha256) || !HEX_32.test(md5)) return null;
  if (!Number.isInteger(versionCode) || versionCode <= 0) return null;
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) return null;
  const notes = Array.isArray(o.notes)
    ? o.notes.filter((n): n is string => typeof n === "string" && n.trim().length > 0).slice(0, 20)
    : [];
  const testsPassed = Number(o.testsPassed);
  return {
    versionName,
    versionCode,
    apkFile,
    sizeBytes,
    sha256,
    md5,
    publishedAt: asString(o.publishedAt) ?? new Date(0).toISOString(),
    notes,
    gitSha: asString(o.gitSha),
    ciRunUrl: asString(o.ciRunUrl),
    testsPassed: Number.isInteger(testsPassed) && testsPassed >= 0 ? testsPassed : null,
    source: o.source === "github" ? "github" : "local",
  };
}

export function lookupLatestRelease(releasesDir: string | null): ReleaseLookup {
  if (!releasesDir) {
    return { ok: false, reason: "NO_RELEASES_DIR", message: "Hub has no releases dir configured" };
  }
  const manifestPath = join(releasesDir, "latest.json");
  if (!existsSync(manifestPath)) {
    return { ok: false, reason: "NO_RELEASE", message: "No app release published to this Hub yet" };
  }
  let manifest: AppReleaseManifest | null = null;
  try {
    manifest = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  } catch {
    manifest = null;
  }
  if (!manifest) {
    return { ok: false, reason: "INVALID_MANIFEST", message: "latest.json is malformed" };
  }
  const apkPath = join(releasesDir, manifest.apkFile);
  if (!existsSync(apkPath)) {
    return { ok: false, reason: "APK_MISSING", message: `APK ${manifest.apkFile} is missing` };
  }
  // Cheap guard against a half-copied file; the hash itself is checked at publish
  // time and again on the phone.
  if (statSync(apkPath).size !== manifest.sizeBytes) {
    return { ok: false, reason: "APK_MISMATCH", message: "APK size does not match latest.json" };
  }
  return { ok: true, manifest, apkPath };
}

/** Streaming sha256 + md5 of a file (used by tests and the publish script). */
export async function hashFile(path: string): Promise<{ sha256: string; md5: string; sizeBytes: number }> {
  const sha = createHash("sha256");
  const md5 = createHash("md5");
  let sizeBytes = 0;
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on("data", (chunk) => {
        sha.update(chunk);
        md5.update(chunk);
        sizeBytes += chunk.length;
      })
      .on("end", () => resolve())
      .on("error", reject);
  });
  return { sha256: sha.digest("hex"), md5: md5.digest("hex"), sizeBytes };
}
