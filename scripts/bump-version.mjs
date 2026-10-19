#!/usr/bin/env node
/** Set one version everywhere a release tag must match: apps/mobile/app.json and apps/desktop/package.json. */
import { readFileSync, writeFileSync } from "node:fs";

const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v ?? "")) {
  console.error("usage: node scripts/bump-version.mjs <major.minor.patch>");
  process.exit(2);
}
for (const [file, set] of [
  ["apps/mobile/app.json", (j) => (j.expo.version = v)],
  ["apps/desktop/package.json", (j) => (j.version = v)],
]) {
  const j = JSON.parse(readFileSync(file, "utf8"));
  set(j);
  writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
  console.log(`${file} → ${v}`);
}
console.log(`next: git commit, git tag v${v}, git push --tags`);
