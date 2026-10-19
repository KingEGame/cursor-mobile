/**
 * "Why can't my phone reach this PC?" — a handful of cheap checks with plain-language advice.
 * Everything is injected (fetch, platform) so it can be tested without a network.
 */

/** @returns {Promise<{id:string, ok:boolean|null, title:string, detail:string}[]>} */
export async function runDiagnostics({ status, platform, fetchImpl = fetch, timeoutMs = 3000 }) {
  const checks = [];
  const add = (id, ok, title, detail) => checks.push({ id, ok, title, detail });
  const port = /:(\d+)/.exec(String(status.listenUrl ?? ""))?.[1] ?? "8787";

  add(
    "hub",
    Boolean(status.running),
    "Hub is running",
    status.running ? `Listening on ${status.listenUrl}` : `Hub state: ${status.stateLabel || "stopped"}. Open the log for the cause.`,
  );

  const ts = status.tailscaleHint;
  add(
    "tailscale",
    Boolean(ts),
    "Tailscale address found",
    ts ? `This PC is ${ts} on the mesh.` : "No 100.x.y.z address: start Tailscale on this PC and sign in to the same account as the phone.",
  );

  if (ts && status.running) {
    const url = `http://${ts}:${port}/v1/health`;
    let ok = false;
    let detail;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      ok = res.ok;
      detail = ok ? `${url} answers.` : `${url} returned HTTP ${res.status}.`;
    } catch (err) {
      detail = `${url} did not answer (${err instanceof Error ? err.message : err}).`;
      if (platform === "win32") detail += " On Windows this is usually the firewall: press “Allow phone access”.";
      else if (platform === "linux") detail += ` Check the firewall allows TCP ${port} on the tailscale0 interface.`;
    }
    add("reachable", ok, "Hub reachable on the Tailscale address", detail);
  }

  add(
    "cdp",
    status.liveState === "cdp_ok" ? true : status.liveState ? null : null,
    "Cursor connection (CDP)",
    status.liveState === "cdp_ok"
      ? "Cursor is reachable on this PC."
      : "Cursor is not in remote-debug mode. Chat history works; sending needs Cursor started with CDP.",
  );
  return checks;
}
