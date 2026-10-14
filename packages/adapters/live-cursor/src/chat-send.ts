/**
 * Send a message into a specific Agents-window chat from the phone.
 *
 * Cursor only accepts input into the chat that is open on the PC, so:
 *   1. click that chat's row in the Agents sidebar (expanding its project if collapsed),
 *   2. confirm the main pane switched (`[data-composer-id]` === target) — fail closed
 *      otherwise, so text never lands in the wrong chat,
 *   3. type + submit via the VERIFIED send_message selector.
 */

import type { CdpClient } from "./cdp-client.js";
import {
  dispatchClick,
  executeTypeAndSubmit,
  resolveElementCenter,
} from "./cdp-input.js";
import type { ActionSelector } from "./selector-pack.js";
import { applyComposerOptions, type AgentMode } from "./composer-options.js";
import { insertMentions, type MentionRef } from "./mentions.js";
import { pasteImages, removePastedImages, type PastedImage } from "./images.js";
import { ensureCursorWindowRaised } from "./raise-cursor-window.js";

/** Optional composer settings applied (and verified) before the text is typed. */
export interface ComposerSendOptions {
  mode?: AgentMode | null;
  model?: string | null;
  /** "@" files / plugins and "/" skills, inserted as Cursor chips before the text. */
  mentions?: MentionRef[];
  /** Phone photos pasted into the composer before the text. */
  images?: PastedImage[];
}

/** Empty the PC composer (used when a send is aborted half-way). */
export async function clearComposer(client: CdpClient): Promise<void> {
  await client.send("Runtime.evaluate", {
    expression: `(() => { const e = document.querySelector(".ui-prompt-input-editor__input[contenteditable='true']"); if (e) e.focus(); })()`,
  });
  for (const [k, code, vk, mods] of [["a", "KeyA", 65, 2], ["Backspace", "Backspace", 8, 0]] as const) {
    for (const type of ["keyDown", "keyUp"] as const) {
      await client.send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
    }
  }
}

/**
 * Apply mode/model, insert chips, then type `text` at the end and submit — all verified.
 * On any failure the composer is cleared so nothing half-made is left on the PC.
 */
async function composeAndSubmit(
  client: CdpClient,
  text: string,
  sendSelector: ActionSelector,
  composer: ComposerSendOptions | undefined,
  methods: string[],
  wait: Wait,
): Promise<ChatSendResult | null> {
  // Never overwrite or glue onto text already in the PC chat box (an operator draft,
  // or a prompt Cursor put back after a failed run).
  const draft = await evaluate<{ text: string; chips: number; images: number } | null>(
    client,
    `(() => {
      const e = document.querySelector(".ui-prompt-input-editor__input[contenteditable='true']");
      if (!e) return null;
      return {
        text: (e.innerText || "").replace(/\\s+/g, " ").trim(),
        chips: e.querySelectorAll(".node-mentionNode, .node-commandNode").length,
        images: document.querySelectorAll('[aria-label="Remove image"]').length,
      };
    })()`,
    methods,
  );
  if (draft && (draft.text || draft.chips || draft.images)) {
    const preview = draft.text.length > 60 ? `${draft.text.slice(0, 60)}…` : draft.text;
    return {
      ok: false,
      code: "COMPOSER_NOT_EMPTY",
      error: preview
        ? `The PC chat box already has unsent text ("${preview}"). Send or clear it in Cursor first — nothing was typed.`
        : "The PC chat box already has attachments waiting. Send or clear them in Cursor first — nothing was typed.",
      methods,
    };
  }
  if (composer?.mode || composer?.model) {
    const applied = await applyComposerOptions(client, composer, wait);
    if (!applied.ok) return { ok: false, code: applied.code, error: applied.error, methods };
  }
  if (composer?.images?.length) {
    const pasted = await pasteImages(client, composer.images, wait);
    if (!pasted.ok) {
      await removePastedImages(client);
      return { ok: false, code: pasted.code, error: pasted.error, methods };
    }
  }
  if (composer?.mentions?.length) {
    const added = await insertMentions(client, composer.mentions, wait);
    if (!added.ok) {
      await clearComposer(client);
      await removePastedImages(client);
      return { ok: false, code: added.code === "CDP_INPUT_FAILED" ? "CDP_INPUT_FAILED" : "MENTION_NOT_APPLIED", error: added.error, methods };
    }
    // Chips are in place and the caret sits after them: type the text there.
    methods.push("Input.insertText");
    await client.send("Input.insertText", { text: text.startsWith(" ") ? text : ` ${text}` });
    for (const type of ["keyDown", "keyUp"] as const) {
      await client.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    }
  } else {
    const typed = await executeTypeAndSubmit(client, "send_message", sendSelector, text);
    methods.push(...typed.methods);
    if (!typed.ok) return { ok: false, code: "CDP_INPUT_FAILED", error: typed.error, methods };
  }
  if (!(await confirmSubmitted(client, methods, wait))) {
    return {
      ok: false,
      code: "SEND_NOT_CONFIRMED",
      error: "The text is in the PC chat box but Cursor did not send it",
      methods,
    };
  }
  return null;
}

