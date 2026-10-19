import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkForUpdate, expectedHash, isNewer, parseVersion, pickAsset, posixSwapScript, sha256File, verifyDownload, windowsSwapScript } from "./updater.mjs";

const release = (tag) => ({
  tag_name: tag,
  html_url: "https://example/r",
  assets: [
    { name: "app-release.apk", browser_download_url: "u0", size: 1 },
    { name: "cursor-mobile-hub-0.2.0-win-x64.exe", browser_download_url: "u1", size: 10 },
    { name: "cursor-mobile-hub-0.2.0-linux-x64.AppImage", browser_download_url: "u2", size: 20 },
    { name: "cursor-mobile-hub-0.2.0-darwin-arm64.zip", browser_download_url: "u3", size: 30 },
    { name: "cursor-mobile-hub-0.2.0-darwin-x64.zip", browser_download_url: "u4", size: 40 },
  ],
});
const fakeFetch = (body, ok = true) => async () => ({ ok, status: ok ? 200 : 500, json: async () => body });

describe("versions", () => {
  it("parses and compares", () => {
    assert.deepEqual(parseVersion("v1.2.3"), [1, 2, 3]);
    assert.equal(parseVersion("nope"), null);
    assert.equal(isNewer("v0.1.10", "0.1.9"), true);
    assert.equal(isNewer("v0.1.4", "0.1.4"), false);
    assert.equal(isNewer("garbage", "0.1.4"), false);
  });
});

describe("pickAsset", () => {
  it("chooses per platform and arch", () => {
    assert.equal(pickAsset(release("v0.2.0"), "win32", "x64").browser_download_url, "u1");
    assert.equal(pickAsset(release("v0.2.0"), "linux", "x64").browser_download_url, "u2");
    assert.equal(pickAsset(release("v0.2.0"), "darwin", "arm64").browser_download_url, "u3");
    assert.equal(pickAsset(release("v0.2.0"), "freebsd", "x64"), null);
  });
});

describe("checkForUpdate", () => {
  const base = { current: "0.1.4", platform: "win32", arch: "x64" };
  it("reports a newer release", async () => {
    const r = await checkForUpdate({ ...base, fetchImpl: fakeFetch(release("v0.2.0")) });
    assert.equal(r.available, true);
    assert.equal(r.asset.name, "cursor-mobile-hub-0.2.0-win-x64.exe");
  });
  it("reports up to date", async () => {
    assert.equal((await checkForUpdate({ ...base, fetchImpl: fakeFetch(release("v0.1.4")) })).available, false);
  });
  it("throws on HTTP failure and on a missing platform build", async () => {
    await assert.rejects(checkForUpdate({ ...base, fetchImpl: fakeFetch({}, false) }), /500/);
    await assert.rejects(checkForUpdate({ ...base, platform: "freebsd", fetchImpl: fakeFetch(release("v0.2.0")) }), /no build/);
  });
});

describe("windowsSwapScript", () => {
  it("quotes paths with apostrophes", () => {
    const s = windowsSwapScript({ pid: 42, newFile: "C:\\u\\O'Neil\\new.exe", targetFile: "C:\\a.exe", scriptFile: "C:\\s.ps1", okFile: "C:\\ok" });
    assert.match(s.body, /O''Neil/);
    assert.match(s.body, /Id 42/);
    assert.match(s.body, /a\.exe\.bak/);
  });
  it("posix script rolls back when the ok file never appears", () => {
    const s = posixSwapScript({ pid: 7, newFile: "/t/new", targetFile: "/a/App Image", scriptFile: "/t/s.sh", okFile: "/t/ok" });
    assert.match(s.body, /kill -0 7/);
    assert.match(s.body, /mv -f '\/a\/App Image\.bak' '\/a\/App Image'/);
  });
});

describe("checksum verification", () => {
  const dir = mkdtempSync(join(tmpdir(), "upd-"));
  const file = join(dir, "x.exe");
  writeFileSync(file, "hello");
  const hello = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
  const sums = (hash) => async () => ({ ok: true, status: 200, text: async () => `${hash}  x.exe\n` });
  it("parses listings", () => assert.equal(expectedHash(`${hello}  x.exe\n`, "x.exe"), hello));
  it("hashes a file", async () => assert.equal(await sha256File(file), hello));
  it("accepts a match", async () => {
    await verifyDownload({ file, name: "x.exe", sumsUrl: "u", fetchImpl: sums(hello) });
  });
  it("rejects a mismatch, a missing entry and a missing listing", async () => {
    await assert.rejects(verifyDownload({ file, name: "x.exe", sumsUrl: "u", fetchImpl: sums("0".repeat(64)) }), /mismatch/);
    await assert.rejects(verifyDownload({ file, name: "y.exe", sumsUrl: "u", fetchImpl: sums(hello) }), /not listed/);
    await assert.rejects(verifyDownload({ file, name: "x.exe", sumsUrl: null }), /unverified/);
  });
});
