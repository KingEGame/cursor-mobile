/**
 * Set the Agents-window composer's mode and model before sending (UI-SPEC Amendment B).
 *
 * Observed DOM (2026-10):
 *   "+" button  [aria-label="Add agents, context, tools"] → [role=option] Plan / Debug /
 *               Multitask / Ask / Files / Model / MCP
 *   chosen mode → a `.ui-pill` labelled with the mode inside the composer
 *   model picker `.vscode-model-picker__trigger--prompt` (label = current model) → menu
 *               "Model ›" → submenu [role=menuitem] per model
 * Every change is verified by re-reading the composer; on any miss the menus are closed and
 * the caller must not send (fail closed — never send with the wrong mode or model).
 */

import type { CdpClient } from "./cdp-client.js";
import { dispatchClick } from "./cdp-input.js";

export const AGENT_MODES = ["Plan", "Debug", "Multitask", "Ask"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

export type ComposerOptionsResult =
  | { ok: true; mode: AgentMode | null; model: string | null }
  | { ok: false; code: "MODE_NOT_APPLIED" | "MODEL_NOT_APPLIED"; error: string };

type Wait = (ms: number) => Promise<void>;
const realWait: Wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Model labels carry zero-width spaces and a trailing "New" badge in the menu. */
export function normalizeModelLabel(text: string): string {
  return text.replace(/[​-‍﻿]/g, "").replace(/\s*New$/, "").trim();
}

async function evaluate<T>(client: CdpClient, expression: string): Promise<T | null> {
  const res = await client.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
    "Runtime.evaluate",
    { expression, returnByValue: true },
  );
  if (res.exceptionDetails) return null;
  return (res.result?.value ?? null) as T | null;
}

const COMPOSER_ROOT = `(() => {
  const ed = document.querySelector(".ui-prompt-input-editor__input[contenteditable='true']");
  let b = ed; for (let i = 0; i < 6 && b; i++) b = b.parentElement; return b;
})()`;

export async function readComposerState(
  client: CdpClient,
): Promise<{ mode: AgentMode | null; model: string | null }> {
  const v = await evaluate<{ pills: string[]; model: string | null }>(
    client,
    `(() => {
      const root = ${COMPOSER_ROOT};
      if (!root) return { pills: [], model: null };
      const pills = [...root.querySelectorAll(".ui-pill__label")].map((p) => p.textContent.trim());
      const trigger = document.querySelector(".vscode-model-picker__trigger--prompt");
      return { pills, model: trigger ? trigger.textContent.trim() : null };
    })()`,
  );
  const mode = (v?.pills ?? []).find((p): p is AgentMode => (AGENT_MODES as readonly string[]).includes(p)) ?? null;
  return { mode, model: v?.model ? normalizeModelLabel(v.model) : null };
}

async function centerOf(client: CdpClient, finder: string): Promise<{ x: number; y: number } | null> {
  return evaluate<{ x: number; y: number }>(
    client,
    `(() => { const e = ${finder}; if (!e) return null; const r = e.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null; return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
}

async function pressEscape(client: CdpClient, times = 2): Promise<void> {
  for (let i = 0; i < times; i++) {
    for (const type of ["keyDown", "keyUp"] as const) {
      await client.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    }
  }
}

export async function setComposerMode(
  client: CdpClient,
  mode: AgentMode,
  wait: Wait = realWait,
): Promise<ComposerOptionsResult> {
  const before = await readComposerState(client);
  if (before.mode === mode) return { ok: true, ...before };
  const plus = await centerOf(client, `document.querySelector('[aria-label="Add agents, context, tools"]')`);
  if (plus) {
    await dispatchClick(client, plus.x, plus.y, []);
    await wait(400);
    const opt = await centerOf(
      client,
      `[...document.querySelectorAll('[role=option]')].find((o) => o.textContent.trim().startsWith(${JSON.stringify(mode)}))`,
    );
    if (opt) {
      await dispatchClick(client, opt.x, opt.y, []);
      await wait(400);
    }
  }
  const after = await readComposerState(client);
  if (after.mode !== mode) {
    await pressEscape(client);
    return { ok: false, code: "MODE_NOT_APPLIED", error: `Could not switch the PC chat to ${mode} mode` };
  }
  return { ok: true, ...after };
}

export async function setComposerModel(
  client: CdpClient,
  model: string,
  wait: Wait = realWait,
): Promise<ComposerOptionsResult> {
  const wanted = normalizeModelLabel(model);
  const before = await readComposerState(client);
  if (before.model === wanted) return { ok: true, ...before };
  const trigger = await centerOf(client, `document.querySelector(".vscode-model-picker__trigger--prompt")`);
  if (trigger) {
    await dispatchClick(client, trigger.x, trigger.y, []);
    await wait(400);
    const submenu = await centerOf(
      client,
      `[...document.querySelectorAll('[role=menuitem]')].find((o) => /^Model/.test(o.textContent.trim()) && o.getAttribute("aria-haspopup"))`,
    );
    if (submenu) {
      await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: submenu.x, y: submenu.y });
      await dispatchClick(client, submenu.x, submenu.y, []);
      await wait(500);
    }
    const item = await centerOf(
      client,
      `[...document.querySelectorAll('[role=menuitem]')].find((o) => !o.getAttribute("aria-haspopup") &&
        o.textContent.replace(/[\\u200B-\\u200D\\uFEFF]/g, "").replace(/\\s*New$/, "").trim() === ${JSON.stringify(wanted)})`,
    );
    if (item) {
      await dispatchClick(client, item.x, item.y, []);
      await wait(400);
    }
  }
  const after = await readComposerState(client);
  if (after.model !== wanted) {
    await pressEscape(client, 3);
    return { ok: false, code: "MODEL_NOT_APPLIED", error: `Could not select model "${wanted}" on the PC` };
  }
  return { ok: true, ...after };
}

/** Apply the requested options in order (model, then mode). No-op for undefined fields. */
export async function applyComposerOptions(
  client: CdpClient,
  opts: { mode?: AgentMode | null; model?: string | null },
  wait: Wait = realWait,
): Promise<ComposerOptionsResult> {
  if (opts.model) {
    const r = await setComposerModel(client, opts.model, wait);
    if (!r.ok) return r;
  }
  if (opts.mode) {
    const r = await setComposerMode(client, opts.mode, wait);
    if (!r.ok) return r;
  }
  return { ok: true, ...(await readComposerState(client)) };
}