export type ChatSendResult =
  | { ok: true; switched: boolean; methods: string[]; composerId?: string }
  | {
      ok: false;
      code:
        | "CHAT_NOT_IN_SIDEBAR"
        | "CHAT_SWITCH_FAILED"
        | "CDP_INPUT_FAILED"
        | "NOT_RUNNING"
        | "PROJECT_NOT_IN_SIDEBAR"
        | "NEW_CHAT_FAILED"
        | "MODE_NOT_APPLIED"
        | "MODEL_NOT_APPLIED"
        | "SEND_NOT_CONFIRMED"
        | "MESSAGE_NOT_FOUND"
        | "EDIT_FAILED"
        | "MENTION_NOT_APPLIED"
        | "IMAGE_NOT_ATTACHED"
        | "COMPOSER_NOT_EMPTY"
        /** Cursor window minimized / not visible — CDP Input cannot land. */
        | "CURSOR_WINDOW_HIDDEN";
      error: string;
      methods: string[];
    };

const COMPOSER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Wait = (ms: number) => Promise<void>;
const realWait: Wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate<T>(client: CdpClient, expression: string, methods: string[]): Promise<T | null> {
  methods.push("Runtime.evaluate");
  const res = await client.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
    "Runtime.evaluate",
    { expression, returnByValue: true },
  );
  if (res.exceptionDetails) return null;
  return (res.result?.value ?? null) as T | null;
}

/** Composer id of the chat currently open in the PC main pane. */
export async function readOpenChatId(client: CdpClient, methods: string[] = []): Promise<string | null> {
  return evaluate<string>(
    client,
    `(() => { const el = document.querySelector("[data-composer-id]"); return el ? el.getAttribute("data-composer-id") : null; })()`,
    methods,
  );
}

/**
 * Make `composerId` the open chat on the PC. No-op when it already is.
 */
export async function openAgentChat(
  client: CdpClient,
  composerId: string,
  opts: { wait?: Wait; switchTimeoutMs?: number } = {},
): Promise<ChatSendResult> {
  const methods: string[] = [];
  const wait = opts.wait ?? realWait;
  if (!COMPOSER_ID.test(composerId)) {
    return { ok: false, code: "CHAT_NOT_IN_SIDEBAR", error: "Not a local Cursor chat id", methods };
  }
  try {
    if ((await readOpenChatId(client, methods)) === composerId) {
      return { ok: true, switched: false, methods };
    }

    const rowSel = `li[data-sidebar-item-key="row:${composerId}"]`;
    const where = await evaluate<{ present: boolean; collapsed: boolean }>(
      client,
      `(() => {
        const li = document.querySelector(${JSON.stringify(rowSel)});
        if (!li) return { present: false, collapsed: false };
        return { present: true, collapsed: !!li.closest("[inert], [data-collapsed='true']") };
      })()`,
      methods,
    );
    if (!where?.present) {
      return {
        ok: false,
        code: "CHAT_NOT_IN_SIDEBAR",
        error: "Chat is not in the PC Agents sidebar (archived or under More)",
        methods,
      };
    }

    if (where.collapsed) {
      // Expand the project section that holds the row; its head is a sibling of the clip.
      const head = await resolveElementCenter(
        client,
        [`section:has(${rowSel}) [data-section-head][aria-expanded='false']`],
        methods,
      );
      if (head) {
        await dispatchClick(client, head.box.x, head.box.y, methods);
        await wait(350);
      }
    }

    const row = await resolveElementCenter(client, [`${rowSel} [data-sidebar-menu-button]`], methods);
    if (!row) {
      return {
        ok: false,
        code: "CHAT_SWITCH_FAILED",
        error: "Chat row is not clickable on the PC (project still collapsed?)",
        methods,
      };
    }
    await dispatchClick(client, row.box.x, row.box.y, methods);

    const deadline = opts.switchTimeoutMs ?? 3000;
    for (let waited = 0; waited <= deadline; waited += 150) {
      if ((await readOpenChatId(client, methods)) === composerId) {
        return { ok: true, switched: true, methods };
      }
      await wait(150);
    }
    return {
      ok: false,
      code: "CHAT_SWITCH_FAILED",
      error: "Cursor did not open the chat after clicking it — nothing was typed",
      methods,
    };
  } catch (err) {
    return {
      ok: false,
      code: "CDP_INPUT_FAILED",
      error: err instanceof Error ? err.message : String(err),
      methods,
    };
  }
}

