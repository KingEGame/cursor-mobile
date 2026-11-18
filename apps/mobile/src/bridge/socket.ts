/**
 * Reconnecting WebSocket to the phone bridge. On every (re)connect it sends `client.hello`
 * with the last message id it has seen, the auth token, and the Gateway replays what was missed.
 *
 * T16: token is sent in the first frame (client.hello), not in the URL.
 */
import { wsUrl } from './client';
import type { WsServerEvent } from './types';

export type SocketState = 'idle' | 'connecting' | 'open' | 'closed';

export interface BridgeSocketOptions {
  baseUrl: string;
  token: string;
  /** Last message id applied locally; 0 = nothing yet (no replay requested). */
  getSince: () => number;
  onEvent: (ev: WsServerEvent) => void;
  /** T16: called when the server rotates the token (returns new token). */
  onTokenRotated?: (newToken: string) => void;
  onState?: (state: SocketState) => void;
  WebSocketImpl?: typeof WebSocket;
  pingMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
}

export function helloFrame(since: number, token?: string): Record<string, unknown> {
  // since=0 would make the Gateway replay the OLDEST messages; history comes from REST instead.
  const frame: Record<string, unknown> = since > 0 ? { type: 'client.hello', sessions: [], since } : { type: 'client.hello', sessions: [] };
  // T16: token goes in the first frame, not in the URL
  if (token) frame.token = token;
  return frame;
}

export class BridgeSocket {
  private ws: WebSocket | null = null;
  private state: SocketState = 'idle';
  private stopped = true;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: BridgeSocketOptions) {}

  getState(): SocketState {
    return this.state;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.detach();
    this.setState('closed');
  }

  /** App came to foreground / network changed: skip the backoff wait. */
  kick(): void {
    if (this.stopped || this.state === 'open' || this.state === 'connecting') return;
    this.attempt = 0;
    this.open();
  }

  private open(): void {
    this.clearTimers();
    this.detach();
    this.setState('connecting');
    const WS = this.opts.WebSocketImpl ?? WebSocket;
    let ws: WebSocket;
    try {
      // T16: token not in URL — use wsUrl without token
      ws = new WS(wsUrl(this.opts.baseUrl));
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.setState('open');
      // T16: send token in the hello frame
      ws.send(JSON.stringify(helloFrame(this.opts.getSince(), this.opts.token)));
      this.pingTimer = setInterval(() => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      }, this.opts.pingMs ?? 25_000);
    };
    ws.onmessage = (ev) => {
      let data: WsServerEvent;
      try {
        data = JSON.parse(String(ev.data)) as WsServerEvent;
      } catch {
        return;
      }
      this.opts.onEvent(data);
      // T16: token rotation — save new token sent by the server
      if (data.type === 'server.hello' && data.token && this.opts.onTokenRotated) {
        this.opts.onTokenRotated(data.token);
      }
    };
    ws.onerror = () => {
      /* onclose follows and handles the retry */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.setState('closed');
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const min = this.opts.backoffMinMs ?? 1_000;
    const max = this.opts.backoffMaxMs ?? 20_000;
    const delay = Math.min(max, min * 2 ** this.attempt);
    this.attempt += 1;
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  private detach(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.retryTimer = null;
    this.pingTimer = null;
  }

  private setState(s: SocketState): void {
    if (this.state === s) return;
    this.state = s;
    this.opts.onState?.(s);
  }
}
