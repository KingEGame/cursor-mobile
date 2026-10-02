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
  main { background: #fff; border: 1px solid #e2e5ea; border-radius: 16px; padding: 32px; width: 360px; text-align: center; }
  h1 { font-size: 20px; margin: 0 0 4px; } p { color: #5f6368; margin: 6px 0; line-height: 1.4; }
  .qr svg { width: 280px; height: 280px; } .code { font: 600 28px ui-monospace, monospace; letter-spacing: 4px; margin: 8px 0; }
  .state { font-weight: 600; margin-top: 12px; } .ok { color: #1e6b4a; } .bad { color: #b3261e; }
  a { color: #1e6b4a; }
</style></head><body><main>
  <h1>Pair your phone</h1>
  <p>On the phone: <b>Cursor Mobile → Scan QR</b>. Phone and PC must both be on Tailscale.</p>
  <div class="qr" aria-label="Pairing QR code">${svg}</div>
  <p>Or type this code in the app</p>
  <div class="code">${escapeHtml(pending.code)}</div>
  <p>Hub address ${escapeHtml(host)} · expires in <span id="left"></span></p>
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
