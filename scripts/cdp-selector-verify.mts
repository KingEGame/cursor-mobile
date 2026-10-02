/**
 * Live CDP selector match → optional selector-pack VERIFIED flip.
 *
 * High confidence = a pack CSS strategy hits live DOM via document.querySelector
 * with a positive bounding box, and the strategy is not on the low-confidence
 * denylist (bare textarea / contenteditable / etc.).
 *
 * Does NOT mark VERIFIED without live matches. Does not kill Cursor.
 *
 * Usage:
 *   npx tsx scripts/cdp-selector-verify.mts
 *   npx tsx scripts/cdp-selector-verify.mts --write
 *   CDP_URL=http://127.0.0.1:9222 npx tsx scripts/cdp-selector-verify.mts --write
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fetchCdpTargetList,
  fetchCdpVersion,
  selectWindowTargets,
} from "../packages/adapters/live-cursor/src/cdp-http.ts";
import { CdpWebSocketClient } from "../packages/adapters/live-cursor/src/cdp-client.ts";
import {
  createDefaultSelectorPack,
  type SelectorActionId,
} from "../packages/adapters/live-cursor/src/selector-pack.ts";
import { assertLoopbackCdpUrl, normalizeCdpUrl } from "../packages/adapters/live-cursor/src/loopback.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const PACK_PATH = join(
  REPO_ROOT,
  "packages/adapters/live-cursor/src/selector-pack.ts",
);

const CDP_URL = normalizeCdpUrl(process.env.CDP_URL ?? "http://127.0.0.1:9222");
const WRITE = process.argv.includes("--write");
const DRY =
  (process.env.VERIFY_DRY_RUN ?? "").toLowerCase() === "1" ||
  (process.env.VERIFY_DRY_RUN ?? "").toLowerCase() === "true";

/** Strategies too generic / false-positive to count as live Composer proof alone. */
const LOW_CONFIDENCE_STRATEGIES = new Set([
  "textarea",
  "[contenteditable='true']",
  "[role='textbox'][data-placeholder]",
  "[role='menuitem']",
  "button[aria-label*='Run']",
  "button[aria-label*='Continue']",
  "button[aria-label*='Cancel']",
  "button[aria-label*='Allow']",
  // Getting Started / onboarding Skip — not tool-call Deny (Cursor 3.22 Agents)
  "button[aria-label*='Skip']",
  "[role='button'][aria-label*='Skip']",
  // Mode dropdown (Agent/Ask) — not model picker
  ".composer-unified-dropdown",
  ".composer-unified-dropdown[aria-expanded='true']",
  // Shared context-menu class also used by mode picker
  ".composer-unified-context-menu-item",
  // Bare open menus without model/testid specificity
  "[role='menu']:not([hidden])",
  "[role='menu'][data-state='open']",
]);

/**
 * Actions flipped to VERIFIED on high-confidence live DOM hits.
 * model_select / file_attach need picker/@ UI open; composer_history_open is best-effort.
 */
const FLIP_ACTIONS: readonly SelectorActionId[] = [
  "send_message",
  "approve",
  "deny",
  "model_select",
  "file_attach",
  "composer_history_open",
];

interface RuntimeEvaluateResult {
  result?: { type?: string; value?: unknown };
  exceptionDetails?: { text?: string };
}

interface StrategyHit {
  strategy: string;
  confidence: "high" | "low";
  box: { width: number; height: number };
}

async function queryFirstHit(
  client: CdpWebSocketClient,
  strategies: string[],
): Promise<StrategyHit | null> {
  for (const strategy of strategies) {
    const expression = `(() => {
      let el;
      try {
        el = document.querySelector(${JSON.stringify(strategy)});
      } catch (e) {
        return { error: String(e) };
      }
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return { width: r.width, height: r.height };
    })()`;
    const evalResult = await client.send<RuntimeEvaluateResult>(
      "Runtime.evaluate",
      { expression, returnByValue: true },
    );
    if (evalResult.exceptionDetails) continue;
    const value = evalResult.result?.value as
      | { width: number; height: number }
      | { error: string }
      | null
      | undefined;
    if (!value || typeof value !== "object" || "error" in value) continue;
    if (typeof value.width !== "number" || typeof value.height !== "number") {
      continue;
    }
    return {
      strategy,
      confidence: LOW_CONFIDENCE_STRATEGIES.has(strategy) ? "low" : "high",
      box: { width: value.width, height: value.height },
    };
  }
  return null;
}

function patchActionVerified(
  source: string,
  action: SelectorActionId,
  verifiedAt: string,
  verifiedAgainst: string,
): string {
  const anchor = `${action}: {`;
  const start = source.indexOf(anchor);
  if (start < 0) {
    throw new Error(`Could not find action block for ${action} in selector-pack.ts`);
  }
  // Slice until next sibling action or end of actions map.
  const rest = source.slice(start);
  const nextKeys = FLIP_ACTIONS.filter((id) => id !== action);
  let endRel = rest.length;
  for (const key of nextKeys) {
    const idx = rest.indexOf(`\n      ${key}: {`);
    if (idx > 0 && idx < endRel) endRel = idx;
  }
  const closing = rest.indexOf("\n    },");
  if (closing > 0 && closing < endRel) endRel = closing + "\n    },".length;

  const block = rest.slice(0, endRel);
  if (!block.includes(`verification: "CANDIDATE"`)) {
    if (block.includes(`verification: "VERIFIED"`)) {
      console.log(`  ${action}: already VERIFIED — leaving as-is`);
      return source;
    }
    throw new Error(`${action}: unexpected verification flag in pack source`);
  }

  const updated = block
    .replace(`verification: "CANDIDATE"`, `verification: "VERIFIED"`)
    .replace(/verifiedAt:\s*null/, `verifiedAt: "${verifiedAt}"`)
    .replace(
      /verifiedAgainst:\s*null/,
      `verifiedAgainst: ${JSON.stringify(verifiedAgainst)}`,
    );

  return source.slice(0, start) + updated + source.slice(start + endRel);
}

