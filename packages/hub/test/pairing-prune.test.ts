/**
 * Stale paired devices can be pruned; recently seen and explicitly kept ones survive.
 */
import { describe, expect, it } from "vitest";
import { PairingStore } from "../src/config.js";

function pair(store: PairingStore, name: string) {
  const pending = store.start({ ttlSec: 300 });
  return store.complete(pending, { deviceName: name, platform: "android", appVersion: "1", tokenTtlSec: null });
}

describe("PairingStore.pruneStale", () => {
  it("revokes devices not seen since the cutoff and rejects their tokens", () => {
    const store = new PairingStore();
    const stale = pair(store, "old-uat");
    const kept = pair(store, "kept-by-id");
    const active = pair(store, "phone");
    const cutoff = new Date(Date.now() + 1);
    // Only the phone talks to the Hub after the cutoff.
    const later = Date.now() + 60_000;
    const realNow = Date.now;
    Date.now = () => later;
    try {
      expect(store.authenticate(active.deviceToken)?.deviceName).toBe("phone");
    } finally {
      Date.now = realNow;
    }
    const revoked = store.pruneStale(cutoff, [kept.deviceId]);
    expect(revoked).toEqual([stale.deviceId]);
    expect(store.authenticate(stale.deviceToken)).toBeNull();
    expect(store.authenticate(kept.deviceToken)).not.toBeNull();
    expect(store.pairedCount()).toBe(2);
  });
});
