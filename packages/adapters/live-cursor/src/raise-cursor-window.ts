/**
 * Ensure the Cursor IDE window can receive CDP Input (clicks / typing).
 *
 * Electron CDP on Cursor does not expose Browser.setWindowBounds, so a
 * minimized/hidden window silently drops sends. We:
 *   1. Target.activateTarget + Page.bringToFront (focus when already mapped),
 *   2. X11 EWMH raise via scripts/raise-cursor-x11.py (unminimize + activate),
 *   3. re-check document.visibilityState — fail closed with a clear error.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CdpClient } from "./cdp-client.js";

export type RaiseResult =
  | { ok: true; methods: string[]; visibility: string }
  | { ok: false; code: "CURSOR_WINDOW_HIDDEN"; error: string; methods: string[] };

async function pageVisibility(
  client: CdpClient,
  methods: string[],
): Promise<{ hidden: boolean; visibility: string; hasFocus: boolean } | null> {
  methods.push("Runtime.evaluate");
  const res = await client.send<{
    result?: { value?: { hidden?: boolean; visibility?: string; hasFocus?: boolean } };
    exceptionDetails?: unknown;
  }>("Runtime.evaluate", {
    expression: `({ hidden: document.hidden, visibility: document.visibilityState, hasFocus: document.hasFocus() })`,
    returnByValue: true,
  });
  if (res.exceptionDetails || !res.result?.value) return null;
  return {
    hidden: Boolean(res.result.value.hidden),
    visibility: String(res.result.value.visibility ?? "unknown"),
    hasFocus: Boolean(res.result.value.hasFocus),
  };
}

/** Resolve packaged / source path for the X11 helper. */
export function raiseCursorX11ScriptPath(
  fromUrl: string = import.meta.url,
): string | null {
  const here = dirname(fileURLToPath(fromUrl));
  const candidates = [
    // Running from dist/
    join(here, "..", "scripts", "raise-cursor-x11.py"),
    // Running from src/ during tests
    join(here, "..", "..", "scripts", "raise-cursor-x11.py"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Best-effort OS raise for X11. No-op on Wayland / missing DISPLAY / missing script.
 * Never throws — returns whether a helper reported success.
 */
export function raiseCursorWindowOs(env: NodeJS.ProcessEnv = process.env): {
  attempted: boolean;
  ok: boolean;
  detail: string;
} {
  if (!env.DISPLAY) {
    return { attempted: false, ok: false, detail: "no DISPLAY" };
  }
  const script = raiseCursorX11ScriptPath();
  if (!script) {
    return { attempted: false, ok: false, detail: "raise-cursor-x11.py not found" };
  }
  const run = spawnSync("python3", [script], {
    env: { ...env },
    encoding: "utf8",
    timeout: 5_000,
  });
  const detail = `${(run.stdout || "").trim()} ${(run.stderr || "").trim()}`.trim();
  return {
    attempted: true,
    ok: run.status === 0,
    detail: detail || `exit ${run.status ?? "null"}`,
  };
}

/**
 * Focus / unminimize Cursor so the next CDP click+type can land.
 * Call at the start of every Agents send / new-chat / edit path.
 */
export async function ensureCursorWindowRaised(
  client: CdpClient,
  opts: { targetId?: string | null; skipOs?: boolean } = {},
): Promise<RaiseResult> {
  const methods: string[] = [];

  if (opts.targetId) {
    try {
      methods.push("Target.activateTarget");
      await client.send("Target.activateTarget", { targetId: opts.targetId });
    } catch {
      /* optional */
    }
  }
  try {
    methods.push("Page.bringToFront");
    await client.send("Page.bringToFront", {});
  } catch {
    /* optional on some Electron builds */
  }

  const isShown = (v: Awaited<ReturnType<typeof pageVisibility>>) =>
    Boolean(v && !v.hidden && v.visibility === "visible");
  const isHidden = (v: Awaited<ReturnType<typeof pageVisibility>>) =>
    Boolean(v && (v.hidden || v.visibility === "hidden"));

  let vis = await pageVisibility(client, methods);
  if (isShown(vis)) {
    return { ok: true, methods, visibility: vis!.visibility };
  }

  // Always try OS raise when we cannot prove the window is shown (hidden or unknown).
  if (!opts.skipOs) {
    const os = raiseCursorWindowOs();
    methods.push(`os.raise:${os.ok ? "ok" : "skip"}`);
    // Give the WM a beat to map the window before re-checking.
    await new Promise((r) => setTimeout(r, 250));
    try {
      methods.push("Page.bringToFront");
      await client.send("Page.bringToFront", {});
    } catch {
      /* ignore */
    }
    vis = await pageVisibility(client, methods);
    if (isShown(vis)) {
      return { ok: true, methods, visibility: vis!.visibility };
    }
  }

  // Fail closed only when CDP reports hidden — unknown visibility must not block sends
  // (mocks / older Electron builds may not answer document.visibilityState).
  if (!isHidden(vis)) {
    return { ok: true, methods, visibility: vis?.visibility ?? "unknown" };
  }

  return {
    ok: false,
    code: "CURSOR_WINDOW_HIDDEN",
    error:
      `Cursor on the PC is minimized or not visible (visibility=${vis?.visibility}, hidden=${vis?.hidden}). ` +
      "Restore / unminimize the Cursor window on the PC, then retry — CDP cannot type into a hidden window.",
    methods,
  };
}
