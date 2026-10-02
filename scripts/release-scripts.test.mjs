/**
 * Release tooling: publish-apk-to-hub.mjs end to end against a temp Hub dir,
 * versionCode rule shared with apps/mobile/app.config.ts, and hook wiring.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { versionCodeFor } from "./publish-apk-to-hub.mjs";
import { checkApkDump } from "./verify-apk.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts/publish-apk-to-hub.mjs");
const temps = [];
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tmp() {
  const d = mkdtempSync(join(tmpdir(), "cm-release-test-"));
  temps.push(d);
  return d;
}

describe("versionCodeFor", () => {
  it("maps x.y.z to major*10000 + minor*100 + patch", () => {
    assert.equal(versionCodeFor("0.1.0"), 100);
    assert.equal(versionCodeFor("0.1.1"), 101);
    assert.equal(versionCodeFor("1.2.3"), 10203);
  });
  it("is strictly increasing across ordinary bumps", () => {
    const seq = ["0.1.0", "0.1.1", "0.1.99", "0.2.0", "1.0.0"].map(versionCodeFor);
    for (let i = 1; i < seq.length; i++) assert.ok(seq[i] > seq[i - 1]);
  });
  it("rejects non-semver and out-of-range parts", () => {
    assert.equal(versionCodeFor("v1"), null);
    assert.equal(versionCodeFor("0.100.0"), null);
  });
  it("matches the mobile app.config.ts rule", () => {
    const src = readFileSync(join(root, "apps/mobile/app.config.ts"), "utf8");
    assert.match(src, /major \* 10000 \+ minor \* 100 \+ patch/);
  });
});

describe("publish-apk-to-hub", () => {
  it("installs APK + atomic latest.json the Hub accepts, pruning older APKs", () => {
    const work = tmp();
    const dest = join(work, "releases");
    const apk = join(work, "app-release.apk");
    const bytes = Buffer.from("PK\u0003\u0004 not a real apk");
    writeFileSync(apk, bytes);

    execFileSync("node", [script, "--apk", apk, "--dest", dest, "--tests-passed", "42"]);
    writeFileSync(join(dest, "stale-0.0.1.apk"), "old");
    execFileSync("node", [script, "--apk", apk, "--dest", dest, "--tests-passed", "42"]);

    const manifest = JSON.parse(readFileSync(join(dest, "latest.json"), "utf8"));
    const appVersion = JSON.parse(readFileSync(join(root, "apps/mobile/app.json"), "utf8")).expo.version;
    assert.equal(manifest.versionName, appVersion);
    assert.equal(manifest.versionCode, versionCodeFor(appVersion));
    assert.equal(manifest.sizeBytes, bytes.length);
    assert.equal(manifest.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(manifest.md5, createHash("md5").update(bytes).digest("hex"));
    assert.equal(manifest.testsPassed, 42);
    assert.equal(manifest.source, "local");
    assert.deepEqual(readdirSync(dest).sort(), [manifest.apkFile, "latest.json"].sort());
  });

  it("fails clearly when the APK is missing", () => {
    const work = tmp();
    assert.throws(
      () =>
        execFileSync("node", [script, "--apk", join(work, "nope.apk"), "--dest", work], {
          stdio: "pipe",
        }),
      /APK not found/,
    );
  });

  it("--manifest-only writes latest.json beside the APK for CI", () => {
    const work = tmp();
    const apk = join(work, "app-release.apk");
    writeFileSync(apk, "PK fake");
    execFileSync("node", [script, "--apk", apk, "--manifest-only", "--source", "github"]);
    const manifest = JSON.parse(readFileSync(join(work, "latest.json"), "utf8"));
    assert.equal(manifest.source, "github");
    assert.ok(existsSync(join(work, manifest.apkFile)));
  });
});

describe("hook + CI wiring", () => {
  it("pre-push hook runs the release gate", () => {
    const hook = readFileSync(join(root, ".githooks/pre-push"), "utf8");
    assert.match(hook, /scripts\/release-gate\.sh/);
  });
  it("CI runs the same gate before building the APK", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    assert.match(ci, /GATE_CI: "1"/);
    assert.match(ci, /bash scripts\/release-gate\.sh/);
    assert.match(ci, /needs: gate/);
  });
  it("a newer push to the same branch/PR cancels the older run (tags never cancelled)", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    assert.match(ci, /concurrency:\s*\n\s*group: ci-\$\{\{ github\.ref \}\}/);
    assert.match(ci, /cancel-in-progress: \$\{\{ !startsWith\(github\.ref, 'refs\/tags\/'\) \}\}/);
  });
  it("CI jobs all run on the node1 self-hosted runner", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    const runsOn = ci.match(/runs-on: .*/g) ?? [];
    assert.ok(runsOn.length >= 3);
    for (const r of runsOn) assert.equal(r, "runs-on: [self-hosted, node1]");
  });
});

describe("verify-apk checks the built APK", () => {
  const badging = [
    "package: name='local.cursor.mobile' versionCode='101' versionName='0.1.1'",
    "uses-permission: name='android.permission.INTERNET'",
    "uses-permission: name='android.permission.REQUEST_INSTALL_PACKAGES'",
  ].join("\n");
  const cleartextOn =
    "E: application\n  A: http://schemas.android.com/apk/res/android:usesCleartextTraffic(0x010104ec)=(type 0x12)0xffffffff";

  it("accepts a good release", () => {
    assert.deepEqual(checkApkDump({ badging, manifestTree: cleartextOn }, 101), []);
  });
  it("accepts the build-tools 36 aapt2 spelling (=true)", () => {
    const tree =
      "E: application\n  A: http://schemas.android.com/apk/res/android:usesCleartextTraffic(0x010104ec)=true";
    assert.deepEqual(checkApkDump({ badging, manifestTree: tree }, 101), []);
    assert.match(checkApkDump({ badging, manifestTree: tree.replace("=true", "=false") }, 101).join(), /usesCleartextTraffic/);
  });
  it("refuses an APK without cleartext (it could never reach the Hub to self-update)", () => {
    const p = checkApkDump({ badging, manifestTree: "E: application" }, 101);
    assert.match(p.join(), /usesCleartextTraffic/);
    const off = cleartextOn.replace("0xffffffff", "0x0");
    assert.match(checkApkDump({ badging, manifestTree: off }, 101).join(), /usesCleartextTraffic/);
  });
  it("refuses a missing install permission, wrong package or versionCode", () => {
    const noInstall = badging.replace(/.*REQUEST_INSTALL_PACKAGES.*/, "");
    assert.match(checkApkDump({ badging: noInstall, manifestTree: cleartextOn }, 101).join(), /REQUEST_INSTALL/);
    assert.match(checkApkDump({ badging, manifestTree: cleartextOn }, 102).join(), /versionCode is 101/);
    const other = badging.replace("local.cursor.mobile", "x.y");
    assert.match(checkApkDump({ badging: other, manifestTree: cleartextOn }, 101).join(), /package is x.y/);
  });
  it("release script and CI both run verify-apk before publishing", () => {
    const local = readFileSync(join(root, "scripts/release-apk-local.sh"), "utf8");
    assert.ok(local.indexOf("verify-apk.mjs") < local.indexOf("publish-apk-to-hub.mjs \${TESTS"));
    assert.match(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"), /verify-apk\.mjs/);
  });
  it("mobile config wires the cleartext plugin", () => {
    assert.match(readFileSync(join(root, "apps/mobile/app.config.ts"), "utf8"), /with-cleartext-hub/);
  });
});
