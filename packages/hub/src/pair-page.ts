/**
 * PC-only pairing page (UI-SPEC Amendment D): http://127.0.0.1:8787/pair shows a fresh
 * pairing QR for the phone's camera. Loopback-only like POST /v1/pair/start — a phone on
 * the mesh can never mint its own pairing code.
 */

import { Router } from "express";
import QRCode from "qrcode";
import { buildQrPayload, type HubContext } from "./config.js";
import { requireLocal } from "./local-guard.js";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
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
      const host = (() => {
        try {
          return new URL(payload.replace("cursor-companion://", "http://")).searchParams.get("host") ?? "";
        } catch {
          return "";
        }
      })();
      res.setHeader("Cache-Control", "no-store");
      res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair phone · ${escapeHtml(ctx.config.hubDisplayName)}</title>
<style>
  :root { color-scheme: light; font-family: system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f5f7; color: #1a1c1e; }
  main { background: #fff; border: 1px solid #e2e5ea; border-radius: 16px; padding: 32px; width: min(400px, 92vw); text-align: center; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  .hero { background: #eef0f3; border-radius: 12px; padding: 12px 14px; margin: 0 0 16px; text-align: left; }
  .hero strong { display: block; color: #1a1c1e; margin-bottom: 4px; }
  p { color: #5f6368; margin: 6px 0; line-height: 1.45; font-size: 14px; }
  .qr svg { width: 280px; height: 280px; } .code { font: 600 28px ui-monospace, monospace; letter-spacing: 4px; margin: 8px 0; }
  .state { font-weight: 600; margin-top: 12px; } .ok { color: #1e6b4a; } .bad { color: #b3261e; }
  a { color: #1e6b4a; }
  .url { font: 500 13px ui-monospace, monospace; word-break: break-all; }
</style></head><body><main>
  <h1>Pair your phone</h1>
  <div class="hero" role="note">
    <strong>You are on the PC — keep this page open here</strong>
    <p style="margin:0">Do <b>not</b> type <span class="url">http://127.0.0.1:${escapeHtml(String(ctx.config.hubPort))}/pair</span> on the phone. On the phone open <b>Cursor Mobile → Scan QR</b> and aim at the code below. Both devices need Tailscale Online.</p>
  </div>
  <div class="qr" aria-label="Pairing QR code">${svg}</div>
  <p>Or type this code on the phone (manual fallback)</p>
  <div class="code">${escapeHtml(pending.code)}</div>
  <p>Phone reaches Hub at ${escapeHtml(host)} · expires in <span id="left"></span></p>
  <div class="state" id="state">Waiting for the phone…</div>
  <p><a href="/pair">New code</a></p>
</main>
<script>
  const expires = ${JSON.stringify(pending.expiresAt.toISOString())};
  const state = document.getElementById("state"), left = document.getElementById("left");
  const tick = () => { const s = Math.max(0, Math.round((Date.parse(expires) - Date.now()) / 1000));
    left.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  tick(); setInterval(tick, 1000);
  const poll = async () => {
    const r = await fetch("/pair/status?pairId=${encodeURIComponent(pending.pairId)}", { cache: "no-store" });
    const { status } = await r.json();
    if (status === "paired") { state.textContent = "Phone paired ✓ — you can close this page"; state.className = "state ok"; return; }
    if (status === "expired") { state.textContent = "Code expired — get a new code"; state.className = "state bad"; return; }
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