/** Open the chat on the PC, then type + submit `text` into it. */
export async function sendToAgentChat(
  client: CdpClient,
  composerId: string,
  text: string,
  sendSelector: ActionSelector,
  opts: {
    wait?: Wait;
    switchTimeoutMs?: number;
    composer?: ComposerSendOptions;
    /** CDP target id for Target.activateTarget (Agents page). */
    targetId?: string | null;
  } = {},
): Promise<ChatSendResult> {
  const raised = await ensureCursorWindowRaised(client, { targetId: opts.targetId });
  if (!raised.ok) {
    return { ok: false, code: raised.code, error: raised.error, methods: raised.methods };
  }
  const opened = await openAgentChat(client, composerId, opts);
  if (!opened.ok) return opened;
  // Let the composer for the newly opened chat mount before focusing its input.
  if (opened.switched) await (opts.wait ?? realWait)(250);
  const methods = [...opened.methods];
  const failed = await composeAndSubmit(client, text, sendSelector, opts.composer, methods, opts.wait ?? realWait);
  if (failed) return failed;
  return { ok: true, switched: opened.switched, methods };
}

/** Cursor's composer stop control while an agent runs (Agents window, 2026-10). */
export const STOP_GENERATION_SELECTORS = ['[aria-label="Stop generation"]'];

/**
 * Open the chat on the PC, then click its Stop button. `NOT_RUNNING` (nothing clicked)
 * when the chat has no run in progress.
 */
export async function stopAgentChat(
  client: CdpClient,
  composerId: string,
  opts: { wait?: Wait; switchTimeoutMs?: number; targetId?: string | null } = {},
): Promise<ChatSendResult> {
  const raised = await ensureCursorWindowRaised(client, { targetId: opts.targetId });
  if (!raised.ok) {
    return { ok: false, code: raised.code, error: raised.error, methods: raised.methods };
  }
  const opened = await openAgentChat(client, composerId, opts);
  if (!opened.ok) return opened;
  if (opened.switched) await (opts.wait ?? realWait)(250);
  const methods = [...opened.methods];
  try {
    const hit = await resolveElementCenter(client, STOP_GENERATION_SELECTORS, methods);
    if (!hit) {
      return { ok: false, code: "NOT_RUNNING", error: "This chat is not running on the PC", methods };
    }
    await dispatchClick(client, hit.box.x, hit.box.y, methods);
    return { ok: true, switched: opened.switched, methods };
  } catch (err) {
    return {
      ok: false,
      code: "CDP_INPUT_FAILED",
      error: err instanceof Error ? err.message : String(err),
      methods,
    };
  }
}

/**
 * Start a new Agents chat in one project and send its first message.
 *
 * The project's "New Agent" button only gets a size on real hover, so it is clicked
 * from page script. Success is proven before typing: the active row must be a new row in
 * that project's sidebar section (or its existing empty "New Agent" draft, which Cursor
 * re-focuses), and the composer must be empty.
 */
