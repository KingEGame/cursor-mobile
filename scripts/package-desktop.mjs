#!/usr/bin/env node
/**
 * Package the PC Hub desktop app (Electron) for end-user download.
 *
 * Platforms:
 *   linux  → AppImage (x64)           — self-hosted node1
 *   win    → portable .exe (x64)      — windows-latest
 *   mac    → zip (x64 + arm64)        — macos-latest
 *
 * Steps:
 *   1. npm run build (adapters + hub)
 *   2. esbuild bundle hub → apps/desktop/vendor/hub-bundle.mjs
 *   3. electron-builder for the requested platform(s)
 *   4. SHA256SUMS.txt for produced artifacts in dist-desktop/
 *
 * Usage:
 *   node scripts/package-desktop.mjs
 *   node scripts/package-desktop.mjs --platform linux
 *   node scripts/package-desktop.mjs --platform win
 *   node scripts/package-desktop.mjs --platform mac
 *   node scripts/package-desktop.mjs --bundle-only
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = join(root, "apps/desktop");
const vendorDir = join(desktopDir, "vendor");
const outDir = join(root, "dist-desktop");
const bundleOnly = process.argv.includes("--bundle-only");

export const DESKTOP_ARTIFACT_PREFIX = "cursor-mobile-hub-";
export const DESKTOP_PLATFORMS = ["linux", "win", "mac"];

/** @typedef {"linux" | "win" | "mac"} DesktopPlatform */

/**
 * @param {string[]} argv
 * @returns {DesktopPlatform[]}
 */
export function parsePlatforms(argv = process.argv.slice(2)) {
  const idx = argv.indexOf("--platform");
  if (idx === -1) {
    // Default: host OS only (CI passes an explicit platform).
    if (process.platform === "win32") return ["win"];
    if (process.platform === "darwin") return ["mac"];
    return ["linux"];
  }
  const raw = String(argv[idx + 1] || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (raw.includes("all")) return [...DESKTOP_PLATFORMS];
  const out = [];
  for (const p of raw) {
    if (!DESKTOP_PLATFORMS.includes(p)) {
      throw new Error(`Unknown --platform ${p} (want: ${DESKTOP_PLATFORMS.join("|")}|all)`);
    }
    if (!out.includes(p)) out.push(/** @type {DesktopPlatform} */ (p));
  }
  if (out.length === 0) throw new Error("--platform requires linux|win|mac|all");
  return out;
}

export function semverStrip(version) {
  return String(version).replace(/^v/, "");
}

export function desktopLinuxArtifactName(version) {
  return `${DESKTOP_ARTIFACT_PREFIX}${semverStrip(version)}-linux-x64.AppImage`;
}

export function desktopWinArtifactName(version) {
  return `${DESKTOP_ARTIFACT_PREFIX}${semverStrip(version)}-win-x64.exe`;
}

export function desktopMacArtifactName(version, arch) {
  return `${DESKTOP_ARTIFACT_PREFIX}${semverStrip(version)}-darwin-${arch}.zip`;
}

/** Expected primary file names for a platform (may be a subset of what builder emits). */
export function expectedArtifactsFor(platform, version) {
  switch (platform) {
    case "linux":
      return [desktopLinuxArtifactName(version)];
    case "win":
      return [desktopWinArtifactName(version)];
    case "mac":
      return [
        desktopMacArtifactName(version, "arm64"),
        desktopMacArtifactName(version, "x64"),
      ];
    default: {
      const _exhaustive = platform;
      throw new Error(`unexpected platform: ${_exhaustive}`);
    }
  }
}

export function sha256File(filePath) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

export async function writeSha256Sums(dir, files) {
  const lines = [];
  for (const name of files) {
    const hex = await sha256File(join(dir, name));
    lines.push(`${hex}  ${name}`);
  }
  const body = `${lines.join("\n")}\n`;
  writeFileSync(join(dir, "SHA256SUMS.txt"), body, "utf8");
  return body;
}

/** Release-ready files in dist-desktop (binaries + archives, not builder junk). */
export function listReleaseArtifacts(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) =>
      n.endsWith(".AppImage") ||
      n.endsWith(".exe") ||
      n.endsWith(".zip") ||
      n.endsWith(".dmg"),
    )
    .sort();
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
}

