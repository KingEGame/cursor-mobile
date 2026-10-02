/**
 * Optional live CDP probe — runs only when Cursor remote debugging is up on
 * loopback (127.0.0.1). Never probes non-loopback CDP.
 *
 * Enable explicitly with LIVE_CDP_PROBE=1, or auto-detect when /json/version responds.
 * DOM selector verification is still manual — this probe only proves CDP attach.
 */
import { describe, expect, it } from "vitest";
import { fetchCdpTargetList, fetchCdpVersion } from "./cdp-http.js";
import { assertLoopbackCdpUrl, normalizeCdpUrl } from "./loopback.js";
import { LiveCursorAdapterImpl } from "./adapter.js";
import { resolveSelectorPackStatus } from "./selector-pack.js";

const CDP_URL = normalizeCdpUrl(
  process.env.CDP_URL ?? "http://127.0.0.1:9222",
);

async function cdpReachable(): Promise<boolean> {
  try {
    assertLoopbackCdpUrl(CDP_URL);
  } catch {
    return false;
  }
  const version = await fetchCdpVersion(CDP_URL, 500);
  return version.ok;
}

const forceProbe =
  (process.env.LIVE_CDP_PROBE ?? "").toLowerCase() === "1" ||
  (process.env.LIVE_CDP_PROBE ?? "").toLowerCase() === "true";

const reachable = await cdpReachable();
const runLive = forceProbe || reachable;

describe.skipIf(!runLive)("optional live CDP probe (loopback only)", () => {
  it("rejects if CDP_URL is not loopback", () => {
    expect(() => assertLoopbackCdpUrl(CDP_URL)).not.toThrow();
  });

  it("GET /json/version succeeds on 127.0.0.1", async () => {
    const version = await fetchCdpVersion(CDP_URL, 2000);
    expect(version.ok).toBe(true);
  });

  it("lists targets and reports cdp_ok when pack is fully VERIFIED", async () => {
    const list = await fetchCdpTargetList(CDP_URL, 2000);
    expect(list.ok).toBe(true);

    const status = resolveSelectorPackStatus({
      LIVE_SELECTOR_PACK_READY: "false",
    });
    expect(status.verified).toBe(true);

    const adapter = new LiveCursorAdapterImpl({
      cdpUrl: CDP_URL,
      selectorPack: status,
      fetchTimeoutMs: 2000,
    });
    const health = await adapter.attach();
    // CDP up + fully VERIFIED pack → cdp_ok (honest).
    expect(health.state).toBe("cdp_ok");
    expect(health.extractorReady).toBe(true);
    expect(health.cdpUrl).toMatch(/127\.0\.0\.1|localhost/);
  });
});

describe.skipIf(runLive)("CDP probe skipped (no loopback Cursor)", () => {
  it("documents skip — unit fail-closed tests remain the default gate", () => {
    expect(reachable).toBe(false);
  });
});
