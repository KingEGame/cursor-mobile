/**
 * Minimal CDP WebSocket client (loopback only).
 * Phone never dials CDP — Hub/adapter only, via 127.0.0.1 / localhost / ::1.
 */

import { assertLoopbackCdpUrl } from "./loopback.js";

export interface CdpClient {
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
  close(): Promise<void>;
}

export type CdpClientFactory = (
  webSocketDebuggerUrl: string,
) => Promise<CdpClient>;

/** Ensure debugger WS stays on loopback (product lock). */
export function assertLoopbackDebuggerUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid CDP debugger URL: ${url}`);
  }
  const host = parsed.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(
      `CDP debugger URL must be loopback only (got host "${host}")`,
    );
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`CDP debugger URL must be ws/wss (got ${parsed.protocol})`);
  }
  return url;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * Real CDP session over WebSocket (Node 20+ global WebSocket).
 */
export class CdpWebSocketClient implements CdpClient {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.addEventListener("message", (ev) => {
      this.onMessage(String(ev.data));
    });
    this.ws.addEventListener("close", () => {
      this.failAll(new Error("CDP WebSocket closed"));
      this.closed = true;
    });
    this.ws.addEventListener("error", () => {
      this.failAll(new Error("CDP WebSocket error"));
    });
  }

  static async connect(webSocketDebuggerUrl: string): Promise<CdpWebSocketClient> {
    const url = assertLoopbackDebuggerUrl(webSocketDebuggerUrl);
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(`Failed to open CDP WebSocket: ${url}`));
      };
      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
    });
    return new CdpWebSocketClient(ws);
  }

  async send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`CDP client not open (method=${method})`);
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.ws.send(payload);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("CDP client closed"));
    this.ws.close();
  }

  private onMessage(raw: string): void {
    let msg: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
    };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      pending.reject(
        new Error(msg.error.message ?? `CDP error for id=${msg.id}`),
      );
      return;
    }
    pending.resolve(msg.result ?? {});
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      p.reject(err);
    }
    this.pending.clear();
  }
}

/** Default factory — real WS to loopback debugger URL. */
export const defaultCdpClientFactory: CdpClientFactory = (url) =>
  CdpWebSocketClient.connect(url);

/** In-memory mock for unit tests — records CDP method calls. */
export interface MockCdpCall {
  method: string;
  params: Record<string, unknown>;
}

export interface MockCdpClient extends CdpClient {
  readonly calls: MockCdpCall[];
  /** Optional per-method handlers (return CDP result payload). */
  handlers: Map<string, (params: Record<string, unknown>) => unknown>;
}

export function createMockCdpClient(
  handlers?: Record<string, (params: Record<string, unknown>) => unknown>,
): MockCdpClient {
  const calls: MockCdpCall[] = [];
  const map = new Map(Object.entries(handlers ?? {}));
  return {
    calls,
    handlers: map,
    async send<T = unknown>(
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<T> {
      calls.push({ method, params });
      const handler = map.get(method);
      if (handler) {
        return handler(params) as T;
      }
      return {} as T;
    },
    async close() {
      /* no-op */
    },
  };
}

export function createMockCdpClientFactory(
  client: CdpClient,
): CdpClientFactory {
  return async (url: string) => {
    assertLoopbackDebuggerUrl(url);
    return client;
  };
}

/** Re-export HTTP loopback assert for callers that only have an http CDP base. */
export { assertLoopbackCdpUrl };
