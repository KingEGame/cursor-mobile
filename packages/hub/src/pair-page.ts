/**
 * PC-only pairing page (UI-SPEC Amendment D): http://127.0.0.1:8787/pair shows a fresh
 * pairing QR for the phone's camera. Loopback-only like POST /v1/pair/start — a phone on
 * the mesh can never mint its own pairing code.
 *
 * The page names this PC, says which address the phone will dial, warns when no Tailscale
 * address was found (the QR would be useless), and notices when the Hub restarted underneath
 * it (the code is gone from memory, so "scan again" would fail with PAIR_CODE_INVALID).
 */

import { Router } from "express";
import QRCode from "qrcode";
import { buildQrPayload, type HubContext } from "./config.js";
import { isLoopbackAddress, requireLocal } from "./local-guard.js";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Host and port the QR tells the phone to dial. */
export function qrTarget(payload: string): { host: string; port: string } {
  try {
    const u = new URL(payload.replace("cursor-companion://", "http://"));
    return { host: u.searchParams.get("host") ?? "", port: u.searchParams.get("port") ?? "" };
  } catch {
    return { host: "", port: "" };
  }
}

export function createPairPageRouter(ctx: HubContext): Router {
  const router = Router();

  router.get("/pair", requireLocal(), async (_req, res, next) => {
    try {
      const pending = ctx.pairing.start({
        ttlSec: ctx.config.pairingCodeTtlSec,
        label: ctx.config.hubDisplayName,
      });
      const payload = buildQrPayload(ctx.config, pending);
      const svg = await QRCode.toString(payload, { type: "svg", margin: 1, width: 280 });
      const { host, port } = qrTarget(payload);
      const meshMissing = !host || isLoopbackAddress(host);
      const pc = escapeHtml(ctx.config.hubDisplayName);
      const address = escapeHtml(`${host}:${port}`);
      res.setHeader("Cache-Control", "no-store");
      res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair phone · ${pc}</title>
<style>
  :root { color-scheme: light; font-family: system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f5f7; color: #1a1c1e; }
  main { background: #fff; border: 1px solid #e2e5ea; border-radius: 16px; padding: 32px; width: min(420px, 92vw); text-align: center; box-sizing: border-box; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .pc { color: #5f6368; font-size: 14px; margin: 0 0 16px; }
  .hero { background: #eef0f3; border-radius: 12px; padding: 12px 14px; margin: 0 0 16px; text-align: left; }
  .hero strong { display: block; color: #1a1c1e; margin-bottom: 4px; }
  .warn { background: #fff4e0; color: #5c3e00; border-radius: 12px; padding: 12px 14px; margin: 0 0 16px; text-align: left; }
  .warn strong { display: block; margin-bottom: 4px; }
  p { color: #5f6368; margin: 6px 0; line-height: 1.45; font-size: 14px; }
  .qr svg { width: 280px; height: 280px; } .qr.dim { opacity: .35; }
  .manual { border: 1px dashed #c5c9d0; border-radius: 12px; padding: 12px 14px; margin: 16px 0 0; text-align: left; }
  .manual dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 8px 0 0; }
  .manual dt { color: #5f6368; font-size: 13px; } .manual dd { margin: 0; }
  .code { font: 600 28px ui-monospace, monospace; letter-spacing: 4px; }
  .url { font: 500 14px ui-monospace, monospace; word-break: break-all; }
  .state { font-weight: 600; margin-top: 12px; } .ok { color: #1e6b4a; } .bad { color: #b3261e; }
  a { color: #1e6b4a; }
  .btn { display: inline-block; margin-top: 8px; padding: 10px 18px; border-radius: 999px; background: #1e6b4a; color: #fff; text-decoration: none; font-weight: 600; }
</style></head><body><main>
  <h1>Pair your phone</h1>
  <p class="pc">with <b>${pc}</b></p>
  ${
    meshMissing
      ? `<div class="warn" role="alert"><strong>No Tailscale address found on this PC</strong>
  The QR would point the phone at ${address}, which only this PC can reach. Start Tailscale here (and sign in), wait for it to show Connected, then click <a href="/pair">New code</a>. If Tailscale is up but on an unusual interface, start the Hub with <span class="url">TAILSCALE_HOSTNAME=&lt;this PC's 100.x address&gt;</span>.</div>`
      : `<div class="hero" role="note">
    <strong>You are on the PC — keep this page open here</strong>
    <p style="margin:0">Do <b>not</b> type <span class="url">http://127.0.0.1:${escapeHtml(String(ctx.config.hubPort))}/pair</span> on the phone. On the phone open <b>Cursor Mobile → Scan QR</b> and aim at the code below. Both devices need Tailscale Online.</p>
  </div>`
  }
  <div class="qr${meshMissing ? " dim" : ""}" aria-label="Pairing QR code">${svg}</div>
  <p>Expires in <span id="left"></span></p>
  <div class="state" id="state">Waiting for the phone…</div>
  <p><a class="btn" href="/pair">New code</a></p>
  <div class="manual">
    <strong>Camera not working? Type it on the phone instead</strong>
    <p style="margin:4px 0 0">On the phone: Pair → <b>Enter code manually</b>, then type exactly:</p>
    <dl>
      <dt>PC address</dt><dd class="url" id="manual-address">${address}</dd>
      <dt>Code</dt><dd class="code" id="manual-code">${escapeHtml(pending.code)}</dd>
    </dl>
    <p>The address and code belong to <b>${pc}</b> only. A code from another PC's pair page will not work here.</p>
  </div>
</main>
<script>
  const expires = ${JSON.stringify(pending.expiresAt.toISOString())};
  const state = document.getElementById("state"), left = document.getElementById("left");
  let done = false;
  const show = (text, cls) => { state.textContent = text; state.className = "state " + (cls || ""); done = true; };
  const tick = () => {
    const s = Math.max(0, Math.round((Date.parse(expires) - Date.now()) / 1000));
    left.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    if (s === 0 && !done) show("Code expired — click New code", "bad");
  };
  tick(); setInterval(tick, 1000);
  let misses = 0;
  const poll = async () => {
    if (done) return;
    try {
      const r = await fetch("/pair/status?pairId=${encodeURIComponent(pending.pairId)}", { cache: "no-store" });
      const { status } = await r.json();
      misses = 0;
      if (status === "paired") return show("Phone paired ✓ — you can close this page", "ok");
      if (status === "expired") return show("Code expired — click New code", "bad");
      if (status === "unknown") return show("The Hub restarted, so this code is gone — click New code and scan again", "bad");
    } catch {
      // Hub stopped or is restarting: tell the operator after a few misses instead of waiting forever.
      if (++misses >= 3) { state.textContent = "Hub not responding — once it is running again, click New code"; state.className = "state bad"; }
    }
    setTimeout(poll, 2000);
  };
  poll();
</script></body></html>`);
    } catch (err) {
      next(err);
    }
  });

  router.get("/pair/status", requireLocal(), (req, res) => {
    const pairId = typeof req.query.pairId === "string" ? req.query.pairId : "";
    res.setHeader("Cache-Control", "no-store");
    res.json({ status: ctx.pairing.pendingStatus(pairId) });
  });

  return router;
}
