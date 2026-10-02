/**
 * CDP scrape of Composer model picker options (loopback only).
 * Fail-closed: returns ok=false when picker cannot be opened or menu is empty.
 */

import type { CdpClient } from "./cdp-client.js";
import { dispatchClick } from "./cdp-input.js";

export interface ScrapedModel {
  id: string;
  label: string;
  family: string;
  available: boolean;
  default: boolean;
}

export type ModelScrapeResult =
  | {
      ok: true;
      models: ScrapedModel[];
      strategy: string;
      methods: string[];
    }
  | {
      ok: false;
      error: string;
      methods: string[];
    };

/** Trigger-only strategies — open the picker, not menu rows. */
export const MODEL_PICKER_TRIGGER_STRATEGIES = [
  ".vscode-model-picker__trigger-text",
  "[class*='vscode-model-picker__trigger']",
  ".ui-model-picker__trigger",
  "button[aria-label*='Model']",
  "[aria-label='Model']",
] as const;

interface RuntimeEvaluateResult {
  result?: {
    type?: string;
    value?: unknown;
  };
  exceptionDetails?: { text?: string };
}

function slugifyModelId(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "model";
}

function guessFamily(label: string): string {
  const lower = label.toLowerCase();
  if (lower.includes("composer")) return "composer";
  if (lower.includes("claude")) return "claude";
  if (lower.includes("gpt") || lower.includes("o1") || lower.includes("o3"))
    return "openai";
  if (lower === "auto" || lower.startsWith("auto ")) return "auto";
  return "other";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readPickerLabels(
  client: CdpClient,
  methods: string[],
): Promise<{ labels: string[]; current: string | null }> {
  const expression = `(() => {
    const labels = [];
    const seen = new Set();
    const push = (raw) => {
      let t = (raw || "").replace(/\\s+/g, " ").trim();
      // Strip zero-width / "New" badge noise from Cursor model rows
      t = t.replace(/[\\u200b\\u200c\\u200d\\ufeff]/g, "").replace(/\\s*New$/i, "").trim();
      if (!t || t.length > 120) return;
      if (/^(add models|manage models|view all models)$/i.test(t)) return;
      const key = t.toLowerCase();
      if (seen.has(key)) return;
      // Skip Agent/Ask mode rows accidentally present near model UI
      if (/^(agent|ask|edit|manual|help|selection|more|file|edit|view|go|run|terminal)$/i.test(t)) return;
      seen.add(key);
      labels.push(t);
    };
    const selectors = [
      "[data-testid='selected-model-list-submenu'] [role='menuitem']",
      "[data-testid='selected-model-list-submenu'] [role='option']",
      "[data-testid='selected-auto-menu'] [role='menuitem']",
      "[role='menu'][data-testid='selected-auto-menu'] [role='menuitem']",
      "[data-testid='model-picker-menu'] [role='menuitem']",
      "[data-testid='model-picker-menu'] [role='option']",
      "[role='menu'][data-state='open'] [role='menuitem']",
      ".ui-menu [role='menuitem']:not(.menubar-menu-button)",
      ".ui-menu__submenu [role='menuitem']",
      "[class*='ui-menu__submenu'] [role='menuitem']",
      ".composer-unified-dropdown-model .composer-unified-context-menu-item",
      ".composer-unified-dropdown-model [role='menuitem']",
      "[class*='vscode-model-picker'] [role='menuitem']",
      "[class*='model-picker'] [role='menuitem']",
    ];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        // Skip top menubar and submenu triggers that only re-open panels
        const cls = String(el.className || "");
        if (cls.includes("menubar-menu-button")) continue;
        push(el.getAttribute("aria-label") || el.textContent || "");
      }
    }
    let current = null;
    const trigger =
      document.querySelector(".vscode-model-picker__trigger-text") ||
      document.querySelector("[class*='vscode-model-picker__trigger']") ||
      document.querySelector(".ui-model-picker__trigger") ||
      document.querySelector("button[aria-label*='Model']");
    if (trigger) {
      current = (trigger.getAttribute("aria-label") || trigger.textContent || "")
        .replace(/\\s+/g, " ")
        .trim() || null;
      if (current && /^model$/i.test(current)) current = null;
    }
    return { labels, current };
  })()`;
  methods.push("Runtime.evaluate");
  const evalResult = await client.send<RuntimeEvaluateResult>("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (evalResult.exceptionDetails) {
    return { labels: [], current: null };
  }
  const value = evalResult.result?.value as
    | { labels?: string[]; current?: string | null }
    | null
    | undefined;
  return {
    labels: Array.isArray(value?.labels) ? value!.labels! : [],
    current: typeof value?.current === "string" ? value.current : null,
  };
}

async function pressEscape(client: CdpClient, methods: string[]): Promise<void> {
  methods.push("Input.dispatchKeyEvent");
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    windowsVirtualKeyCode: 27,
    key: "Escape",
    code: "Escape",
  });
  methods.push("Input.dispatchKeyEvent");
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    windowsVirtualKeyCode: 27,
    key: "Escape",
    code: "Escape",
  });
}

