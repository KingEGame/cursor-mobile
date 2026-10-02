/**
 * "@" (files, MCP plugins, branch, chats…) and "/" (skills, commands, rules) in the
 * Agents-window composer — the same menus the operator uses in Cursor.
 *
 * Observed DOM (2026-10):
 *   typing "@query" / "/query" opens a list of [role=option]; each option's children are
 *   [name, description-or-folder, hint] (class names are generated, so read by position).
 *   picking "@…"  → span.node-mentionNode  [data-label][data-mention-type][data-mention-suggestion-char]
 *   picking "/…"  → span.node-commandNode  (.ui-prompt-input-command-chip__label = "/name")
 * Every pick is verified by finding that node; listing cleans up after itself.
 */

import type { CdpClient } from "./cdp-client.js";
import { dispatchClick } from "./cdp-input.js";

export type MentionTrigger = "@" | "/";

export interface MentionOption {
  label: string;
  /** Description (skills/MCP) or folder (files). */
  detail: string;
  /** e.g. "Ready", "Needs authentication", key hints. */
  hint: string;
}

export interface MentionRef {
  trigger: MentionTrigger;
  label: string;
  /** Disambiguates same-named files by folder. */
  detail?: string;
}

export type MentionResult =
  | { ok: true; options?: MentionOption[] }
  | { ok: false; code: "MENTION_NOT_FOUND" | "MENTION_NOT_APPLIED" | "CDP_INPUT_FAILED"; error: string };

type Wait = (ms: number) => Promise<void>;
const realWait: Wait = (ms) => new Promise((r) => setTimeout(r, ms));

const EDITOR = `document.querySelector(".ui-prompt-input-editor__input[contenteditable='true']")`;

async function evaluate<T>(client: CdpClient, expression: string): Promise<T | null> {
  const res = await client.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
    "Runtime.evaluate",
    { expression, returnByValue: true },
  );
  if (res.exceptionDetails) return null;
  return (res.result?.value ?? null) as T | null;
}

async function key(client: CdpClient, k: string, code: string, vk: number, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    for (const type of ["keyDown", "keyUp"] as const) {
      await client.send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk });
    }
  }
}

/** Put the caret at the end of the composer. */
async function focusEditorEnd(client: CdpClient): Promise<boolean> {
  const p = await evaluate<{ x: number; y: number }>(
    client,
    `(() => { const e = ${EDITOR}; if (!e) return null; const r = e.getBoundingClientRect();
      return { x: r.x + r.width - 4, y: r.y + r.height / 2 }; })()`,
  );
  if (!p) return false;
  await dispatchClick(client, p.x, p.y, []);
  await key(client, "End", "End", 35);
  return true;
}

const READ_OPTIONS = `[...document.querySelectorAll("[role=option]")].filter((o) => o.offsetParent).slice(0, 40).map((o) => {
  const text = (e) => e.textContent.replace(/\\s+/g, " ").trim();
  // Unwrap single-child wrappers, then split the first column again when it holds
  // [name, description/folder] itself (skills and files nest one level deeper).
  let node = o;
  while (node.children.length === 1) node = node.children[0];
  let cols = [...node.children].filter((c) => text(c));
  if (cols.length && cols[0].children.length >= 2) {
    const inner = [...cols[0].children].filter((c) => text(c));
    if (inner.length >= 2) cols = [...inner, ...cols.slice(1)];
  }
  const parts = cols.map(text);
  if (!parts.length) parts.push(text(o));
  return { label: parts[0], detail: parts[1] || "", hint: parts[2] || "" };
})`;

/**
 * List what Cursor offers for `trigger + query`. Types into the PC composer briefly, reads
 * the menu, then removes exactly what it typed.
 */
export async function listMentionOptions(
  client: CdpClient,
  trigger: MentionTrigger,
  query: string,
  wait: Wait = realWait,
): Promise<MentionResult> {
  if (!(await focusEditorEnd(client))) {
    return { ok: false, code: "CDP_INPUT_FAILED", error: "No composer on the PC" };
  }
  const typed = trigger + query;
  await client.send("Input.insertText", { text: typed });
  await wait(800);
  const options = (await evaluate<MentionOption[]>(client, READ_OPTIONS)) ?? [];
  await key(client, "Escape", "Escape", 27);
  await key(client, "Backspace", "Backspace", 8, typed.length);
  return { ok: true, options };
}

/** Option matcher used inside the page (also exported for tests). */
export function optionMatches(option: MentionOption, ref: MentionRef): boolean {
  if (option.label.trim() !== ref.label.trim()) return false;
  return !ref.detail || option.detail.trim() === ref.detail.trim();
}

/** Insert one mention / command chip and verify it is in the composer. */
export async function insertMention(
  client: CdpClient,
  ref: MentionRef,
  wait: Wait = realWait,
): Promise<MentionResult> {
  if (!(await focusEditorEnd(client))) {
    return { ok: false, code: "CDP_INPUT_FAILED", error: "No composer on the PC" };
  }
  const query = ref.label.replace(/^[@/]/, "");
  const typed = ref.trigger + query;
  const countBefore = await evaluate<number>(
    client,
    `${EDITOR}.querySelectorAll(".node-mentionNode, .node-commandNode").length`,
  );
  await client.send("Input.insertText", { text: typed });
  await wait(800);
  const target = await evaluate<{ x: number; y: number } | null>(
    client,
    `(() => {
      const opts = ${READ_OPTIONS};
      const els = [...document.querySelectorAll("[role=option]")].filter((o) => o.offsetParent).slice(0, 40);
      const want = ${JSON.stringify({ label: ref.label.trim(), detail: ref.detail?.trim() ?? "" })};
      const i = opts.findIndex((o) => o.label.trim() === want.label && (!want.detail || o.detail.trim() === want.detail));
      if (i < 0) return null;
      const r = els[i].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`,
  );
  if (!target) {
    await key(client, "Escape", "Escape", 27);
    await key(client, "Backspace", "Backspace", 8, typed.length);
    return { ok: false, code: "MENTION_NOT_FOUND", error: `Cursor does not offer ${ref.trigger}${ref.label}` };
  }
  await dispatchClick(client, target.x, target.y, []);
  await wait(400);
  const verified = await evaluate<boolean>(
    client,
    `(() => {
      const ed = ${EDITOR};
      const nodes = [...ed.querySelectorAll(".node-mentionNode, .node-commandNode")];
      if (nodes.length <= ${countBefore ?? 0}) return false;
      const last = nodes[nodes.length - 1];
      return ${JSON.stringify(ref.trigger)} === "@"
        ? !!last.querySelector('[data-label=' + JSON.stringify(${JSON.stringify(ref.label.trim())}) + ']')
        : last.textContent.includes(${JSON.stringify(query)});
    })()`,
  );
  if (!verified) {
    return { ok: false, code: "MENTION_NOT_APPLIED", error: `Could not add ${ref.trigger}${ref.label} on the PC` };
  }
  return { ok: true };
}

/** Insert several chips in order; stops at the first failure. */
export async function insertMentions(
  client: CdpClient,
  refs: MentionRef[],
  wait: Wait = realWait,
): Promise<MentionResult> {
  for (const ref of refs) {
    const r = await insertMention(client, ref, wait);
    if (!r.ok) return r;
  }
  return { ok: true };
}
