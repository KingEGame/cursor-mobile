import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backoffDelay, createSupervisor, initialStatus, labelFor, reduceStatus } from "./hub-supervisor.mjs";

/** Fake clock + fake child so no real timers or processes are involved. */
function harness(opts = {}) {
  let t = 0;
  let nextId = 1;
  const timers = new Map();
  const children = [];
  const statuses = [];
  const sup = createSupervisor({
    spawn: (handlers) => {
      const c = { ...handlers, killed: 0, kill() { c.killed += 1; }, sent: [], send(m) { c.sent.push(m); } };
      children.push(c);
      return c;
    },
    onStatus: (s) => statuses.push(s),
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: t + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    now: () => t,
    ...opts,
  });
  return {
    sup,
    children,
    statuses,
    last: () => statuses[statuses.length - 1],
    /** Advance the clock, firing due timers in order. */
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    },
    pendingTimers: () => timers.size,
  };
}

const READY = {
  type: "ready",
  status: { listenUrl: "http://127.0.0.1:8787", tailscaleHint: "100.1.2.3", meshHint: "http://100.1.2.3:8787", liveState: null },
};

describe("backoffDelay", () => {
  it("doubles from the base and caps at the max", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => backoffDelay(n)), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    assert.equal(backoffDelay(3, { baseDelayMs: 100, maxDelayMs: 250 }), 250);
  });
  it("treats nonsense attempts as the first", () => {
    assert.equal(backoffDelay(0), 1000);
    assert.equal(backoffDelay(-4), 1000);
  });
});

describe("reduceStatus / labelFor", () => {
  it("maps ready to a running status with the child's endpoints", () => {
    const s = reduceStatus(initialStatus(), READY);
    assert.equal(s.running, true);
    assert.equal(s.phase, "running");
    assert.equal(s.stateLabel, "Running");
    assert.equal(s.tailscaleHint, "100.1.2.3");
    assert.equal(s.error, null);
  });
  it("shows 'Hub restarting' after an exit and clears running", () => {
    const running = reduceStatus(initialStatus(), READY);
    const s = reduceStatus(running, { type: "exit", code: 1, signal: null, attempt: 1, delayMs: 1000 });
    assert.equal(s.running, false);
    assert.equal(s.phase, "restarting");
    assert.equal(s.stateLabel, "Hub restarting…");
    assert.equal(s.restartInMs, 1000);
    assert.match(s.error, /code 1/);
    assert.equal(s.listenUrl, "http://127.0.0.1:8787", "keeps last-known endpoints while restarting");
    assert.equal(labelFor({ phase: "restarting", restartAttempt: 3 }), "Hub restarting (attempt 3)…");
  });
  it("a failed CDP probe sets the error but does not stop the Hub", () => {
    const running = reduceStatus(initialStatus(), READY);
    const s = reduceStatus(running, { type: "live", liveState: "unknown", error: "probe timed out" });
    assert.equal(s.running, true);
    assert.equal(s.liveState, "unknown");
    assert.equal(s.error, "probe timed out");
    const ok = reduceStatus(s, { type: "live", liveState: "cdp_ok", error: null });
    assert.equal(ok.error, null);
    assert.equal(ok.liveState, "cdp_ok");
  });
  it("stopped is terminal", () => {
    assert.equal(reduceStatus(reduceStatus(initialStatus(), READY), { type: "stopped" }).stateLabel, "Stopped");
  });
});

