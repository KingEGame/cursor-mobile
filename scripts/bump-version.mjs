#!/usr/bin/env node
/** Set the app version a release tag must match (apps/mobile/app.json). */
import { readFileSync, writeFileSync } from "node:fs";

const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v ?? "")) {
  console.error("usage: node scripts/bump-version.mjs <major.minor.patch>");
  process.exit(2);
}
const file = "apps/mobile/app.json";
const j = JSON.parse(readFileSync(file, "utf8"));
j.expo.version = v;
writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
console.log(`${file} → ${v}\nnext: git commit, git tag v${v}, git push --tags`);
