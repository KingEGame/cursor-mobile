/**
 * Open model picker + @ mentions menu on the CDP Cursor window (prep for verify).
 * Does not write the pack. Does not kill Cursor.
 */
import {
  fetchCdpTargetList,
  selectWindowTargets,
} from "../packages/adapters/live-cursor/src/cdp-http.ts";
import { CdpWebSocketClient } from "../packages/adapters/live-cursor/src/cdp-client.ts";
import {
  assertLoopbackCdpUrl,
  normalizeCdpUrl,
} from "../packages/adapters/live-cursor/src/loopback.ts";

const CDP_URL = normalizeCdpUrl(process.env.CDP_URL ?? "http://127.0.0.1:9222");
assertLoopbackCdpUrl(CDP_URL);

interface RuntimeEvaluateResult {
  result?: { type?: string; value?: unknown };
}

async function evalJson(
  client: CdpWebSocketClient,
  expression: string,
): Promise<unknown> {
  const r = await client.send<RuntimeEvaluateResult>("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  return r.result?.value;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const list = await fetchCdpTargetList(CDP_URL, 3000);
  if (!list.ok) throw new Error(list.error);
  const target = selectWindowTargets(list.data).find(
    (t) => t.webSocketDebuggerUrl,
  );
  if (!target?.webSocketDebuggerUrl) throw new Error("no window target");

  const client = await CdpWebSocketClient.connect(target.webSocketDebuggerUrl);
  try {
    await client.send("Runtime.enable");

    // Escape any open popovers
    for (let i = 0; i < 2; i++) {
      await client.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        windowsVirtualKeyCode: 27,
        key: "Escape",
      });
      await client.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        windowsVirtualKeyCode: 27,
        key: "Escape",
      });
      await sleep(150);
    }

    // Open model picker (Auto button / vscode-model-picker)
    const modelOpen = await evalJson(
      client,
      `(() => {
        const trigger =
          document.querySelector(".vscode-model-picker__trigger-text") ||
          Array.from(document.querySelectorAll(".composer-bar-input-buttons button, .composer-bar button"))
            .find((b) => (b.textContent || "").trim() === "Auto");
        if (!trigger) return { ok: false, reason: "no model trigger" };
        const btn = trigger.closest("button") || trigger;
        btn.click();
        return {
          ok: true,
          cls: (btn.className || "").toString().slice(0, 100),
          text: (btn.textContent || "").trim().slice(0, 40),
        };
      })()`,
    );
    console.log("modelOpen", JSON.stringify(modelOpen));
    await sleep(500);

    // Confirm model menu visible (leave it open for verify)
    const modelMenu = await evalJson(
      client,
      `(() => {
        const el =
          document.querySelector("[data-testid='selected-auto-menu']") ||
          document.querySelector(".vscode-model-picker__trigger-text");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          testid: el.getAttribute("data-testid"),
          cls: (el.className || "").toString().slice(0, 80),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      })()`,
    );
    console.log("modelMenu", JSON.stringify(modelMenu));

    // Open @ mentions in parallel-ish: if model menu is open, verify can still
    // match model_select trigger. For file_attach we need mentions-menu —
    // close model menu first then type @.
    await client.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      windowsVirtualKeyCode: 27,
      key: "Escape",
    });
    await client.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      windowsVirtualKeyCode: 27,
      key: "Escape",
    });
    await sleep(200);

    // Re-open model picker AND keep trigger visible (verify matches trigger without menu)
    // Then open @ in composer for file_attach.
    const focus = await evalJson(
      client,
      `(() => {
        const el =
          document.querySelector("div.composer-bar.editor [role='textbox']") ||
          document.querySelector(".composer-bar [role='textbox']");
        if (!el) return { ok: false };
        el.focus();
        // Clear leftover @ from prior probe if any
        return { ok: true };
      })()`,
    );
    console.log("focusComposer", JSON.stringify(focus));
    await client.send("Input.insertText", { text: "@" });
    await sleep(600);

    const mentions = await evalJson(
      client,
      `(() => {
        const el =
          document.querySelector(".typeahead-popover.mentions-menu") ||
          document.querySelector(".mentions-menu");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          cls: (el.className || "").toString().slice(0, 100),
          text: (el.textContent || "").trim().slice(0, 80),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      })()`,
    );
    console.log("mentionsMenu", JSON.stringify(mentions));

    // Model trigger should still be in DOM without needing menu open
    const modelTrigger = await evalJson(
      client,
      `(() => {
        const el = document.querySelector(".vscode-model-picker__trigger-text");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { text: (el.textContent || "").trim(), w: Math.round(r.width), h: Math.round(r.height) };
      })()`,
    );
    console.log("modelTrigger", JSON.stringify(modelTrigger));

    // History control
    const history = await evalJson(
      client,
      `(() => {
        const el =
          document.querySelector("[aria-label*='Chat History']") ||
          document.querySelector("[aria-label*='History']") ||
          document.querySelector("[data-composer-id]");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          aria: el.getAttribute("aria-label"),
          dataComposerId: el.getAttribute("data-composer-id"),
          cls: (el.className || "").toString().slice(0, 80),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      })()`,
    );
    console.log("historyCtrl", JSON.stringify(history));
    console.log("prep done — leave @ menu open for file_attach match");
  } finally {
    await client.close().catch(() => undefined);
  }
}

await main();