describe("createSupervisor", () => {
  it("reports Starting, then Running on ready, and clears the startup timer", () => {
    const h = harness();
    h.sup.start();
    assert.equal(h.last().stateLabel, "Starting…");
    h.children[0].onMessage(READY);
    assert.equal(h.last().running, true);
    h.advance(120_000);
    assert.equal(h.children.length, 1, "no startup-timeout restart once ready");
  });

  it("publishes the first status without waiting for the CDP probe", () => {
    const h = harness();
    h.sup.start();
    h.children[0].onMessage(READY);
    assert.equal(h.last().running, true);
    assert.equal(h.last().liveState, null);
    h.children[0].onMessage({ type: "live", liveState: "cdp_ok", error: null });
    assert.equal(h.last().liveState, "cdp_ok");
  });

  it("restarts with exponential backoff and shows 'Hub restarting'", () => {
    const h = harness();
    h.sup.start();
    h.children[0].onExit(1, null);
    assert.equal(h.last().stateLabel, "Hub restarting…");
    assert.equal(h.last().restartInMs, 1000);
    h.advance(999);
    assert.equal(h.children.length, 1);
    h.advance(1);
    assert.equal(h.children.length, 2);
    h.children[1].onExit(1, null);
    assert.equal(h.last().restartInMs, 2000);
    assert.equal(h.last().restartAttempt, 2);
    h.advance(2000);
    assert.equal(h.children.length, 3);
    h.children[2].onMessage(READY);
    assert.equal(h.last().phase, "running");
  });

  it("resets the failure streak after a stable run", () => {
    const h = harness();
    h.sup.start();
    h.children[0].onExit(1, null); // streak 1
    h.advance(1000);
    h.children[1].onExit(1, null); // streak 2
    h.advance(2000);
    h.children[2].onMessage(READY);
    h.advance(61_000); // stable
    h.children[2].onExit(null, "SIGKILL");
    assert.equal(h.last().restartAttempt, 1);
    assert.equal(h.last().restartInMs, 1000);
    assert.match(h.last().error, /SIGKILL/);
  });

  it("does not reset the streak when the Hub crashes soon after ready", () => {
    const h = harness();
    h.sup.start();
    h.children[0].onMessage(READY);
    h.advance(5000);
    h.children[0].onExit(1, null); // streak 1
    h.advance(1000);
    h.children[1].onMessage(READY);
    h.advance(5000);
    h.children[1].onExit(1, null);
    assert.equal(h.last().restartAttempt, 2);
  });

  it("kills and restarts a Hub that never becomes ready (startup timeout)", () => {
    const h = harness({ startupTimeoutMs: 5000 });
    h.sup.start();
    h.advance(5000);
    assert.equal(h.children[0].killed, 1);
    assert.match(h.last().error, /did not start within 5s/);
    // The kill surfaces as an exit; the timeout reason must survive it.
    h.children[0].onExit(null, "SIGTERM");
    assert.match(h.last().error, /did not start within 5s/);
    assert.equal(h.last().stateLabel, "Hub restarting…");
    h.advance(1000);
    assert.equal(h.children.length, 2);
  });

  it("keeps the child's fatal error through the exit that follows", () => {
    const h = harness();
    h.sup.start();
    h.children[0].onMessage({ type: "fatal", error: "EADDRINUSE 0.0.0.0:8787" });
    h.children[0].onExit(1, null);
    assert.equal(h.last().error, "EADDRINUSE 0.0.0.0:8787");
    assert.equal(h.last().running, false);
  });

  it("ignores late events from a previous child", () => {
    const h = harness();
    h.sup.start();
    const old = h.children[0];
    old.onExit(1, null);
    h.advance(1000);
    old.onMessage(READY);
    assert.equal(h.last().running, false, "stale ready must not mark the new child running");
    old.onExit(1, null);
    assert.equal(h.last().restartAttempt, 1, "stale exit must not bump the streak");
  });

  it("stop() kills the child, cancels timers, and never restarts", () => {
    const h = harness();
    h.sup.start();
    h.children[0].onMessage(READY);
    h.sup.stop();
    assert.equal(h.children[0].killed, 1);
    assert.equal(h.last().stateLabel, "Stopped");
    h.children[0].onExit(0, null);
    h.advance(300_000);
    assert.equal(h.children.length, 1);
    assert.equal(h.pendingTimers(), 0);
  });

  it("stop() during a backoff wait cancels the pending restart", () => {
    const h = harness();
    h.sup.start();
    h.children[0].onExit(1, null);
    h.sup.stop();
    h.advance(60_000);
    assert.equal(h.children.length, 1);
  });

  it("requestRefresh forwards to the running child", () => {
    const h = harness();
    h.sup.start();
    h.children[0].onMessage(READY);
    h.sup.requestRefresh();
    assert.deepEqual(h.children[0].sent, [{ type: "refresh" }]);
  });
});
