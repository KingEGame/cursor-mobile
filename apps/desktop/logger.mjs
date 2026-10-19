/** Size-rotated file log for the Hub shell and its child (the packaged app has no console). */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 1_000_000;
const KEEP = 3;

export function createLogger(dir, { now = () => new Date() } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "hub.log");

  function rotate() {
    try {
      if (!existsSync(file) || statSync(file).size < MAX_BYTES) return;
      rmSync(`${file}.${KEEP}`, { force: true });
      for (let i = KEEP - 1; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      renameSync(file, `${file}.1`);
    } catch {
      /* logging must never take the app down */
    }
  }

  function write(source, text) {
    const lines = String(text).split(/\r?\n/).filter(Boolean);
    if (!lines.length) return;
    rotate();
    try {
      appendFileSync(file, lines.map((l) => `${now().toISOString()} [${source}] ${l}\n`).join(""));
    } catch {
      /* disk full / read-only: drop the line */
    }
  }

  return { file, dir, write, info: (t) => write("shell", t) };
}
