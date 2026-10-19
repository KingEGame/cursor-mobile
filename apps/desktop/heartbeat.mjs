/**
 * Liveness watchdog for the Hub child: pings /health and reports a hang after N misses in a row.
 * The supervisor only notices exits; this catches a Hub that is alive but event-loop-blocked.
 * Timers and the ping are injected so it is testable.
 */
export function createHeartbeat({ ping, onDead, intervalMs = 10_000, maxMisses = 3, setTimer = setInterval, clearTimer = clearInterval }) {
  let misses = 0;
  let handle = null;
  let busy = false;

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const ok = await ping();
      misses = ok ? 0 : misses + 1;
    } catch {
      misses += 1;
    } finally {
      busy = false;
    }
    if (misses >= maxMisses) {
      misses = 0;
      onDead();
    }
  }

  return {
    start() {
      if (handle == null) handle = setTimer(tick, intervalMs);
    },
    stop() {
      if (handle != null) clearTimer(handle);
      handle = null;
      misses = 0;
    },
    /** Child (re)started: forget old misses so a fresh Hub gets a full grace period. */
    reset() {
      misses = 0;
    },
    tick,
  };
}
