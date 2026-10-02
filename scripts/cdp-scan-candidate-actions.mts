/**
 * One-shot live CDP scan for model_select / file_attach / composer_history_open.
 * Read-only — does not mutate the pack. Does not kill Cursor.
 */
import {
  fetchCdpTargetList,
  selectWindowTargets,
} from "../packages/adapters/live-cursor/src/cdp-http.ts";
import { CdpWebSocketClient } from "../packages/adapters/live-cursor/src/cdp-client.ts";
import {
  createDefaultSelectorPack,
  type SelectorActionId,
} from "../packages/adapters/live-cursor/src/selector-pack.ts";
import {
  assertLoopbackCdpUrl,
  normalizeCdpUrl,
} from "../packages/adapters/live-cursor/src/loopback.ts";

const CDP_URL = normalizeCdpUrl(process.env.CDP_URL ?? "http://127.0.0.1:9222");
assertLoopbackCdpUrl(CDP_URL);

const ACTIONS: readonly SelectorActionId[] = [
  "model_select",
  "file_attach",
  "composer_history_open",
];

const LOW_CONFIDENCE = new Set([
  "textarea",
  "[contenteditable='true']",
  "[role='textbox'][data-placeholder]",
  "[role='menuitem']",
  "button[aria-label*='Run']",
  "button[aria-label*='Continue']",
  "button[aria-label*='Cancel']",
  "button[aria-label*='Allow']",
]);

interface RuntimeEvaluateResult {
  result?: { type?: string; value?: unknown };
  exceptionDetails?: { text?: string };
}

async function queryFirstHit(
  client: CdpWebSocketClient,
  strategies: string[],
): Promise<Record<string, unknown> | null> {
  for (const strategy of strategies) {
    const expression = `(() => {
      let el;
      try { el = document.querySelector(${JSON.stringify(strategy)}); }
      catch (e) { return { error: String(e) }; }
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return {
        width: r.width,
        height: r.height,
        tag: el.tagName,
        aria: el.getAttribute("aria-label"),
        title: el.getAttribute("title"),
        cls: (el.className || "").toString().slice(0, 160),
        text: (el.textContent || "").trim().slice(0, 100),
      };
    })()`;
    const evalResult = await client.send<RuntimeEvaluateResult>(
      "Runtime.evaluate",
      { expression, returnByValue: true },
    );
    const value = evalResult.result?.value as
      | Record<string, unknown>
      | null
      | undefined;
    if (!value || typeof value !== "object" || "error" in value) continue;
    return {
      strategy,
      confidence: LOW_CONFIDENCE.has(strategy) ? "low" : "high",
      ...value,
    };
  }
  return null;
}

const SCAN_EXPR = `(() => {
  const out = [];
  const sels = [
    ".ui-model-picker__trigger",
    ".composer-unified-dropdown-model",
    ".composer-unified-dropdown",
    "[aria-label*='Model']",
    "[aria-label*='Add Context']",
    "[aria-label*='Add context']",
    "[aria-label*='Attach']",
    "[aria-label*='@']",
    "[title*='Attach']",
    "[title*='Context']",
    "[data-composer-id]",
    ".glass-sidebar-agent-menu-btn",
    ".agent-sidebar-cell",
    "span.auxiliary-bar-chat-title",
    "[aria-label*='History']",
    "[aria-label*='Previous Chats']",
    "[aria-label*='Chat History']",
    ".composer-bar-input-buttons button",
    ".composer-bar button",
  ];
  for (const s of sels) {
    try {
      const els = document.querySelectorAll(s);
      for (const el of Array.from(els).slice(0, 4)) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        out.push({
          s,
          tag: el.tagName,
          aria: el.getAttribute("aria-label"),
          title: el.getAttribute("title"),
          cls: (el.className || "").toString().slice(0, 140),
          text: (el.textContent || "").trim().slice(0, 60),
          w: Math.round(r.width),
          h: Math.round(r.height),
        });
      }
    } catch {}
  }
  const bar =
    document.querySelector(".composer-bar") ||
    document.querySelector("[class*='composer-bar']");
  if (bar) {
    const btns = bar.querySelectorAll("button, [role='button'], [aria-label]");
    for (const el of Array.from(btns).slice(0, 50)) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      out.push({
        s: "composer-bar-dump",
        tag: el.tagName,
        aria: el.getAttribute("aria-label"),
        title: el.getAttribute("title"),
        cls: (el.className || "").toString().slice(0, 140),
        text: (el.textContent || "").trim().slice(0, 60),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
  }
  return out;
})()`;

async function main(): Promise<void> {
  const pack = createDefaultSelectorPack();
  const list = await fetchCdpTargetList(CDP_URL, 3000);
  if (!list.ok) throw new Error(list.error);
  const windows = selectWindowTargets(list.data).filter(
    (t) => t.webSocketDebuggerUrl,
  );
  console.log(`targets: ${windows.length}`);
  for (const t of windows.slice(0, 6)) {
    console.log(`  - ${t.title?.slice(0, 80) || "(no title)"}`);
  }

  for (const target of windows) {
    const client = await CdpWebSocketClient.connect(target.webSocketDebuggerUrl!);
    try {
      await client.send("Runtime.enable");
      console.log(`\n=== ${target.title?.slice(0, 70) || target.id} ===`);
      for (const a of ACTIONS) {
        const hit = await queryFirstHit(client, pack.actions[a].strategies);
        console.log(
          hit
            ? `${a}: ${JSON.stringify(hit)}`
            : `${a}: NO MATCH`,
        );
      }
      const scan = await client.send<RuntimeEvaluateResult>("Runtime.evaluate", {
        expression: SCAN_EXPR,
        returnByValue: true,
      });
      const rows = (scan.result?.value as unknown[]) || [];
      console.log(`scan hits: ${rows.length}`);
      for (const r of rows.slice(0, 80)) {
        console.log(JSON.stringify(r));
      }
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

await main();
