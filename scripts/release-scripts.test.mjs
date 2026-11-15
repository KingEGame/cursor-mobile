/**
 * Release tooling: version code math, APK verification rules, CI shape.
 *   node --test scripts/release-scripts.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkApkDump } from "./verify-apk.mjs";
import { versionCodeFor } from "./version-code.mjs";

const ok = {
  badging: "package: name='local.cursor.mobile' versionCode='200' versionName='0.2.0'\nuses-permission: name='android.permission.INTERNET'",
  manifestTree: "A: android:usesCleartextTraffic(0x010104ec)=true",
};

describe("versionCodeFor", () => {
  it("maps x.y.z monotonically", () => {
    assert.equal(versionCodeFor("0.1.8"), 108);
    assert.equal(versionCodeFor("0.2.0"), 200);
    assert.ok(versionCodeFor("1.0.0") > versionCodeFor("0.99.99"));
    assert.throws(() => versionCodeFor("1.100.0"));
  });
});

describe("verify-apk", () => {
  it("accepts a good APK", () => assert.deepEqual(checkApkDump(ok, 200), []));
  it("refuses missing cleartext (phone could not reach the PC)", () => {
    assert.match(checkApkDump({ ...ok, manifestTree: "" }, 200).join(), /usesCleartextTraffic/);
  });
  it("refuses a wrong versionCode and a leftover installer permission", () => {
    const bad = { ...ok, badging: ok.badging + "\nuses-permission: name='android.permission.REQUEST_INSTALL_PACKAGES'" };
    const p = checkApkDump(bad, 201).join("\n");
    assert.match(p, /versionCode is 200/);
    assert.match(p, /REQUEST_INSTALL_PACKAGES/);
  });
});

describe("CI", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  it("gate → android-apk → release, no Hub/desktop jobs", () => {
    assert.match(ci, /android-apk:[\s\S]*needs: gate/);
    assert.match(ci, /needs: \[gate, android-apk\]/);
    assert.doesNotMatch(ci, /hub-desktop|publish-apk-to-hub/);
  });
  it("tag builds are never cancelled", () => {
    assert.match(ci, /cancel-in-progress: \$\{\{ !startsWith\(github\.ref, 'refs\/tags\/'\) \}\}/);
  });
});
