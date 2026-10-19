/**
 * Hub self-update: look up the newest GitHub Release, download the build for this OS, and swap it in.
 * No Electron imports so it can be unit-tested. Only the release *binary* comes from GitHub; no Hub
 * state or sync traffic ever leaves the PC (product lock).
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const RELEASES_API = "https://api.github.com/repos/KingEGame/cursor-mobile/releases/latest";

/** Parse "v1.2.3" / "1.2.3-rc1" into [1,2,3]; null when it has no numeric core. */
export function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `candidate` is strictly newer than `current`. Unparseable input is never "newer". */
export function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** Release asset for this OS/arch, matching the electron-builder artifactName patterns. */
export function pickAsset(release, platform, arch) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const want =
    platform === "win32"
      ? (n) => /^cursor-mobile-hub-.*-win-.*\.exe$/.test(n)
      : platform === "linux"
        ? (n) => /^cursor-mobile-hub-.*-linux-.*\.AppImage$/.test(n)
        : platform === "darwin"
          ? (n) => new RegExp(`^cursor-mobile-hub-.*-darwin-${arch}\\.zip$`).test(n)
          : () => false;
  return assets.find((a) => want(String(a.name))) ?? null;
}

/** @returns {Promise<{available:boolean, current:string, latest:string, notesUrl?:string, asset?:{name:string,url:string,size:number}}>} */
export async function checkForUpdate({ current, platform, arch, fetchImpl = fetch, signal }) {
  const res = await fetchImpl(RELEASES_API, {
    headers: { accept: "application/vnd.github+json", "user-agent": "cursor-mobile-hub" },
    signal,
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const release = await res.json();
  const latest = String(release.tag_name ?? "");
  const asset = pickAsset(release, platform, arch);
  if (!isNewer(latest, current)) return { available: false, current, latest };
  if (!asset) throw new Error(`Release ${latest} has no build for ${platform}/${arch}`);
  const sums = (release.assets ?? []).find((a) => a.name === "SHA256SUMS.txt");
  return {
    available: true,
    current,
    latest,
    sumsUrl: sums?.browser_download_url ?? null,
    notesUrl: release.html_url,
    asset: { name: asset.name, url: asset.browser_download_url, size: Number(asset.size) || 0 },
  };
}

/** Download to `dest` via a .part file; rejects (and cleans up) on a short or failed transfer. */
export async function downloadAsset({ asset, dest, onProgress, fetchImpl = fetch, signal }) {
  const res = await fetchImpl(asset.url, { headers: { "user-agent": "cursor-mobile-hub" }, signal, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const part = `${dest}.part`;
  let received = 0;
  const body = Readable.fromWeb(res.body);
  body.on("data", (chunk) => {
    received += chunk.length;
    onProgress?.({ received, total: asset.size });
  });
  try {
    await pipeline(body, createWriteStream(part));
    if (asset.size && received !== asset.size) throw new Error(`Download incomplete (${received}/${asset.size} bytes)`);
    await rename(part, dest);
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
  return dest;
}

/** Find the expected sha256 for `name` in a `sha256sum` style listing. */
export function expectedHash(sumsText, name) {
  for (const line of String(sumsText).split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  return null;
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (c) => h.update(c)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

/** Throws unless the downloaded file matches the release's SHA256SUMS.txt. A missing listing is an error. */
export async function verifyDownload({ file, name, sumsUrl, fetchImpl = fetch }) {
  if (!sumsUrl) throw new Error("Release has no SHA256SUMS.txt; refusing to install unverified binary");
  const res = await fetchImpl(sumsUrl, { headers: { "user-agent": "cursor-mobile-hub" } });
  if (!res.ok) throw new Error(`Could not fetch SHA256SUMS.txt (${res.status})`);
  const want = expectedHash(await res.text(), name);
  if (!want) throw new Error(`${name} is not listed in SHA256SUMS.txt`);
  const got = await sha256File(file);
  if (got !== want) throw new Error("Checksum mismatch: the download is corrupt or tampered with");
}

const ROLLBACK_SECONDS = 45;

/**
 * Swap script with rollback: waits for this process to exit, keeps the old file as `.bak`, starts the new
 * one, and restores the old build if the new one has not written `okFile` within the grace period.
 * Returns { file, body, command, args } for a detached spawn.
 */
export function windowsSwapScript({ pid, newFile, targetFile, scriptFile, okFile }) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const bak = `${targetFile}.bak`;
  const body = [
    `$ErrorActionPreference = 'Stop'`,
    `Remove-Item -LiteralPath ${q(okFile)} -ErrorAction SilentlyContinue`,
    `for ($i = 0; $i -lt 60; $i++) { if (-not (Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 500 }`,
    `for ($i = 0; $i -lt 20; $i++) { try { Move-Item -LiteralPath ${q(targetFile)} -Destination ${q(bak)} -Force; Move-Item -LiteralPath ${q(newFile)} -Destination ${q(targetFile)} -Force; break } catch { Start-Sleep -Milliseconds 500 } }`,
    `$p = Start-Process -FilePath ${q(targetFile)} -ArgumentList '--hidden' -PassThru`,
    `for ($i = 0; $i -lt ${ROLLBACK_SECONDS}; $i++) { if (Test-Path -LiteralPath ${q(okFile)}) { Remove-Item -LiteralPath ${q(bak)} -ErrorAction SilentlyContinue; exit 0 }; Start-Sleep -Seconds 1 }`,
    `# New build never reported healthy: put the old one back.`,
    `Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue`,
    `Start-Sleep -Seconds 1`,
    `Move-Item -LiteralPath ${q(bak)} -Destination ${q(targetFile)} -Force`,
    `Start-Process -FilePath ${q(targetFile)}`,
  ].join("\n");
  return { file: scriptFile, body, command: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", scriptFile] };
}

/** POSIX (Linux AppImage) counterpart of windowsSwapScript. */
export function posixSwapScript({ pid, newFile, targetFile, scriptFile, okFile }) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const bak = `${targetFile}.bak`;
  const body = [
    `#!/bin/sh`,
    `rm -f ${q(okFile)}`,
    `i=0; while kill -0 ${Number(pid)} 2>/dev/null && [ $i -lt 60 ]; do sleep 0.5; i=$((i+1)); done`,
    `mv -f ${q(targetFile)} ${q(bak)} && mv -f ${q(newFile)} ${q(targetFile)} && chmod +x ${q(targetFile)}`,
    `${q(targetFile)} --hidden >/dev/null 2>&1 &`,
    `new=$!`,
    `i=0; while [ $i -lt ${ROLLBACK_SECONDS} ]; do [ -e ${q(okFile)} ] && { rm -f ${q(bak)}; exit 0; }; sleep 1; i=$((i+1)); done`,
    `kill -9 $new 2>/dev/null; sleep 1`,
    `mv -f ${q(bak)} ${q(targetFile)}`,
    `${q(targetFile)} >/dev/null 2>&1 &`,
    ``,
  ].join("\n");
  return { file: scriptFile, body, command: "/bin/sh", args: [scriptFile] };
}
