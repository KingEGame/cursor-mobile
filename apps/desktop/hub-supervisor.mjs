/**
 * Hub process supervisor — pure logic, no Electron imports (unit-tested without a GUI).
 *
 * The Electron main process must never run Hub work itself: synchronous SQLite reads and CDP calls
 * can block it and freeze the status window. main.mjs forks the Hub into a child process and this
 * module owns its lifecycle: status mapping, startup timeout, restart with exponential backoff.
 *
 * Child → supervisor messages (see hub-child.mjs):
 *   { type: "ready", status }          Hub is listening (liveState may still be null)
 *   { type: "live", liveState, error } result of the (time-boxed) CDP probe
 *   { type: "fatal", error }           startup failed; the child exits right after
 */

export const DEFAULTS = {
  /** First restart delay; doubles per consecutive failure. */
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  /** No "ready" within this long after spawn → kill and restart. */
  startupTimeoutMs: 20_000,
  /** A Hub that stayed ready this long counts as healthy: the failure streak resets. */
  stableAfterMs: 60_000,
};

/** Delay before restart number `attempt` (1-based): base, 2×base, 4×base … capped. */
export function backoffDelay(attempt, { baseDelayMs = DEFAULTS.baseDelayMs, maxDelayMs = DEFAULTS.maxDelayMs } = {}) {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(maxDelayMs, baseDelayMs * 2 ** (n - 1));
}

export function initialStatus() {
  return {
    phase: "starting",
    running: false,
    restarting: false,
    restartAttempt: 0,
    restartInMs: null,
    stateLabel: "Starting…",
    listenUrl: null,
    meshHint: null,
    cdpUrl: null,
    workspace: null,
    liveState: null,
    tailscaleHint: null,
    error: null,
    pairUrl: null,
    healthUrl: null,
  };
}

/** Human label shown by the window and tray for a status. */
export function labelFor(status) {
  switch (status.phase) {
    case "running":
      return "Running";
    case "restarting":
      return status.restartAttempt > 1 ? `Hub restarting (attempt ${status.restartAttempt})…` : "Hub restarting…";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    default:
      return "Starting…";
  }
}

function withLabel(status) {
  return { ...status, stateLabel: labelFor(status) };
}

/**
 * Pure status reducer.
 * Events: spawned | ready | live | fatal | exit | startup-timeout | stopped
 */
export function reduceStatus(prev, event) {
  switch (event.type) {
    case "spawned":
      // A respawn keeps the last-known endpoints but is not "running" until ready.
      return withLabel({ ...prev, phase: prev.restartAttempt > 0 ? "restarting" : "starting", running: false, restartInMs: null });
    case "ready":
      return withLabel({
        ...prev,
        ...event.status,
        phase: "running",
        running: true,
        restarting: false,
        restartInMs: null,
        error: event.status?.error ?? null,
      });
    case "live":
      return withLabel({
        ...prev,
        liveState: event.liveState ?? prev.liveState,
        // Tailscale may come up (or change address) after the Hub started: follow it live.
        ...(event.tailscaleHint !== undefined
          ? { tailscaleHint: event.tailscaleHint, meshHint: event.meshHint ?? null }
          : {}),
        // A failed probe is information, not an outage: show it without flipping the phase.
        error: event.error ?? (prev.phase === "running" ? null : prev.error),
      });
    case "fatal":
      return withLabel({ ...prev, running: false, error: event.error ?? prev.error });
    case "startup-timeout":
      return withLabel({ ...prev, running: false, error: `Hub did not start within ${Math.round(event.timeoutMs / 1000)}s` });
    case "exit": {
      const detail =
        event.code != null || event.signal
          ? `Hub process exited (${event.signal ? `signal ${event.signal}` : `code ${event.code}`})`
          : "Hub process exited";
      return withLabel({
        ...prev,
        running: false,
        liveState: null,
        phase: "restarting",
        restarting: true,
        restartAttempt: event.attempt,
        restartInMs: event.delayMs,
        error: prev.error && event.keepError ? prev.error : detail,
      });
    }
    case "stopped":
      return withLabel({ ...prev, phase: "stopped", running: false, restarting: false, restartInMs: null });
    default:
      return prev;
  }
}

