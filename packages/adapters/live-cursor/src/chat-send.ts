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
        | "NEW_CHAT_FAILED";
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
  opts: { wait?: Wait; switchTimeoutMs?: number } = {},
): Promise<ChatSendResult> {
  const opened = await openAgentChat(client, composerId, opts);
  if (!opened.ok) return opened;
  // Let the composer for the newly opened chat mount before focusing its input.
  if (opened.switched) await (opts.wait ?? realWait)(250);
  const typed = await executeTypeAndSubmit(client, "send_message", sendSelector, text);
  const methods = [...opened.methods, ...typed.methods];
  if (!typed.ok) {
    return { ok: false, code: "CDP_INPUT_FAILED", error: typed.error, methods };
  }
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
  opts: { wait?: Wait; switchTimeoutMs?: number } = {},
): Promise<ChatSendResult> {
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
  opts: { wait?: Wait; timeoutMs?: number } = {},
): Promise<ChatSendResult> {
  const methods: string[] = [];
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

    const typed = await executeTypeAndSubmit(client, "send_message", sendSelector, text);
    methods.push(...typed.methods);
    if (!typed.ok) return { ok: false, code: "CDP_INPUT_FAILED", error: typed.error, methods };

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
