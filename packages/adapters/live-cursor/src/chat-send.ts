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
  | { ok: true; switched: boolean; methods: string[] }
  | {
      ok: false;
      code: "CHAT_NOT_IN_SIDEBAR" | "CHAT_SWITCH_FAILED" | "CDP_INPUT_FAILED";
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