/**
 * @param {object} opts
 * @param {(handlers: { onMessage: (m: any) => void, onExit: (code: number | null, signal: string | null) => void }) => { kill: () => void, send?: (m: object) => void }} opts.spawn
 *        Start one Hub child. Real impl: child_process.fork; tests: a fake.
 * @param {(status: object) => void} opts.onStatus
 * @param {(fn: () => void, ms: number) => unknown} [opts.setTimer]
 * @param {(handle: unknown) => void} [opts.clearTimer]
 * @param {() => number} [opts.now]
 */
export function createSupervisor(opts) {
  const {
    spawn,
    onStatus,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h),
    now = () => Date.now(),
  } = opts;
  const cfg = { ...DEFAULTS, ...opts };

  let status = initialStatus();
  let child = null;
  /** Bumped per spawn so late events from an old child are ignored. */
  let generation = 0;
  let failures = 0;
  let readyAt = null;
  let startupTimer = null;
  let restartTimer = null;
  let stopped = false;

  function emit(event) {
    status = reduceStatus(status, event);
    onStatus(status);
  }

  function clearStartup() {
    if (startupTimer != null) clearTimer(startupTimer);
    startupTimer = null;
  }

  function start() {
    if (stopped) return;
    restartTimer = null;
    const gen = ++generation;
    readyAt = null;
    emit({ type: "spawned" });
    startupTimer = setTimer(() => {
      if (gen !== generation) return;
      emit({ type: "startup-timeout", timeoutMs: cfg.startupTimeoutMs });
      // Killing triggers onExit → restart path. Mark the error as the cause to keep.
      keepNextError = true;
      child?.kill();
    }, cfg.startupTimeoutMs);
    child = spawn({
      onMessage: (m) => {
        if (gen !== generation || !m || typeof m !== "object") return;
        if (m.type === "ready") {
          clearStartup();
          readyAt = now();
          emit({ type: "ready", status: m.status });
        } else if (m.type === "live") {
          emit({ type: "live", liveState: m.liveState, error: m.error ?? null, tailscaleHint: m.tailscaleHint, meshHint: m.meshHint });
        } else if (m.type === "fatal") {
          emit({ type: "fatal", error: m.error });
          keepNextError = true;
        }
      },
      onExit: (code, signal) => {
        if (gen !== generation) return;
        handleExit(code, signal);
      },
    });
  }

  let keepNextError = false;

  function handleExit(code, signal) {
    clearStartup();
    child = null;
    if (stopped) return;
    if (readyAt != null && now() - readyAt >= cfg.stableAfterMs) failures = 0;
    failures += 1;
    const delayMs = backoffDelay(failures, cfg);
    emit({ type: "exit", code, signal, attempt: failures, delayMs, keepError: keepNextError });
    keepNextError = false;
    restartTimer = setTimer(start, delayMs);
  }

  return {
    start,
    /** Operator asked to restart now (skips the backoff wait). */
    restartNow() {
      if (stopped) return;
      if (restartTimer != null) {
        clearTimer(restartTimer);
        restartTimer = null;
        start();
      } else if (child) {
        child.kill();
      }
    },
    /** Ask the running child to re-probe CDP now (no-op while restarting). */
    requestRefresh() {
      child?.send?.({ type: "refresh" });
    },
    stop() {
      stopped = true;
      generation += 1;
      clearStartup();
      if (restartTimer != null) clearTimer(restartTimer);
      restartTimer = null;
      child?.kill();
      child = null;
      emit({ type: "stopped" });
    },
    getStatus: () => status,
  };
}
