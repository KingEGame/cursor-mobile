/**
 * Hub WebSocket client (TOR-03 `GET /v1/ws`).
 * Tolerates missing Hub WS — callers get onError / onClose without crashing UI.
 * Reconnects with exponential backoff after mesh flaps (phone never dials CDP).
 */

export type HubWsConnectionState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export interface HubWsSubscriptions {
  workspace?: boolean;
  health?: boolean;
  sessions?: string[];
}

export type HubWsServerEvent = {
  type: string;
  [key: string]: unknown;
};

export interface HubWsOptions {
  baseUrl: string;
  deviceToken: string;
  subscriptions?: HubWsSubscriptions;
  /** Inject WebSocket for tests */
  WebSocketImpl?: typeof WebSocket;
  onEvent?: (event: HubWsServerEvent) => void;
  onState?: (state: HubWsConnectionState, detail?: string) => void;
  pingIntervalMs?: number;
  /**
   * Auto-reconnect after unexpected close/error (default true).
   * Disabled when `close()` is called intentionally.
   */
  reconnect?: boolean;
  /** Initial reconnect delay ms (default 1000). */
  reconnectInitialMs?: number;
  /** Cap reconnect delay ms (default 30000). */
  reconnectMaxMs?: number;
}

function toWsUrl(httpBase: string): string {
  const trimmed = httpBase.trim().replace(/\/+$/, '');
  if (trimmed.startsWith('https://')) {
    return `${trimmed.replace(/^https/, 'wss')}/v1/ws`;
  }
  if (trimmed.startsWith('http://')) {
    return `${trimmed.replace(/^http/, 'ws')}/v1/ws`;
  }
  return `ws://${trimmed}/v1/ws`;
}

export function buildWsUrl(baseUrl: string, deviceToken?: string | null): string {
  const url = toWsUrl(baseUrl);
  if (!deviceToken) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}access_token=${encodeURIComponent(deviceToken)}`;
}

export class HubWebSocket {
  private socket: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly opts: HubWsOptions;
  private state: HubWsConnectionState = 'idle';
  private intentionalClose = false;
  private reconnectAttempt = 0;
  private readonly sessionSubs = new Set<string>();

  constructor(opts: HubWsOptions) {
    this.opts = opts;
    for (const id of opts.subscriptions?.sessions ?? []) {
      this.sessionSubs.add(id);
    }
  }

  getState(): HubWsConnectionState {
    return this.state;
  }

  connect(): void {
    this.intentionalClose = false;
    this.clearReconnectTimer();
    this.openSocket();
  }

  subscribeSessions(sessionIds: string[]): void {
    for (const id of sessionIds) this.sessionSubs.add(id);
    this.send({ type: 'client.subscribe', sessions: sessionIds });
  }

  send(payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }

  close(): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.stopPing();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // ignore
      }
      this.socket = null;
    }
    if (this.state !== 'idle') {
      this.setState('closed');
    }
  }

  private openSocket(): void {
    this.stopPing();
    if (this.socket) {
      try {
        this.socket.onopen = null;
        this.socket.onmessage = null;
        this.socket.onerror = null;
        this.socket.onclose = null;
        this.socket.close();
      } catch {
        // ignore
      }
      this.socket = null;
    }

    this.setState('connecting');
    const WS = this.opts.WebSocketImpl ?? WebSocket;
    const url = buildWsUrl(this.opts.baseUrl, this.opts.deviceToken);

    try {
      this.socket = new WS(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'WS construct failed';
      this.setState('error', msg);
      this.scheduleReconnect();
      return;
    }

    this.socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.setState('open');
      this.send({
        type: 'client.hello',
        apiVersion: 1,
        subscriptions: {
          workspace: this.opts.subscriptions?.workspace ?? true,
          health: this.opts.subscriptions?.health ?? true,
          sessions: [...this.sessionSubs],
        },
      });
      this.startPing();
    };

    this.socket.onmessage = (ev) => {
      try {
        const data = JSON.parse(String(ev.data)) as HubWsServerEvent;
        this.opts.onEvent?.(data);
      } catch {
        // ignore non-JSON frames
      }
    };

    this.socket.onerror = () => {
      this.setState('error', 'WebSocket error — Hub /v1/ws may be unavailable');
    };

    this.socket.onclose = () => {
      this.stopPing();
      this.socket = null;
      if (this.intentionalClose) {
        if (this.state !== 'error') {
          this.setState('closed');
        }
        return;
      }
      if (this.state !== 'error') {
        this.setState('closed');
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    if (this.opts.reconnect === false) return;
    this.clearReconnectTimer();
    const initial = this.opts.reconnectInitialMs ?? 1_000;
    const max = this.opts.reconnectMaxMs ?? 30_000;
    const delay = Math.min(max, initial * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.intentionalClose) return;
      this.openSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startPing(): void {
    this.stopPing();
    const ms = this.opts.pingIntervalMs ?? 25_000;
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping', ts: Date.now() });
    }, ms);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private setState(state: HubWsConnectionState, detail?: string): void {
    this.state = state;
    this.opts.onState?.(state, detail);
  }
}
