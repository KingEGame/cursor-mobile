/**
 * Unit tests for Composer model-picker CDP scrape (no live Cursor required).
 */
import { describe, expect, it } from "vitest";
import { createMockCdpClient } from "./cdp-client.js";
import { scrapeComposerModels } from "./model-scrape.js";

describe("scrapeComposerModels", () => {
  it("returns models from open menu menuitems after trigger click", async () => {
    let evalCount = 0;
    const client = createMockCdpClient({
      "Runtime.evaluate": (params) => {
        evalCount += 1;
        const expr = String((params as { expression?: string }).expression ?? "");
        if (expr.includes("getBoundingClientRect")) {
          return {
            result: {
              type: "object",
              value: { x: 10, y: 20, width: 40, height: 18 },
            },
          };
        }
        if (expr.includes("labels")) {
          return {
            result: {
              type: "object",
              value: {
                labels: ["Auto", "composer-1", "claude-4-sonnet"],
                current: "Auto",
              },
            },
          };
        }
        return { result: { type: "object", value: null } };
      },
      "Input.dispatchMouseEvent": () => ({}),
      "Input.dispatchKeyEvent": () => ({}),
    });

    const result = await scrapeComposerModels(client);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.models.length).toBe(3);
    expect(result.models[0]!.id).toBe("auto");
    expect(result.models[0]!.default).toBe(true);
    expect(result.models[1]!.id).toBe("composer-1");
    expect(result.models[2]!.family).toBe("claude");
    expect(evalCount).toBeGreaterThan(0);
    await client.close();
  });

  it("fails when trigger is missing", async () => {
    const client = createMockCdpClient({
      "Runtime.evaluate": () => ({
        result: { type: "object", value: null },
      }),
    });
    const result = await scrapeComposerModels(client);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/trigger/i);
    await client.close();
  });
});
