/**
 * CDP Input executor — click / type behind selector strategies (TOR-06).
 *
 * Callers MUST gate on per-action VERIFIED (or ops override) before invoking.
 * This module does not flip verification flags and does not soft-succeed on miss.
 */

import type { CdpClient } from "./cdp-client.js";
import type { ActionSelector, SelectorActionId } from "./selector-pack.js";

export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CdpInputOk = {
  ok: true;
  action: SelectorActionId;
  strategy: string;
  methods: string[];
};

export type CdpInputFail = {
  ok: false;
  action: SelectorActionId;
  error: string;
  methods: string[];
};

export type CdpInputResult = CdpInputOk | CdpInputFail;

interface RuntimeEvaluateResult {
  result?: {
    type?: string;
    value?: unknown;
    subtype?: string;
  };
  exceptionDetails?: { text?: string };
}

function recordedMethods(methods: string[], method: string): string[] {
  methods.push(method);
  return methods;
}

/**
 * Resolve first matching strategy to a viewport center via Runtime.evaluate.
 */
export async function resolveElementCenter(
  client: CdpClient,
  strategies: string[],
  methods: string[] = [],
): Promise<{ strategy: string; box: ElementBox } | null> {
  for (const strategy of strategies) {
    const expression = `(() => {
      const el = document.querySelector(${JSON.stringify(strategy)});
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return {
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
        width: r.width,
        height: r.height
      };
    })()`;
    recordedMethods(methods, "Runtime.evaluate");
    const evalResult = await client.send<RuntimeEvaluateResult>(
      "Runtime.evaluate",
      { expression, returnByValue: true },
    );
    if (evalResult.exceptionDetails) {
      continue;
    }
    const value = evalResult.result?.value;
    if (
      value &&
      typeof value === "object" &&
      typeof (value as ElementBox).x === "number" &&
      typeof (value as ElementBox).y === "number"
    ) {
      return { strategy, box: value as ElementBox };
    }
  }
  return null;
}

/**
 * Fallback: find clickable by visible text (Approve / Deny / Send labels).
 */
export async function resolveElementCenterByText(
  client: CdpClient,
  texts: string[],
  methods: string[] = [],
): Promise<{ strategy: string; box: ElementBox } | null> {
  if (texts.length === 0) return null;
  const expression = `(() => {
    const texts = ${JSON.stringify(texts)};
    const candidates = Array.from(
      document.querySelectorAll("button, [role='button'], a, [tabindex]")
    );
    for (const el of candidates) {
      const label = (el.getAttribute("aria-label") || el.textContent || "")
        .trim();
      if (!label) continue;
      if (!texts.some((t) => label.includes(t))) continue;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      return {
        strategy: "text:" + label.slice(0, 64),
        box: {
          x: r.x + r.width / 2,
          y: r.y + r.height / 2,
          width: r.width,
          height: r.height
        }
      };
    }
    return null;
  })()`;
  recordedMethods(methods, "Runtime.evaluate");
  const evalResult = await client.send<RuntimeEvaluateResult>(
    "Runtime.evaluate",
    { expression, returnByValue: true },
  );
  if (evalResult.exceptionDetails) return null;
  const value = evalResult.result?.value as
    | { strategy: string; box: ElementBox }
    | null
    | undefined;
  if (
    value &&
    typeof value.strategy === "string" &&
    value.box &&
    typeof value.box.x === "number"
  ) {
    return value;
  }
  return null;
}

/** Input.dispatchMouseEvent press+release at viewport coordinates. */
export async function dispatchClick(
  client: CdpClient,
  x: number,
  y: number,
  methods: string[] = [],
): Promise<void> {
  const base = {
    x,
    y,
    button: "left" as const,
    clickCount: 1,
  };
  recordedMethods(methods, "Input.dispatchMouseEvent");
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...base,
  });
  recordedMethods(methods, "Input.dispatchMouseEvent");
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...base,
  });
}

/** Prefer Input.insertText; callers may fall back to Runtime.evaluate. */
export async function insertText(
  client: CdpClient,
  text: string,
  methods: string[] = [],
): Promise<void> {
  recordedMethods(methods, "Input.insertText");
  await client.send("Input.insertText", { text });
}

