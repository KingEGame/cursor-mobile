/**
 * Phone → specific Agents chat: open-then-type, fail closed when the switch is not confirmed.
 */
import { describe, expect, it } from "vitest";
import { createMockCdpClient } from "./cdp-client.js";
import { openAgentChat, sendToAgentChat, stopAgentChat } from "./chat-send.js";
import type { ActionSelector } from "./selector-pack.js";

const TARGET = "466762d6-04ca-46e6-a047-4ad7932ae829";
const OTHER = "c3ed9911-f8ac-4994-b0dc-756ba9cc565e";
const noWait = async () => undefined;
const sendSelector: ActionSelector = {
  action: "send_message",
  verification: "VERIFIED",
  strategies: [".ui-prompt-input-editor__input[contenteditable='true']"],
  verifiedAt: null,
  verifiedAgainst: null,
};

/** Fake Agents window: which chat is open, whether the row exists / is collapsed, and
 * whether a click on the row actually switches the main pane. */
function fakeCursor(opts: { open: string; rowPresent?: boolean; collapsed?: boolean; clickSwitches?: boolean }) {
  let open = opts.open;
  const client = createMockCdpClient({
    "Runtime.evaluate": (params) => {
      const expr = String(params.expression);
      if (expr.includes('querySelector("[data-composer-id]")')) return { result: { value: open } };
      if (expr.includes("present:")) {
        return { result: { value: { present: opts.rowPresent ?? true, collapsed: opts.collapsed ?? false } } };
      }
      // resolveElementCenter (row, section head, composer input) → a visible box.
      return { result: { value: { x: 10, y: 20, width: 100, height: 24 } } };
    },
    "Input.dispatchMouseEvent": (params) => {
      if (params.type === "mouseReleased" && (opts.clickSwitches ?? true)) open = TARGET;
      return {};
    },
  });
  return client;
}

const methods = (c: ReturnType<typeof createMockCdpClient>) => c.calls.map((x) => x.method);

describe("openAgentChat", () => {
  it("does nothing when the chat is already open on the PC", async () => {
    const client = fakeCursor({ open: TARGET });
    const res = await openAgentChat(client, TARGET, { wait: noWait });
    expect(res).toMatchObject({ ok: true, switched: false });
    expect(methods(client)).not.toContain("Input.dispatchMouseEvent");
  });

  it("clicks the sidebar row and confirms the switch", async () => {
    const client = fakeCursor({ open: OTHER });
    const res = await openAgentChat(client, TARGET, { wait: noWait });
    expect(res).toMatchObject({ ok: true, switched: true });
  });

  it("expands a collapsed project before clicking the row", async () => {
    const client = fakeCursor({ open: OTHER, collapsed: true });
    const res = await openAgentChat(client, TARGET, { wait: noWait });
    expect(res.ok).toBe(true);
    // head click (press+release) + row click (press+release)
    expect(methods(client).filter((m) => m === "Input.dispatchMouseEvent")).toHaveLength(4);
  });

  it("refuses ids that are not local composers (bc- cloud agents)", async () => {
    const client = fakeCursor({ open: OTHER });
    const res = await openAgentChat(client, "bc-64eb9b50-740d-48ba-9863-9cef302ce9b1", { wait: noWait });
    expect(res).toMatchObject({ ok: false, code: "CHAT_NOT_IN_SIDEBAR" });
    expect(client.calls).toHaveLength(0);
  });

  it("reports a chat that is not in the sidebar", async () => {
    const client = fakeCursor({ open: OTHER, rowPresent: false });
    const res = await openAgentChat(client, TARGET, { wait: noWait });
    expect(res).toMatchObject({ ok: false, code: "CHAT_NOT_IN_SIDEBAR" });
  });
});

describe("sendToAgentChat", () => {
  it("types and submits only after the target chat is open", async () => {
    const client = fakeCursor({ open: OTHER });
    const res = await sendToAgentChat(client, TARGET, "run the tests", sendSelector, { wait: noWait });
    expect(res.ok).toBe(true);
    const m = methods(client);
    expect(m.indexOf("Input.insertText")).toBeGreaterThan(m.lastIndexOf("Input.dispatchMouseEvent") - 2);
    expect(client.calls.find((c) => c.method === "Input.insertText")?.params).toEqual({ text: "run the tests" });
  });

  it("never types when Cursor did not switch to the chat", async () => {
    const client = fakeCursor({ open: OTHER, clickSwitches: false });
    const res = await sendToAgentChat(client, TARGET, "should not land elsewhere", sendSelector, {
      wait: noWait,
      switchTimeoutMs: 300,
    });
    expect(res).toMatchObject({ ok: false, code: "CHAT_SWITCH_FAILED" });
    expect(methods(client)).not.toContain("Input.insertText");
  });
});

describe("stopAgentChat", () => {
  it("clicks Stop generation in the target chat", async () => {
    const client = fakeCursor({ open: TARGET });
    const res = await stopAgentChat(client, TARGET, { wait: noWait });
    expect(res.ok).toBe(true);
    const evals = client.calls.filter((c) => c.method === "Runtime.evaluate").map((c) => String(c.params.expression));
    expect(evals.some((e) => e.includes("Stop generation"))).toBe(true);
  });

  it("reports NOT_RUNNING and clicks nothing when there is no stop button", async () => {
    const client = createMockCdpClient({
      "Runtime.evaluate": (params) =>
        String(params.expression).includes('querySelector("[data-composer-id]")')
          ? { result: { value: TARGET } }
          : { result: { value: null } },
    });
    const res = await stopAgentChat(client, TARGET, { wait: noWait });
    expect(res).toMatchObject({ ok: false, code: "NOT_RUNNING" });
    expect(client.calls.map((c) => c.method)).not.toContain("Input.dispatchMouseEvent");
  });
});
