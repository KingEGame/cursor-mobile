/**
 * Deep probe + open model/attach/history UI via whatever owns loopback CDP.
 * HARD BAN: main Cursor window only (quit → npm run start:cursor:cdp).
 * Never launch /tmp/cursor-mobile-cdp-profile. Does not kill Cursor. Does not write the pack.
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
  exceptionDetails?: { text?: string };
}

async function evalJson(
  client: CdpWebSocketClient,
  expression: string,
): Promise<unknown> {
  const r = await client.send<RuntimeEvaluateResult>("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text ?? "eval failed");
  }
  return r.result?.value;
}

async function clickCenter(
  client: CdpWebSocketClient,
  selector: string,
): Promise<unknown> {
  const box = (await evalJson(
    client,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height,
        aria: el.getAttribute('aria-label'), text: (el.textContent||'').trim().slice(0,80),
        cls: (el.className||'').toString().slice(0,120) };
    })()`,
  )) as { x: number; y: number } | null;
  if (!box) return { ok: false, reason: "no element", selector };
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: box.x,
    y: box.y,
    button: "left",
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: box.x,
    y: box.y,
    button: "left",
    clickCount: 1,
  });
  return { ok: true, selector, box };
}

const DEEP_PROBE = `(() => {
  const interesting = [];
  const all = document.querySelectorAll("button, [role='button'], a.action-label, [aria-label], [class*='model'], [class*='context'], [class*='attach'], [class*='mention'], [data-testid]");
  for (const el of Array.from(all)) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const aria = el.getAttribute("aria-label") || "";
    const title = el.getAttribute("title") || "";
    const cls = (el.className || "").toString();
    const text = (el.textContent || "").trim().slice(0, 80);
    const testid = el.getAttribute("data-testid") || "";
    const blob = (aria + " " + title + " " + cls + " " + text + " " + testid).toLowerCase();
    if (!(
      blob.includes("model") ||
      blob.includes("auto") ||
      blob.includes("attach") ||
      blob.includes("context") ||
      blob.includes("mention") ||
      blob.includes("@") ||
      blob.includes("dropdown") ||
      blob.includes("picker") ||
      blob.includes("history") ||
      blob.includes("composer-unified") ||
      blob.includes("ui-model")
    )) continue;
    interesting.push({
      tag: el.tagName,
      aria: aria || null,
      title: title || null,
      testid: testid || null,
      cls: cls.slice(0, 160),
      text,
      w: Math.round(r.width),
      h: Math.round(r.height),
      x: Math.round(r.left),
      y: Math.round(r.top),
    });
  }
  // Also list open menus / popovers
  const menus = [];
  for (const el of Array.from(document.querySelectorAll("[role='menu'], [role='listbox'], [data-testid*='model'], .composer-unified-context-menu-item, [class*='context-menu'], [class*='mention-picker'], [class*='context-picker']"))) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    menus.push({
      tag: el.tagName,
      role: el.getAttribute("role"),
      testid: el.getAttribute("data-testid"),
      cls: (el.className || "").toString().slice(0, 140),
      text: (el.textContent || "").trim().slice(0, 100),
      w: Math.round(r.width),
      h: Math.round(r.height),
    });
  }
  return { interesting: interesting.slice(0, 80), menus: menus.slice(0, 40) };
})()`;

async function main(): Promise<void> {
  const list = await fetchCdpTargetList(CDP_URL, 3000);
  if (!list.ok) throw new Error(list.error);
  const target = selectWindowTargets(list.data).find((t) => t.webSocketDebuggerUrl);
  if (!target?.webSocketDebuggerUrl) throw new Error("no window target");

  const client = await CdpWebSocketClient.connect(target.webSocketDebuggerUrl);
  try {
    await client.send("Runtime.enable");
    console.log("=== deep probe (before clicks) ===");
    console.log(JSON.stringify(await evalJson(client, DEEP_PROBE), null, 2));

    // Try click "Auto" model-ish button in composer-bar-input-buttons
    console.log("\n=== click Auto button ===");
    const autoClick = await evalJson(
      client,
      `(() => {
        const btns = Array.from(document.querySelectorAll(".composer-bar-input-buttons button, .composer-bar button"));
        const auto = btns.find(b => (b.textContent||"").trim() === "Auto");
        if (!auto) return { ok: false, reason: "no Auto" };
        const r = auto.getBoundingClientRect();
        auto.click();
        return { ok: true, aria: auto.getAttribute("aria-label"), cls: (auto.className||"").toString().slice(0,120), w: r.width, h: r.height };
      })()`,
    );
    console.log(JSON.stringify(autoClick));
    await new Promise((r) => setTimeout(r, 600));
    console.log("=== after Auto click ===");
    console.log(JSON.stringify(await evalJson(client, DEEP_PROBE), null, 2));

    // Escape to close
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 27, key: "Escape" });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 27, key: "Escape" });
    await new Promise((r) => setTimeout(r, 300));

    // Click mode dropdown "Agent" — then look for model nearby
    console.log("\n=== click Agent mode dropdown ===");
    console.log(JSON.stringify(await clickCenter(client, ".composer-unified-dropdown")));
    await new Promise((r) => setTimeout(r, 500));
    console.log(JSON.stringify(await evalJson(client, DEEP_PROBE), null, 2));
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 27, key: "Escape" });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 27, key: "Escape" });
    await new Promise((r) => setTimeout(r, 300));

    // Try Add Context / @ via textbox typing @
    console.log("\n=== type @ into composer textbox ===");
    const focus = await evalJson(
      client,
      `(() => {
        const el = document.querySelector("div.composer-bar.editor [role='textbox']")
          || document.querySelector(".composer-bar [role='textbox']");
        if (!el) return { ok: false };
        el.focus();
        return { ok: true };
      })()`,
    );
    console.log(JSON.stringify(focus));
    await client.send("Input.insertText", { text: "@" });
    await new Promise((r) => setTimeout(r, 700));
    console.log("=== after @ ===");
    console.log(JSON.stringify(await evalJson(client, DEEP_PROBE), null, 2));

    // Also dump mention/context specific
    const mentionDump = await evalJson(
      client,
      `(() => {
        const out = [];
        for (const el of Array.from(document.querySelectorAll("[class*='mention'], [class*='context-picker'], [class*='context-menu'], [class*='quick-input'], .monaco-list-row, [role='option'], [role='listbox']"))) {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          out.push({
            tag: el.tagName,
            role: el.getAttribute("role"),
            aria: el.getAttribute("aria-label"),
            cls: (el.className||"").toString().slice(0,140),
            text: (el.textContent||"").trim().slice(0,80),
            w: Math.round(r.width), h: Math.round(r.height),
          });
        }
        return out.slice(0, 40);
      })()`,
    );
    console.log("mentionDump", JSON.stringify(mentionDump, null, 2));

    // Backspace the @
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 8, key: "Backspace" });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 8, key: "Backspace" });

    // Click Show Chat History
    console.log("\n=== click Show Chat History ===");
    const histClick = await evalJson(
      client,
      `(() => {
        const el = document.querySelector("[aria-label*='Chat History'], [aria-label*='History']");
        if (!el) return { ok: false };
        const r = el.getBoundingClientRect();
        el.click();
        return { ok: true, aria: el.getAttribute("aria-label"), cls: (el.className||"").toString().slice(0,120) };
      })()`,
    );
    console.log(JSON.stringify(histClick));
    await new Promise((r) => setTimeout(r, 700));
    const histDump = await evalJson(
      client,
      `(() => {
        const out = [];
        const sels = [
          "[data-composer-id]", "[data-chat-id]", ".glass-sidebar-agent-menu-btn",
          ".agent-sidebar-cell", ".agent-sidebar-cell-text", ".ui-sidebar-menu-button-label",
          "span.auxiliary-bar-chat-title", "[class*='composer-history'] [role='button']",
          "[role='listitem']", "[role='option']", "[role='treeitem']",
          "li.ui-sidebar-menu-item", ".glass-sidebar-agent-list-container *"
        ];
        for (const s of sels) {
          try {
            for (const el of Array.from(document.querySelectorAll(s)).slice(0, 5)) {
              const r = el.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) continue;
              out.push({
                s,
                tag: el.tagName,
                aria: el.getAttribute("aria-label"),
                dataComposerId: el.getAttribute("data-composer-id"),
                dataChatId: el.getAttribute("data-chat-id"),
                cls: (el.className||"").toString().slice(0,140),
                text: (el.textContent||"").trim().slice(0,60),
                w: Math.round(r.width), h: Math.round(r.height),
              });
            }
          } catch {}
        }
        return out.slice(0, 60);
      })()`,
    );
    console.log("histDump", JSON.stringify(histDump, null, 2));
  } finally {
    await client.close().catch(() => undefined);
  }
}

await main();
