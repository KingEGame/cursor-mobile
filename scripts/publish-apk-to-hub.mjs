#!/usr/bin/env node
/**
 * Put a signed release APK where the PC-local Hub serves it to paired phones
 * (GET /v1/app/latest + /v1/app/apk). Nothing leaves the PC.
 *
 * Usage:
 *   node scripts/publish-apk-to-hub.mjs [--apk <path>] [--dest <dir>]
 *        [--tests-passed <n>] [--ci-run-url <url>] [--source local|github]
 *        [--manifest-only]
 *   node scripts/publish-apk-to-hub.mjs --from-github [<tag>]   # needs `gh`
 *
 * Defaults: --apk = the local Gradle release output, --dest = packages/hub/data/releases
 * (the Hub's default HUB_DATA_DIR/releases when started with `npm start`).
 *
 * --manifest-only writes latest.json next to --apk without copying (CI uses this
 * to attach the manifest to a GitHub Release).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultApk = join(
  repoRoot,
  "apps/mobile/android/app/build/outputs/apk/release/app-release.apk",
);
const defaultDest = join(repoRoot, "packages/hub/data/releases");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function die(msg) {
  console.error(`publish-apk: ${msg}`);
  process.exit(1);
}

async function hashFile(path) {
  const sha = createHash("sha256");
  const md5 = createHash("md5");
  let sizeBytes = 0;
  await new Promise((res, rej) => {
    createReadStream(path)
      .on("data", (c) => {
        sha.update(c);
        md5.update(c);
        sizeBytes += c.length;
      })
      .on("end", res)
      .on("error", rej);
  });
  return { sha256: sha.digest("hex"), md5: md5.digest("hex"), sizeBytes };
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** Same rule as apps/mobile/app.config.ts: major*10000 + minor*100 + patch. */
export function versionCodeFor(versionName) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(versionName);
  if (!m) return null;
  const [maj, min, pat] = m.slice(1).map(Number);
  if (min > 99 || pat > 99) return null;
  return maj * 10000 + min * 100 + pat;
}

function releaseNotes() {
  const lastTag = git(["describe", "--tags", "--abbrev=0", "HEAD^"]);
  const range = lastTag ? [`${lastTag}..HEAD`] : ["-n", "8"];
  return git(["log", "--no-merges", "--format=%s", ...range])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
}

async function fromGithub(tag) {
  const dir = mkdtempSync(join(tmpdir(), "cm-release-"));
  const args = ["release", "download", "--dir", dir, "--pattern", "*.apk", "--pattern", "latest.json"];
  if (tag && tag !== true) args.splice(2, 0, tag);
  try {
    execFileSync("gh", args, { cwd: repoRoot, stdio: "inherit" });
  } catch {
    die("gh release download failed (is the repo on GitHub and `gh auth login` done?)");
  }
  const manifest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
  const apk = join(dir, manifest.apkFile);
  if (!existsSync(apk)) die(`release has no ${manifest.apkFile}`);
  const h = await hashFile(apk);
  if (h.sha256 !== manifest.sha256) die("downloaded APK sha256 does not match latest.json");
  return { dir, manifest };
}

function install(dest, apkSrc, manifest) {
  mkdirSync(dest, { recursive: true });
  // APK first, manifest last and atomically: the Hub never sees a manifest
  // pointing at a file that is still being copied.
  copyFileSync(apkSrc, join(dest, manifest.apkFile));
  const tmp = join(dest, ".latest.json.tmp");
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n");
  renameSync(tmp, join(dest, "latest.json"));
  for (const f of readdirSync(dest)) {
    if (f.endsWith(".apk") && f !== manifest.apkFile) rmSync(join(dest, f));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dest = resolve(args.dest && args.dest !== true ? args.dest : defaultDest);

  if (args["from-github"]) {
    const tag = args._[0] ?? args["from-github"];
    const { dir, manifest } = await fromGithub(tag);
    install(dest, join(dir, manifest.apkFile), { ...manifest, source: "github" });
    rmSync(dir, { recursive: true, force: true });
    console.log(`publish-apk: ${manifest.versionName} (${manifest.versionCode}) from GitHub → ${dest}`);
    return;
  }

  const apk = resolve(args.apk && args.apk !== true ? args.apk : defaultApk);
  if (!existsSync(apk)) die(`APK not found: ${apk} (build it with npm run release:apk)`);

  const appJson = JSON.parse(readFileSync(join(repoRoot, "apps/mobile/app.json"), "utf8"));
  const versionName = String(appJson.expo?.version ?? "");
  const versionCode = versionCodeFor(versionName);
  if (!versionCode) die(`apps/mobile/app.json version "${versionName}" is not x.y.z (y,z ≤ 99)`);

  const h = await hashFile(apk);
  const testsPassed = Number.parseInt(String(args["tests-passed"] ?? ""), 10);
  const manifest = {
    versionName,
    versionCode,
    apkFile: `cursor-mobile-${versionName}-${versionCode}.apk`,
    sizeBytes: h.sizeBytes,
    sha256: h.sha256,
    md5: h.md5,
    publishedAt: new Date().toISOString(),
    notes: releaseNotes(),
    gitSha: git(["rev-parse", "--short", "HEAD"]) || null,
    ciRunUrl: typeof args["ci-run-url"] === "string" ? args["ci-run-url"] : null,
    testsPassed: Number.isFinite(testsPassed) ? testsPassed : null,
    source: args.source === "github" ? "github" : "local",
  };

  if (args["manifest-only"]) {
    const outDir = dirname(apk);
    const named = join(outDir, manifest.apkFile);
    if (named !== apk) copyFileSync(apk, named);
    writeFileSync(join(outDir, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(`publish-apk: wrote ${join(outDir, "latest.json")}`);
    return;
  }

  install(dest, apk, manifest);
  console.log(
    `publish-apk: ${versionName} (${versionCode}) ${(h.sizeBytes / 1e6).toFixed(1)} MB → ${dest}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => die(err?.stack ?? String(err)));
}