function ensureBuild() {
  console.log("[package-desktop] building packages…");
  run("npm", ["run", "build"]);
}

function bundleHub() {
  const require = createRequire(import.meta.url);
  let esbuild;
  try {
    esbuild = require("esbuild");
  } catch {
    console.error("[package-desktop] esbuild missing — run npm install at repo root");
    process.exit(1);
  }

  const entry = join(root, "packages/hub/dist/index.js");
  if (!existsSync(entry)) {
    console.error("[package-desktop] missing", entry, "— build first");
    process.exit(1);
  }

  mkdirSync(vendorDir, { recursive: true });
  const outfile = join(vendorDir, "hub-bundle.mjs");
  console.log("[package-desktop] bundling Hub →", outfile);
  esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    target: "node20",
    packages: "bundle",
    banner: {
      js: "import { createRequire as __cmCreateRequire } from 'node:module'; const require = __cmCreateRequire(import.meta.url);",
    },
    logLevel: "info",
  });
  const staleCjs = join(vendorDir, "hub-bundle.cjs");
  if (existsSync(staleCjs)) rmSync(staleCjs, { force: true });
  writeFileSync(
    join(vendorDir, "README.md"),
    "Generated by scripts/package-desktop.mjs — do not edit.\n",
    "utf8",
  );
  return outfile;
}

function builderEnv() {
  return {
    ...process.env,
    ELECTRON_BUILDER_CACHE:
      process.env.ELECTRON_BUILDER_CACHE ||
      join(process.env.HOME || process.env.USERPROFILE || "/tmp", ".cache", "electron-builder"),
    // Unsigned mac builds on CI.
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  };
}

/**
 * @param {DesktopPlatform} platform
 */
function buildPlatform(platform) {
  mkdirSync(outDir, { recursive: true });

  /** @type {string[]} */
  let args;
  switch (platform) {
    case "linux":
      console.log("[package-desktop] electron-builder linux AppImage…");
      args = [
        "electron-builder",
        "--projectDir",
        desktopDir,
        "--linux",
        "AppImage",
        "--x64",
        "--publish",
        "never",
      ];
      break;
    case "win":
      console.log("[package-desktop] electron-builder win portable…");
      args = [
        "electron-builder",
        "--projectDir",
        desktopDir,
        "--win",
        "portable",
        "--x64",
        "--publish",
        "never",
      ];
      break;
    case "mac":
      console.log("[package-desktop] electron-builder mac zip (x64 + arm64)…");
      args = [
        "electron-builder",
        "--projectDir",
        desktopDir,
        "--mac",
        "zip",
        "--x64",
        "--arm64",
        "--publish",
        "never",
      ];
      break;
    default: {
      const _exhaustive = platform;
      throw new Error(`unexpected platform: ${_exhaustive}`);
    }
  }

  run("npx", args, { env: builderEnv() });
}

async function main() {
  const platforms = bundleOnly ? [] : parsePlatforms();
  ensureBuild();
  bundleHub();
  if (bundleOnly) {
    console.log("[package-desktop] --bundle-only done");
    return;
  }

  run("npm", ["install", "-w", "@cursor-mobile/desktop", "--no-fund", "--no-audit"]);

  for (const platform of platforms) {
    buildPlatform(platform);
  }

  const pkg = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8"));
  const artifacts = listReleaseArtifacts(outDir);
  if (artifacts.length === 0) {
    console.error("[package-desktop] no release artifacts in", outDir);
    process.exit(1);
  }

  for (const platform of platforms) {
    const expected = expectedArtifactsFor(platform, pkg.version);
    const missing = expected.filter((n) => !artifacts.includes(n));
    if (missing.length > 0) {
      console.warn(
        `[package-desktop] warning: expected ${missing.join(", ")} not found; have: ${artifacts.join(", ")}`,
      );
    }
  }

  console.log("[package-desktop] artifacts:", artifacts.join(", "));
  await writeSha256Sums(outDir, artifacts);
  console.log("[package-desktop] wrote", join(outDir, "SHA256SUMS.txt"));
  console.log("[package-desktop] done →", outDir, `(${platforms.join(",")})`);
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  main().catch((err) => {
    console.error("[package-desktop] failed", err);
    process.exit(1);
  });
}
