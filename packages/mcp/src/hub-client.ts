/**
 * Talks to the local Hub over loopback only. Pairs itself once as a device named
 * "Claude (MCP)" (POST /v1/pair/start is loopback-only on the Hub) and keeps the
 * token in a 0600 file — revocable like any phone.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const MCP_DEVICE_NAME = "Claude (MCP)";
export const MCP_VERSION = "0.1.0";

export class HubError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface TokenStore {
  load(): string | null;
  save(token: string): void;
}

export function defaultTokenFile(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.CURSOR_MOBILE_MCP_TOKEN_FILE ||
    join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cursor-mobile", "mcp-device.json")
  );
}

export function fileTokenStore(path: string): TokenStore {
  return {
    load() {
      if (!existsSync(path)) return null;
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as { deviceToken?: unknown };
        return typeof parsed.deviceToken === "string" && parsed.deviceToken ? parsed.deviceToken : null;
      } catch {
        return null;
      }
    },
    save(token) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, JSON.stringify({ deviceToken: token }) + "\n", { mode: 0o600 });
      chmodSync(path, 0o600);
    },
  };
}

export function memoryTokenStore(initial: string | null = null): TokenStore {
  let token = initial;
  return { load: () => token, save: (t) => void (token = t) };
}

/** Only a Hub on this PC: the MCP server never reaches across the mesh. */
export function assertLoopbackUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`HUB_URL is not a URL: ${raw}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(`HUB_URL must be the local Hub (http://127.0.0.1:<port>), got ${raw}`);
  }
  return url.origin;
}

export interface HubClientOptions {
  baseUrl: string;
  tokens: TokenStore;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class HubClient {
  readonly baseUrl: string;
  private readonly tokens: TokenStore;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  /** One pairing at a time: parallel tool calls share it instead of creating extra devices. */
  private pairing: Promise<string> | null = null;

  constructor(opts: HubClientOptions) {
    this.baseUrl = assertLoopbackUrl(opts.baseUrl);
    this.tokens = opts.tokens;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    // Sends wait for Cursor to confirm (menus, model switch) — allow a long round trip.
    this.timeoutMs = opts.timeoutMs ?? 90_000;
  }

  /** Authenticated JSON call; re-pairs once if the Hub forgot or revoked the token. */
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let token = this.tokens.load() ?? (await this.pair());
    let res = await this.raw(method, path, body, token);
    if (res.status === 401) {
      // Another call may already have re-paired; only pair again if the token is unchanged.
      const current = this.tokens.load();
      token = current && current !== token ? current : await this.pair();
      res = await this.raw(method, path, body, token);
    }
    return this.parse<T>(res);
  }

  async health(): Promise<unknown> {
    return this.parse(await this.raw("GET", "/v1/health"));
  }

  pair(): Promise<string> {
    this.pairing ??= this.pairOnce().finally(() => {
      this.pairing = null;
    });
    return this.pairing;
  }

  private async pairOnce(): Promise<string> {
    const start = await this.parse<{ code: string; pairId: string }>(
      await this.raw("POST", "/v1/pair/start", { label: MCP_DEVICE_NAME }),
    );
    const done = await this.parse<{ deviceToken: string }>(
      await this.raw("POST", "/v1/pair/complete", {
        code: start.code,
        pairId: start.pairId,
        deviceName: MCP_DEVICE_NAME,
        // The Hub's pairing contract only knows one client platform today.
        platform: "android",
        appVersion: `mcp-${MCP_VERSION}`,
      }),
    );
    this.tokens.save(done.deviceToken);
    return done.deviceToken;
  }

  private async raw(method: string, path: string, body?: unknown, token?: string): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new HubError(0, "HUB_UNREACHABLE", `Hub at ${this.baseUrl} is not reachable (${why}). Is cursor-mobile-hub running?`);
    }
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      const e = (json as { error?: { code?: string; message?: string } } | null)?.error;
      throw new HubError(res.status, e?.code ?? `HTTP_${res.status}`, e?.message ?? (text.slice(0, 300) || res.statusText));
    }
    return json as T;
  }
}