/**
 * Resolve picker trigger without scrollIntoView — Composer chrome can move off
 * the interactive hit target when scrolled to center.
 */
async function resolveTriggerNoScroll(
  client: CdpClient,
  strategies: readonly string[],
  methods: string[],
): Promise<{ strategy: string; box: { x: number; y: number; width: number; height: number } } | null> {
  for (const strategy of strategies) {
    const expression = `(() => {
      const el = document.querySelector(${JSON.stringify(strategy)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return {
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
        width: r.width,
        height: r.height
      };
    })()`;
    methods.push("Runtime.evaluate");
    const evalResult = await client.send<{
      result?: { value?: unknown };
      exceptionDetails?: unknown;
    }>("Runtime.evaluate", { expression, returnByValue: true });
    if (evalResult.exceptionDetails) continue;
    const value = evalResult.result?.value as
      | { x: number; y: number; width: number; height: number }
      | null
      | undefined;
    if (value && typeof value.x === "number" && typeof value.y === "number") {
      return { strategy, box: value };
    }
  }
  return null;
}

/**
 * Open Composer model picker via CDP, collect menu labels, close with Escape.
 */
export async function scrapeComposerModels(
  client: CdpClient,
  triggerStrategies: readonly string[] = MODEL_PICKER_TRIGGER_STRATEGIES,
): Promise<ModelScrapeResult> {
  const methods: string[] = [];
  const hit = await resolveTriggerNoScroll(client, triggerStrategies, methods);
  if (!hit) {
    return {
      ok: false,
      error: "Model picker trigger not found in Composer DOM",
      methods,
    };
  }

  await dispatchClick(client, hit.box.x, hit.box.y, methods);

  // Cursor 3.19 Auto menu: open Model submenu → selected-model-list-submenu.
  let submenu = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(150 + attempt * 60);
    submenu = await resolveTriggerNoScroll(
      client,
      [
        "[data-testid='selected-model-list-submenu']",
        "[data-testid='selected-auto-menu'] .ui-menu__submenu-trigger",
        "[data-testid='selected-auto-menu'] [role='menuitem'].ui-menu__submenu-trigger",
        "[role='menu'][data-testid='selected-auto-menu'] [role='group'][aria-label='Model'] [role='menuitem']",
        "[role='group'][aria-label='Model'] .ui-menu__submenu-trigger",
      ],
      methods,
    );
    if (submenu) break;
  }
  if (submenu && !submenu.strategy.includes("selected-model-list-submenu")) {
    // Hover then click — submenu opens on mouse enter in Cursor 3.19.
    methods.push("Input.dispatchMouseEvent");
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: submenu.box.x,
      y: submenu.box.y,
    });
    await sleep(200);
    await dispatchClick(client, submenu.box.x, submenu.box.y, methods);
    // Wait for nested model list panel
    for (let attempt = 0; attempt < 8; attempt++) {
      await sleep(120 + attempt * 40);
      const listHit = await resolveTriggerNoScroll(
        client,
        ["[data-testid='selected-model-list-submenu']"],
        methods,
      );
      if (listHit) break;
    }
  }

  let labels: string[] = [];
  let current: string | null = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(120 + attempt * 50);
    const read = await readPickerLabels(client, methods);
    labels = read.labels;
    current = read.current;
    if (labels.length > 1) break;
  }

  try {
    await pressEscape(client, methods);
  } catch {
    /* best-effort close */
  }

  if (labels.length === 0 && current) {
    labels = [current];
  }
  if (labels.length === 0) {
    return {
      ok: false,
      error: "Model picker opened but no menu items scraped",
      methods,
    };
  }

  const defaultLabel = (current ?? labels[0]!).toLowerCase();
  const models: ScrapedModel[] = labels.map((label, i) => {
    const id = slugifyModelId(label);
    return {
      id,
      label,
      family: guessFamily(label),
      available: true,
      default: label.toLowerCase() === defaultLabel || (i === 0 && !current),
    };
  });
  // Ensure exactly one default
  if (!models.some((m) => m.default) && models[0]) {
    models[0].default = true;
  }
  for (let i = 0; i < models.length; i++) {
    if (models[i]!.default) {
      for (let j = 0; j < models.length; j++) {
        if (j !== i) models[j]!.default = false;
      }
      break;
    }
  }

  return {
    ok: true,
    models,
    strategy: hit.strategy,
    methods,
  };
}
