#!/usr/bin/env node
/**
 * Refuse to publish an APK that would break the phone. Checks the BUILT file
 * (aapt2), not the config: a release once shipped without cleartext and could
 * no longer reach the Hub — and therefore could not self-update out of it.
 *
 *   node scripts/verify-apk.mjs <apk> [--version-code N]
 *
 * Needs aapt2 from ANDROID_HOME/build-tools (newest) or on PATH.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const PACKAGE = "local.cursor.mobile";

/** Pure checks on `aapt2 dump badging` + `aapt2 dump xmltree` output. */
export function checkApkDump({ badging, manifestTree }, expectedVersionCode) {
  const problems = [];
  const pkg = /package: name='([^']+)' versionCode='(\d+)'/.exec(badging);
  if (!pkg) problems.push("cannot read package line");
  else {
    if (pkg[1] !== PACKAGE) problems.push(`package is ${pkg[1]}, expected ${PACKAGE}`);
    if (expectedVersionCode != null && Number(pkg[2]) !== expectedVersionCode) {
      problems.push(`versionCode is ${pkg[2]}, expected ${expectedVersionCode}`);
    }
  }
  if (!/uses-permission: name='android\.permission\.INTERNET'/.test(badging)) {
    problems.push("missing INTERNET permission");
  }
  if (!/uses-permission: name='android\.permission\.REQUEST_INSTALL_PACKAGES'/.test(badging)) {
    problems.push("missing REQUEST_INSTALL_PACKAGES (self-update cannot open the installer)");
  }
  // xmltree prints: A: android:usesCleartextTraffic(0x010104ec)=(type 0x12)0xffffffff
  if (!/usesCleartextTraffic\([^)]*\)=\(type 0x12\)0xffffffff/.test(manifestTree)) {
    problems.push("usesCleartextTraffic is not true — the app could not reach the Hub over Tailscale HTTP");
  }
  return problems;
}

function findAapt2() {
  const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (home && existsSync(join(home, "build-tools"))) {
    const versions = readdirSync(join(home, "build-tools")).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    );
    for (const v of versions.reverse()) {
      const p = join(home, "build-tools", v, "aapt2");
      if (existsSync(p)) return p;
    }
  }
  return "aapt2";
}

function main() {
  const args = process.argv.slice(2);
  const apk = args.find((a) => !a.startsWith("--"));
  const i = args.indexOf("--version-code");
  const expected = i >= 0 ? Number(args[i + 1]) : null;
  if (!apk || !existsSync(apk)) {
    console.error(`verify-apk: APK not found: ${apk ?? "(none)"}`);
    process.exit(1);
  }
  const aapt2 = findAapt2();
  const run = (sub) => execFileSync(aapt2, ["dump", ...sub, apk], { encoding: "utf8", maxBuffer: 64 << 20 });
  const problems = checkApkDump(
    { badging: run(["badging"]), manifestTree: run(["xmltree", "--file", "AndroidManifest.xml"]) },
    expected,
  );
  if (problems.length) {
    console.error(`verify-apk: REFUSED ${apk}\n  - ${problems.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(`verify-apk: OK ${apk}`);
}

if (process.argv[1]?.endsWith("verify-apk.mjs")) main();