/**
 * Set focused contenteditable / textarea value via Runtime.evaluate
 * when insertText is insufficient (some Electron controls).
 */
export async function setFocusedEditableValue(
  client: CdpClient,
  text: string,
  methods: string[] = [],
): Promise<boolean> {
  const expression = `(() => {
    const el = document.activeElement;
    if (!el) return false;
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      el.focus();
      el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    if (el.getAttribute("contenteditable") === "true" || el.isContentEditable) {
      el.focus();
      el.textContent = ${JSON.stringify(text)};
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ${JSON.stringify(text)} }));
      return true;
    }
    return false;
  })()`;
  recordedMethods(methods, "Runtime.evaluate");
  const evalResult = await client.send<RuntimeEvaluateResult>(
    "Runtime.evaluate",
    { expression, returnByValue: true },
  );
  return evalResult.result?.value === true;
}

export async function pressEnter(
  client: CdpClient,
  methods: string[] = [],
): Promise<void> {
  recordedMethods(methods, "Input.dispatchKeyEvent");
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    windowsVirtualKeyCode: 13,
    code: "Enter",
    key: "Enter",
    text: "\r",
  });
  recordedMethods(methods, "Input.dispatchKeyEvent");
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    windowsVirtualKeyCode: 13,
    code: "Enter",
    key: "Enter",
  });
}

/**
 * Click the first matching strategy (CSS) or textMatch fallback.
 */
export async function executeClick(
  client: CdpClient,
  action: SelectorActionId,
  selector: ActionSelector,
): Promise<CdpInputResult> {
  const methods: string[] = [];
  try {
    let hit = await resolveElementCenter(client, selector.strategies, methods);
    if (!hit && selector.textMatch?.length) {
      hit = await resolveElementCenterByText(
        client,
        selector.textMatch,
        methods,
      );
    }
    if (!hit) {
      return {
        ok: false,
        action,
        error: `No DOM target for ${action} (strategies exhausted)`,
        methods,
      };
    }
    await dispatchClick(client, hit.box.x, hit.box.y, methods);
    return { ok: true, action, strategy: hit.strategy, methods };
  } catch (err) {
    return {
      ok: false,
      action,
      error: err instanceof Error ? err.message : String(err),
      methods,
    };
  }
}

/**
 * Focus composer → type text (insertText + evaluate fallback) → Enter to send.
 */
export async function executeTypeAndSubmit(
  client: CdpClient,
  action: SelectorActionId,
  selector: ActionSelector,
  text: string,
): Promise<CdpInputResult> {
  const methods: string[] = [];
  try {
    const hit = await resolveElementCenter(client, selector.strategies, methods);
    if (!hit) {
      return {
        ok: false,
        action,
        error: `No composer input for ${action} (strategies exhausted)`,
        methods,
      };
    }
    await dispatchClick(client, hit.box.x, hit.box.y, methods);
    await insertText(client, text, methods);
    // Best-effort DOM value sync for contenteditable Electron quirks.
    await setFocusedEditableValue(client, text, methods);
    await pressEnter(client, methods);
    return { ok: true, action, strategy: hit.strategy, methods };
  } catch (err) {
    return {
      ok: false,
      action,
      error: err instanceof Error ? err.message : String(err),
      methods,
    };
  }
}

/**
 * Drive a verified action. Does not check VERIFIED — caller must gate.
 */
export async function executeVerifiedAction(
  client: CdpClient,
  action: SelectorActionId,
  selector: ActionSelector,
  opts: { text?: string } = {},
): Promise<CdpInputResult> {
  switch (action) {
    case "send_message": {
      const text = opts.text?.trim() ?? "";
      if (!text) {
        return {
          ok: false,
          action,
          error: "send_message requires non-empty text",
          methods: [],
        };
      }
      return executeTypeAndSubmit(client, action, selector, text);
    }
    case "approve":
    case "deny":
    case "model_select":
    case "file_attach":
    case "composer_history_open":
      return executeClick(client, action, selector);
    default: {
      const _exhaustive: never = action;
      return {
        ok: false,
        action: _exhaustive,
        error: `Unknown action`,
        methods: [],
      };
    }
  }
}