export async function newAgentChat(
  client: CdpClient,
  sectionId: string,
  text: string,
  sendSelector: ActionSelector,
  opts: {
    wait?: Wait;
    timeoutMs?: number;
    composer?: ComposerSendOptions;
    targetId?: string | null;
  } = {},
): Promise<ChatSendResult> {
  const raised = await ensureCursorWindowRaised(client, { targetId: opts.targetId });
  if (!raised.ok) {
    return { ok: false, code: raised.code, error: raised.error, methods: raised.methods };
  }
  const methods: string[] = [...raised.methods];
  const wait = opts.wait ?? realWait;
  const section = `section[data-agent-drop-section-id=${JSON.stringify(sectionId)}]`;
  const rowKeys = `[...document.querySelectorAll(${JSON.stringify(`${section} li[data-sidebar-item-key^="row:"]`)})].map((li) => li.getAttribute("data-sidebar-item-key").slice(4))`;
  try {
    const before = await evaluate<string[] | null>(
      client,
      `(() => document.querySelector(${JSON.stringify(section)}) ? ${rowKeys} : null)()`,
      methods,
    );
    if (!before) {
      return { ok: false, code: "PROJECT_NOT_IN_SIDEBAR", error: "Project is not in the PC Agents sidebar", methods };
    }
    const clicked = await evaluate<boolean>(
      client,
      `(() => { const b = document.querySelector(${JSON.stringify(`${section} [data-section-head] button[aria-label="New Agent"]`)}); if (!b) return false; b.click(); return true; })()`,
      methods,
    );
    if (!clicked) {
      return { ok: false, code: "NEW_CHAT_FAILED", error: "No New Agent button for this project", methods };
    }

    const known = new Set(before);
    let created: string | null = null;
    for (let waited = 0; waited <= (opts.timeoutMs ?? 3000) && !created; waited += 150) {
      await wait(150);
      created = await evaluate<string | null>(
        client,
        `(() => {
          const known = new Set(${JSON.stringify([...known])});
          const ed = document.querySelector(".ui-prompt-input-editor__input[contenteditable='true']");
          if (!ed || ed.textContent.trim() !== "") return null;
          for (const li of document.querySelectorAll(${JSON.stringify(`${section} li[data-sidebar-item-key^="row:"]`)})) {
            const id = li.getAttribute("data-sidebar-item-key").slice(4);
            const btn = li.querySelector("[data-sidebar-menu-button]");
            if (!btn || btn.getAttribute("data-active") !== "true") continue;
            // A brand-new row, or Cursor re-focusing this project's existing empty draft.
            const title = (li.querySelector(".ui-sidebar-menu-button-content") || {}).textContent || "";
            if (!known.has(id) || title.trim() === "New Agent") return id;
          }
          return null;
        })()`,
        methods,
      );
    }
    if (!created) {
      return {
        ok: false,
        code: "NEW_CHAT_FAILED",
        error: "Cursor did not open a new chat in that project — nothing was typed",
        methods,
      };
    }

    const failed = await composeAndSubmit(client, text, sendSelector, opts.composer, methods, wait);
    if (failed) return failed;

    // Cursor promotes the draft to a new composer id on the first send; report the id the
    // chat actually has afterwards, so the phone opens the chat with the message in it.
    let finalId = created;
    for (let waited = 0; waited <= (opts.timeoutMs ?? 5000); waited += 250) {
      await wait(250);
      const active = await evaluate<string | null>(
        client,
        `(() => {
          for (const li of document.querySelectorAll(${JSON.stringify(`${section} li[data-sidebar-item-key^="row:"]`)})) {
            const btn = li.querySelector("[data-sidebar-menu-button]");
            if (btn && btn.getAttribute("data-active") === "true") return li.getAttribute("data-sidebar-item-key").slice(4);
          }
          return null;
        })()`,
        methods,
      );
      if (active && active !== created) {
        finalId = active;
        break;
      }
    }
    return { ok: true, switched: true, methods, composerId: finalId };
  } catch (err) {
    return {
      ok: false,
      code: "CDP_INPUT_FAILED",
      error: err instanceof Error ? err.message : String(err),
      methods,
    };
  }
}

const EDITOR_TEXT = `(() => { const ed = document.querySelector(".ui-prompt-input-editor__input[contenteditable='true']"); return ed ? ed.textContent.trim() : null; })()`;

/**
 * Prove the message left the composer. Enter is sometimes swallowed (e.g. right after a
 * menu closed), so if text is still there click Cursor's "Send message" button and re-check.
 * Never report success while the text is still sitting in the PC composer.
 */
export async function confirmSubmitted(
  client: CdpClient,
  methods: string[],
  wait: Wait = realWait,
): Promise<boolean> {
  const emptied = async (ms: number) => {
    for (let waited = 0; waited <= ms; waited += 200) {
      const text = await evaluate<string | null>(client, EDITOR_TEXT, methods);
      if (text === "") return true;
      await wait(200);
    }
    return false;
  };
  if (await emptied(1200)) return true;
  const send = await resolveElementCenter(client, ['.ui-prompt-input-submit-button[aria-label="Send message"]'], methods);
  if (!send) return false;
  await dispatchClick(client, send.box.x, send.box.y, methods);
  return emptied(2000);
}

const BUBBLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Edit one of the operator's earlier messages and resubmit it (Cursor re-runs from there).
 *
 * Cursor opens an inline editor when the user message row is clicked; the row's
 * `data-message-id` is the same id as the DB bubble the phone shows. Each step is
 * verified: editor opened in that row, text reads back exactly, editor closed on send.
 */
export async function editAgentMessage(
  client: CdpClient,
  composerId: string,
  bubbleId: string,
  text: string,
  opts: { wait?: Wait; switchTimeoutMs?: number; targetId?: string | null } = {},
): Promise<ChatSendResult> {
  if (!BUBBLE_ID.test(bubbleId)) {
    return { ok: false, code: "MESSAGE_NOT_FOUND", error: "Not a Cursor message id", methods: [] };
  }
  const raised = await ensureCursorWindowRaised(client, { targetId: opts.targetId });
  if (!raised.ok) {
    return { ok: false, code: raised.code, error: raised.error, methods: raised.methods };
  }
  const wait = opts.wait ?? realWait;
  const opened = await openAgentChat(client, composerId, opts);
  if (!opened.ok) return opened;
  const methods = [...opened.methods];
  const row = `document.querySelector(${JSON.stringify(
    `[data-composer-id="${composerId}"] [data-message-role=human][data-message-id="${bubbleId.toLowerCase()}"]`,
  )})`;
  try {
    if (opened.switched) await wait(400);
    const target = await evaluate<{ x: number; y: number } | null>(
      client,
      `(() => { const r = ${row}; if (!r) return null; r.scrollIntoView({ block: "center" });
        const b = (r.querySelector("p,span,div") || r).getBoundingClientRect();
        return { x: b.x + Math.min(40, b.width / 2), y: b.y + b.height / 2 }; })()`,
      methods,
    );
    if (!target) {
      return { ok: false, code: "MESSAGE_NOT_FOUND", error: "That message is not visible in the PC chat", methods };
    }
    await dispatchClick(client, target.x, target.y, methods);
    await wait(500);
    const focused = await evaluate<boolean>(
      client,
      `(() => { const e = ${row} && ${row}.querySelector("[contenteditable=true]"); if (!e) return false; e.focus(); return true; })()`,
      methods,
    );
    if (!focused) {
      return { ok: false, code: "EDIT_FAILED", error: "Cursor did not open the message for editing", methods };
    }
    for (const type of ["keyDown", "keyUp"] as const) {
      methods.push("Input.dispatchKeyEvent");
      await client.send("Input.dispatchKeyEvent", { type, key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
    }
    methods.push("Input.insertText");
    await client.send("Input.insertText", { text });
    await wait(250);
    const readBack = await evaluate<string | null>(
      client,
      `(() => { const e = ${row} && ${row}.querySelector("[contenteditable=true]"); return e ? e.textContent : null; })()`,
      methods,
    );
    if (readBack?.trim() !== text.trim()) {
      await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      return { ok: false, code: "EDIT_FAILED", error: "Edited text did not land in the message — cancelled", methods };
    }
    const sendBtn = await evaluate<{ x: number; y: number } | null>(
      client,
      `(() => { const b = ${row} && ${row}.querySelector('[aria-label="Send message"]'); if (!b) return null;
        const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      methods,
    );
    if (!sendBtn) {
      return { ok: false, code: "EDIT_FAILED", error: "No Send button on the edited message", methods };
    }
    await dispatchClick(client, sendBtn.x, sendBtn.y, methods);
    for (let waited = 0; waited <= 2500; waited += 250) {
      await wait(250);
      const stillOpen = await evaluate<boolean>(
        client,
        `(() => !!(${row} && ${row}.querySelector("[contenteditable=true]")))()`,
        methods,
      );
      if (!stillOpen) return { ok: true, switched: opened.switched, methods };
    }
    return { ok: false, code: "SEND_NOT_CONFIRMED", error: "Edited message was not resubmitted", methods };
  } catch (err) {
    return { ok: false, code: "CDP_INPUT_FAILED", error: err instanceof Error ? err.message : String(err), methods };
  }
}