async function main(): Promise<number> {
  assertLoopbackCdpUrl(CDP_URL);
  console.log(`CDP URL: ${CDP_URL}`);
  console.log(`Write pack: ${WRITE && !DRY ? "yes" : "no (dry)"}`);
  console.log();

  const version = await fetchCdpVersion(CDP_URL, 3000);
  if (!version.ok) {
    console.error(`CDP /json/version failed: ${version.error}`);
    return 2;
  }

  const browser =
    typeof version.data.Browser === "string" && version.data.Browser.length > 0
      ? version.data.Browser
      : "unknown-Cursor-CDP";
  console.log(`Browser: ${browser}`);

  const list = await fetchCdpTargetList(CDP_URL, 3000);
  if (!list.ok) {
    console.error(`CDP /json/list failed: ${list.error}`);
    return 2;
  }

  const windows = selectWindowTargets(list.data);
  const withWs = windows.filter((t) => t.webSocketDebuggerUrl);
  if (withWs.length === 0) {
    console.error("No CDP targets with webSocketDebuggerUrl");
    return 2;
  }

  console.log(`Targets with WS: ${withWs.length}`);
  for (const t of withWs.slice(0, 8)) {
    console.log(`  - [${t.type}] ${t.title.slice(0, 80) || "(no title)"}`);
  }
  console.log();

  const pack = createDefaultSelectorPack();
  const bestHits = new Map<SelectorActionId, StrategyHit>();

  for (const target of withWs) {
    const wsUrl = target.webSocketDebuggerUrl!;
    let client: CdpWebSocketClient;
    try {
      client = await CdpWebSocketClient.connect(wsUrl);
    } catch (err) {
      console.warn(
        `  skip target ${target.id}: ${err instanceof Error ? err.message : err}`,
      );
      continue;
    }
    try {
      await client.send("Runtime.enable");
      for (const actionId of FLIP_ACTIONS) {
        if (bestHits.get(actionId)?.confidence === "high") continue;
        const action = pack.actions[actionId];
        const hit = await queryFirstHit(client, action.strategies);
        if (!hit) continue;
        const prev = bestHits.get(actionId);
        if (!prev || (prev.confidence === "low" && hit.confidence === "high")) {
          bestHits.set(actionId, hit);
        }
      }
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  console.log("Match results (live DOM):");
  console.log("─────────────────────────────────────────────");
  let highCount = 0;
  for (const actionId of FLIP_ACTIONS) {
    const hit = bestHits.get(actionId);
    if (!hit) {
      console.log(`  ${actionId}: NO MATCH`);
      continue;
    }
    console.log(
      `  ${actionId}: ${hit.confidence.toUpperCase()} ← ${hit.strategy} (${Math.round(hit.box.width)}×${Math.round(hit.box.height)})`,
    );
    if (hit.confidence === "high") highCount += 1;
  }
  console.log("─────────────────────────────────────────────");
  console.log();

  const sendHit = bestHits.get("send_message");
  if (!sendHit || sendHit.confidence !== "high") {
    console.error(
      "FAIL: send_message has no high-confidence live match.\n" +
        "  Open Composer on the Cursor target, then re-run.\n" +
        "  Selector pack was NOT marked VERIFIED.",
    );
    return 3;
  }

  const toFlip = FLIP_ACTIONS.filter(
    (id) => bestHits.get(id)?.confidence === "high",
  );
  const verifiedAt = new Date().toISOString();
  const verifiedAgainst = `${browser} · live CDP match ${verifiedAt.slice(0, 10)}`;

  if (WRITE && !DRY) {
    let source = readFileSync(PACK_PATH, "utf8");
    for (const actionId of toFlip) {
      const before = source;
      source = patchActionVerified(
        source,
        actionId,
        verifiedAt,
        verifiedAgainst,
      );
      if (source !== before) {
        console.log(`Updated pack: ${actionId} → VERIFIED`);
      }
    }
    writeFileSync(PACK_PATH, source, "utf8");
    console.log(`Wrote ${PACK_PATH}`);
  } else {
    console.log(
      `Would mark VERIFIED (${toFlip.join(", ")}) — pass --write to persist.`,
    );
  }

  console.log();
  console.log(`High-confidence matches: ${highCount}/${FLIP_ACTIONS.length}`);
  console.log("Next step:");
  console.log("  1. Restart Hub so it reloads the selector pack:");
  console.log("       ./scripts/start-hub-tailscale.sh");
  console.log("  2. Send a test message from the phone (or Hub POST messages).");
  console.log(
    "  3. Spot-check Approve/Deny on PC if those actions were flipped.",
  );
  return 0;
}

const code = await main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  return 1;
});
process.exit(code);
