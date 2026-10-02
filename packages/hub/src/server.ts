import { createServer, type Server } from "node:http";
import type { Express } from "express";
import type { HubContext } from "./config.js";
import { createApp } from "./app.js";
import { healthChangedFromLive, HubWsHub } from "./ws.js";
import { drainSessionCreateQueueForCtx } from "./routes/api.js";

export interface HubServer {
  app: Express;
  server: Server;
  ws: HubWsHub;
  listen: () => Promise<void>;
  close: () => Promise<void>;
}

/** Poll interval for CDP recovery drain + health.changed fan-out (ms). */
export const HUB_LIVE_POLL_MS = 5_000;

function resolveLivePollMs(): number {
  const raw = process.env.HUB_LIVE_POLL_MS?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 20) return n;
  }
  return HUB_LIVE_POLL_MS;
}

/**
 * Create Hub HTTP + WebSocket server (TOR-03 /v1/ws).
 * CDP remains on loopback via the live adapter — never forwarded here.
 */
export function createHubServer(ctx: HubContext): HubServer {
  const app = createApp(ctx);
  const server = createServer(app);
  const ws = new HubWsHub(ctx);
  ctx.ws = ws;

  server.on("upgrade", (req, socket, head) => {
    ws.handleUpgrade(req, socket, head);
  });

  let drainTimer: ReturnType<typeof setInterval> | null = null;
  /** Last liveAdapter.state seen by the poller — used to push health.changed. */
  let lastHealthState: string | null = null;

  return {
    app,
    server,
    ws,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(ctx.config.hubPort, ctx.config.hubHost, () => {
          server.off("error", reject);
          // Poll CDP recovery — drain New-session queue + push health.changed
          // so the phone learns cdp_ok ↔ cursor_down without waiting for hello.
          drainTimer = setInterval(() => {
            void (async () => {
              try {
                const health = await ctx.live.getHealth();
                if (
                  lastHealthState !== null &&
                  lastHealthState !== health.state
                ) {
                  ctx.ws?.broadcast(healthChangedFromLive(health));
                }
                lastHealthState = health.state;

                if (ctx.sessionCreateQueue.pendingCount() === 0) return;
                if (health.state !== "cdp_ok") return;
                await drainSessionCreateQueueForCtx(ctx);
              } catch (err) {
                console.warn("[hub] live poller failed", err);
              }
            })();
          }, resolveLivePollMs());
          if (typeof drainTimer.unref === "function") {
            drainTimer.unref();
          }
          resolve();
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        if (drainTimer) {
          clearInterval(drainTimer);
          drainTimer = null;
        }
        lastHealthState = null;
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
