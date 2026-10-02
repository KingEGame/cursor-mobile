import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { HubContext } from "./config.js";

export type WsOutbound =
  | {
      type: "server.hello";
      connectionId: string;
      serverTime: string;
      apiVersion: number;
    }
  | { type: "pong"; ts: number }
  | {
      type: "health.changed";
      liveAdapter?: {
        state: string;
        selectorPack: string | null;
        extractorReady: boolean;
      };
      cdp?: { status: string };
      cursor?: { status: string; windowsDetected: number };
    }
  | {
      type: "session.updated";
      sessionId?: string;
      session: Record<string, unknown>;
    }
  | {
      type: "session.message.failed";
      sessionId: string;
      error: { code: string; message: string };
    }
  | {
      type: "session.approval.requested";
      approvalId: string;
      sessionId: string;
      /** Prefer object shape for mobile PendingApproval.tool */
      tool: string | { name: string; server?: string | null; kind?: string | null };
      summary: string;
      argsPreview?: string;
      createdAt: string;
      expiresAt?: string | null;
      synthetic?: boolean;
    }
  | {
      type: "session.approval.resolved";
      approvalId: string;
      sessionId: string;
      decision: "approve" | "deny";
      status: string;
    }
  | {
      type: "error";
      code: string;
      message: string;
      sessionId?: string;
    };

interface ClientState {
  connectionId: string;
  deviceId: string | null;
  subscriptions: {
    workspace: boolean;
    health: boolean;
    sessions: Set<string>;
  };
  ws: WebSocket;
}

export class HubWsHub {
  private readonly wss: WebSocketServer;
  private readonly clients = new Map<WebSocket, ClientState>();

  constructor(private readonly ctx: HubContext) {
    this.wss = new WebSocketServer({ noServer: true });
  }

  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const url = new URL(req.url ?? "/", "http://hub.local");
    const path = url.pathname;
    if (path !== "/ws" && path !== "/v1/ws") {
      socket.destroy();
      return;
    }

    const token = extractToken(req, url);
    if (this.ctx.config.pairingRequired) {
      if (!token) {
        socket.write(
          "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n",
        );
        socket.destroy();
        return;
      }
      const device = this.ctx.pairing.authenticate(token);
      if (!device) {
        socket.write(
          "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n",
        );
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.onConnection(ws, device.deviceId);
      });
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.onConnection(ws, null);
    });
  }

  broadcast(event: WsOutbound): void {
    const raw = JSON.stringify(event);
    for (const client of this.clients.values()) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      if (event.type === "health.changed" && !client.subscriptions.health) {
        continue;
      }
      if (
        event.type === "session.updated" ||
        event.type === "session.message.failed" ||
        event.type === "session.approval.requested" ||
        event.type === "session.approval.resolved"
      ) {
        const sid = resolveEventSessionId(event);
        // Empty sessions set = all sessions; non-empty = filter to subscribed ids.
        if (
          sid &&
          client.subscriptions.sessions.size > 0 &&
          !client.subscriptions.sessions.has(sid)
        ) {
          continue;
        }
      }
      client.ws.send(raw);
    }
  }

  clientCount(): number {
    return this.clients.size;
  }

  private onConnection(ws: WebSocket, deviceId: string | null): void {
    const connectionId = `conn_${randomBytes(8).toString("hex")}`;
    const state: ClientState = {
      connectionId,
      deviceId,
      subscriptions: {
        workspace: false,
        health: false,
        sessions: new Set(),
      },
      ws,
    };
    this.clients.set(ws, state);

    ws.on("message", (data) => {
      void this.onMessage(state, data.toString());
    });
    ws.on("close", () => {
      this.clients.delete(ws);
    });
    ws.on("error", () => {
      this.clients.delete(ws);
    });
  }

  private async onMessage(state: ClientState, raw: string): Promise<void> {
    let msg: { type?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(raw) as { type?: string; [k: string]: unknown };
    } catch {
      this.send(state, {
        type: "error",
        code: "WS_BAD_JSON",
        message: "Invalid JSON frame",
      });
      return;
    }

    switch (msg.type) {
      case "client.hello": {
        const subs = (msg.subscriptions ?? {}) as {
          workspace?: boolean;
          health?: boolean;
          sessions?: string[];
        };
        state.subscriptions.workspace = Boolean(subs.workspace);
        state.subscriptions.health = Boolean(subs.health);
        if (Array.isArray(subs.sessions)) {
          for (const id of subs.sessions) {
            if (typeof id === "string") state.subscriptions.sessions.add(id);
          }
        }
        this.send(state, {
          type: "server.hello",
          connectionId: state.connectionId,
          serverTime: new Date().toISOString(),
          apiVersion: 1,
        });
        if (state.subscriptions.health) {
          const health = await this.ctx.live.getHealth();
          this.send(state, healthChangedFromLive(health));
        }
        return;
      }
      case "client.subscribe": {
        if (msg.health === true) state.subscriptions.health = true;
        if (msg.workspace === true) state.subscriptions.workspace = true;
        if (Array.isArray(msg.sessions)) {
          for (const id of msg.sessions) {
            if (typeof id === "string") state.subscriptions.sessions.add(id);
          }
        }
        return;
      }
      case "client.unsubscribe": {
        if (Array.isArray(msg.sessions)) {
          for (const id of msg.sessions) {
            if (typeof id === "string") state.subscriptions.sessions.delete(id);
          }
        }
        return;
      }
      case "ping": {
        this.send(state, {
          type: "pong",
          ts: typeof msg.ts === "number" ? msg.ts : Date.now(),
        });
        return;
      }
      case undefined:
      default:
        this.send(state, {
          type: "error",
          code: "WS_UNKNOWN_TYPE",
          message: `Unknown event type: ${String(msg.type)}`,
        });
    }
  }

  private send(state: ClientState, event: WsOutbound): void {
    if (state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(event));
    }
  }
}

function extractToken(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim();
  }
  const q = url.searchParams.get("access_token");
  return q && q.length > 0 ? q : null;
}

/** Session id from top-level sessionId or nested session.id (session.updated). */
function resolveEventSessionId(event: WsOutbound): string {
  if ("sessionId" in event && event.sessionId) {
    return String(event.sessionId);
  }
  if (event.type === "session.updated") {
    const id = event.session?.id;
    return typeof id === "string" ? id : "";
  }
  return "";
}

/** Build health.changed payload from live adapter health (WS hello + poller). */
export function healthChangedFromLive(health: {
  state: string;
  selectorPack: string | null;
  extractorReady: boolean;
  probe: {
    status: string;
    cursor: { status: string; windowsDetected: number };
  };
}): Extract<WsOutbound, { type: "health.changed" }> {
  return {
    type: "health.changed",
    liveAdapter: {
      state: health.state,
      selectorPack: health.selectorPack,
      extractorReady: health.extractorReady,
    },
    cdp: { status: health.probe.status },
    cursor: {
      status: health.probe.cursor.status,
      windowsDetected: health.probe.cursor.windowsDetected,
    },
  };
}
