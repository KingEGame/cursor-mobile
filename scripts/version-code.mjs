#!/usr/bin/env node
/** Android versionCode from the app version: major * 10000 + minor * 100 + patch (mirrors app.config.ts). */
import { readFileSync } from "node:fs";

export function versionCodeFor(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) throw new Error(`app version "${version}" must be x.y.z`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (minor > 99 || patch > 99) throw new Error(`app version "${version}": minor/patch must be <= 99`);
  return major * 10000 + minor * 100 + patch;
}

export function appVersion(root = ".") {
  return JSON.parse(readFileSync(`${root}/apps/mobile/app.json`, "utf8")).expo.version;
}

if (process.argv[1]?.endsWith("version-code.mjs")) console.log(versionCodeFor(appVersion()));
