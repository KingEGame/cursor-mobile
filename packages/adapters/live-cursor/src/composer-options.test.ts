/**
 * Composer mode/model selection is verified by re-reading the composer — fail closed.
 */
import { describe, expect, it } from "vitest";
import { createMockCdpClient } from "./cdp-client.js";
import { normalizeModelLabel, setComposerMode, setComposerModel } from "./composer-options.js";

const noWait = async () => undefined;

/** Fake composer: pills + model label change only when the right option is clicked. */
function fakeComposer(opts: { modeSticks?: boolean; modelSticks?: boolean } = {}) {
  const state = { pills: ["Push"], model: "Auto", lastTarget: "" };
  const client = createMockCdpClient({
    "Runtime.evaluate": (params) => {
      const expr = String(params.expression);
      if (expr.includes("pills")) return { result: { value: { pills: state.pills, model: state.model } } };
      const mode = /startsWith\("(\w+)"\)/.exec(expr)?.[1];
      if (mode) state.lastTarget = `mode:${mode}`;
      const model = /=== "([^"]+)"\)/.exec(expr)?.[1];
      if (model) state.lastTarget = `model:${model}`;
      return { result: { value: { x: 5, y: 5 } } };
    },
    "Input.dispatchMouseEvent": (params) => {
      if (params.type !== "mouseReleased") return {};
      if (state.lastTarget.startsWith("mode:") && opts.modeSticks !== false) state.pills.push(state.lastTarget.slice(5));
      if (state.lastTarget.startsWith("model:") && opts.modelSticks !== false) state.model = state.lastTarget.slice(6);
      return {};
    },
  });
  return { client, state };
}

describe("normalizeModelLabel", () => {
  it("strips zero-width characters and the New badge", () => {
    expect(normalizeModelLabel("Grok 4.7 High Fast​​New")).toBe("Grok 4.7 High Fast");
    expect(normalizeModelLabel(" Auto ")).toBe("Auto");
  });
});

describe("setComposerMode", () => {
  it("selects the mode from the + list and confirms the pill", async () => {
    const { client } = fakeComposer();
    expect(await setComposerMode(client, "Plan", noWait)).toMatchObject({ ok: true, mode: "Plan" });
  });

  it("fails closed and presses Escape when the pill never appears", async () => {
    const { client } = fakeComposer({ modeSticks: false });
    const res = await setComposerMode(client, "Debug", noWait);
    expect(res).toMatchObject({ ok: false, code: "MODE_NOT_APPLIED" });
    expect(client.calls.some((c) => c.method === "Input.dispatchKeyEvent")).toBe(true);
  });
});

describe("setComposerModel", () => {
  it("is a no-op when the model is already selected", async () => {
    const { client } = fakeComposer();
    expect(await setComposerModel(client, "Auto", noWait)).toMatchObject({ ok: true, model: "Auto" });
    expect(client.calls.map((c) => c.method)).not.toContain("Input.dispatchMouseEvent");
  });

  it("picks the model by its menu label and confirms the trigger text", async () => {
    const { client } = fakeComposer();
    expect(await setComposerModel(client, "Claude Opus 5.5 Medium", noWait)).toMatchObject({
      ok: true,
      model: "Claude Opus 5.5 Medium",
    });
  });

  it("fails closed when the picker does not change", async () => {
    const { client } = fakeComposer({ modelSticks: false });
    expect(await setComposerModel(client, "Composer 2.5 Fast", noWait)).toMatchObject({
      ok: false,
      code: "MODEL_NOT_APPLIED",
    });
  });
});
