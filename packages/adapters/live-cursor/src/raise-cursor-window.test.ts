import { describe, expect, it, vi } from "vitest";
import {
  ensureCursorWindowRaised,
  raiseCursorX11ScriptPath,
} from "./raise-cursor-window.js";
import type { CdpClient } from "./cdp-client.js";

function mockClient(visibility: {
  hidden: boolean;
  visibility: string;
  hasFocus: boolean;
}): CdpClient {
  const send = vi.fn(async (method: string) => {
    if (method === "Runtime.evaluate") {
      return { result: { value: visibility } };
    }
    return {};
  });
  return {
    send: send as CdpClient["send"],
    close: async () => undefined,
  };
}

describe("raiseCursorX11ScriptPath", () => {
  it("finds the packaged X11 helper next to dist/src", () => {
    expect(raiseCursorX11ScriptPath()).toMatch(/raise-cursor-x11\.py$/);
  });
});

describe("ensureCursorWindowRaised", () => {
  it("succeeds when the page is already visible (skips needing OS)", async () => {
    const client = mockClient({
      hidden: false,
      visibility: "visible",
      hasFocus: true,
    });
    const res = await ensureCursorWindowRaised(client, {
      targetId: "abc",
      skipOs: true,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.visibility).toBe("visible");
    expect(client.send).toHaveBeenCalledWith("Target.activateTarget", {
      targetId: "abc",
    });
    expect(client.send).toHaveBeenCalledWith("Page.bringToFront", {});
  });

  it("fails closed when still hidden after CDP bringToFront", async () => {
    const client = mockClient({
      hidden: true,
      visibility: "hidden",
      hasFocus: false,
    });
    const res = await ensureCursorWindowRaised(client, { skipOs: true });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("CURSOR_WINDOW_HIDDEN");
      expect(res.error).toMatch(/minimized|not visible/i);
    }
  });
});
