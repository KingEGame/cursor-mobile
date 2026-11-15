/**
 * REST client for the Hermes Gateway phone bridge. Pure (fetch is injectable) — unit-tested in Node.
 */
import type {
  Attachment,
  Health,
  Project,
  ProjectRef,
  PairRequestResponse,
  PairRequestStatus,
  MessagesPage,
  PairCompleteRequest,
  PairCompleteResponse,
  SendResponse,
  Session,
  SessionsPage,
} from './types';

export class BridgeError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
    this.code = code;
    Object.setPrototypeOf(this, BridgeError.prototype);
  }

  /** Network-level failure: PC off, Tailscale down, wrong address. */
  get unreachable(): boolean {
    return this.status === 0;
  }

  /** The device token is no longer accepted — re-pair. */
  get unauthorized(): boolean {
    return this.status === 401;
  }
}

export function isBridgeError(err: unknown): err is BridgeError {
  return err instanceof BridgeError;
}

export interface BridgeClientOptions {
  baseUrl: string;
  token?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function normalizeBaseUrl(url: string): string {
  const t = url.trim().replace(/\/+$/, '');
  if (!t) return '';
  return /^https?:\/\//i.test(t) ? t : `http://${t}`;
}

export class BridgeClient {
  readonly baseUrl: string;
  private readonly token: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  /** Uploads go through XMLHttpRequest in the app (see post()); tests keep using the injected fetch. */
  private readonly useXhr: boolean;

  constructor(opts: BridgeClientOptions) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    this.token = opts.token ?? null;
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.timeoutMs = opts.timeoutMs ?? 12_000;
    this.useXhr = !opts.fetchImpl && typeof XMLHttpRequest !== 'undefined';
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    auth = true,
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    if (!this.baseUrl) throw new BridgeError(0, 'NO_ADDRESS', 'PC address is not set');
    const headers: Record<string, string> = { Accept: 'application/json' };
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    // multipart: fetch sets the boundary itself
    if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
    if (auth) {
      if (!this.token) throw new BridgeError(401, 'NOT_PAIRED', 'This phone is not paired');
      headers.Authorization = `Bearer ${this.token}`;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      const aborted = (err as { name?: string } | null)?.name === 'AbortError';
      throw new BridgeError(
        0,
        aborted ? 'TIMEOUT' : 'UNREACHABLE',
        aborted ? `No answer from the PC in ${Math.round(timeoutMs / 1000)}s` : String(err),
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const e = (json as { error?: { code?: string; message?: string } } | null)?.error;
      throw new BridgeError(
        res.status,
        e?.code ?? (res.status === 404 ? 'NOT_FOUND' : `HTTP_${res.status}`),
        e?.message ?? (text.slice(0, 200) || res.statusText),
      );
    }
    if (json === null) throw new BridgeError(res.status, 'BAD_RESPONSE', 'PC answered with non-JSON');
    return json as T;
  }

  /** Unauthenticated; also proves the address really is a Hermes phone bridge. */
  async health(): Promise<Health> {
    const h = await this.request<Health>('GET', '/v1/health', undefined, false);
    if (!h || typeof h.apiVersion !== 'number' || !h.hub?.hubId) {
      throw new BridgeError(200, 'NOT_A_BRIDGE', 'That address answered, but it is not a Hermes phone bridge');
    }
    return h;
  }

  pairComplete(req: PairCompleteRequest): Promise<PairCompleteResponse> {
    return this.request('POST', '/v1/pair/complete', req, false);
  }

  pairRequest(req: { deviceName: string; platform: string; appVersion: string }): Promise<PairRequestResponse> {
    return this.request('POST', '/v1/pair/request', req, false);
  }

  pairRequestStatus(requestId: string): Promise<PairRequestStatus> {
    return this.request('GET', `/v1/pair/request/${encodeURIComponent(requestId)}`, undefined, false);
  }

  projects(): Promise<{ items: Project[] }> {
    return this.request('GET', '/v1/projects');
  }

  sessions(
    q: { limit?: number; before?: number | null; source?: string; all?: boolean; project?: string } = {},
  ): Promise<SessionsPage> {
    const qs = new URLSearchParams();
    if (q.project) qs.set('project', q.project);
    if (q.limit) qs.set('limit', String(q.limit));
    if (q.before != null) qs.set('before', String(q.before));
    if (q.source) qs.set('source', q.source);
    if (q.all) qs.set('all', '1');
    const s = qs.toString();
    return this.request('GET', `/v1/sessions${s ? `?${s}` : ''}`);
  }

  session(id: string): Promise<Session> {
    return this.request('GET', `/v1/sessions/${encodeURIComponent(id)}`);
  }

  /** Without `after`: the latest `limit` messages. With `after`: everything newer than that id. */
  messages(sessionId: string, q: { after?: number; limit?: number } = {}): Promise<MessagesPage> {
    const qs = new URLSearchParams();
    if (q.limit) qs.set('limit', String(q.limit));
    if (q.after) qs.set('after', String(q.after));
    const s = qs.toString();
    return this.request('GET', `/v1/sessions/${encodeURIComponent(sessionId)}/messages${s ? `?${s}` : ''}`);
  }

  /** Disconnect this phone on the PC side too (token stops working). */
  revokeSelf(): Promise<{ ok: boolean }> {
    return this.request('POST', '/v1/device/revoke', {});
  }

  /** A phone chat; with `project` the agent is told to work in that project's folder. */
  newChat(project?: string): Promise<{ chatId: string; project: ProjectRef | null }> {
    return this.request('POST', '/v1/chats', project ? { project } : {});
  }

  /** `clientMessageId` makes retries idempotent (the Gateway drops duplicates for 10 min). */
  send(chatId: string, text: string, clientMessageId: string, files: Attachment[] = []): Promise<SendResponse> {
    return this.post(`/v1/chats/${encodeURIComponent(chatId)}/messages`, text, clientMessageId, files);
  }

  /**
   * Continue ANY session (PC terminal, desktop app, Telegram, …). The Gateway attaches a phone route
   * to it like `/resume` and runs the turn there; 409 SESSION_BUSY while another client is mid-turn.
   */
  sendToSession(sessionId: string, text: string, clientMessageId: string, files: Attachment[] = []): Promise<SendResponse> {
    return this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/messages`, text, clientMessageId, files);
  }

  /** JSON for text, multipart when files are attached (`{uri,name,type}` parts streamed from disk). */
  private post(path: string, text: string, clientMessageId: string, files: Attachment[]): Promise<SendResponse> {
    if (!files.length) return this.request('POST', path, { text, clientMessageId });
    const form = new FormData();
    form.append('text', text);
    form.append('clientMessageId', clientMessageId);
    for (const f of files) form.append('file', { uri: f.uri, name: f.name, type: f.mime } as unknown as Blob);
    const timeout = Math.max(this.timeoutMs, 120_000);
    // Expo replaces global fetch with expo/fetch, which rejects `uri` FormData parts ("Unsupported
    // FormDataPart implementation") before any network I/O. React Native's XMLHttpRequest still goes
    // through RN networking, which reads file:// / content:// parts itself. Tests inject fetchImpl.
    if (this.useXhr) return this.xhrForm<SendResponse>(path, form, timeout);
    return this.request('POST', path, form, true, timeout);
  }

  private xhrForm<T>(path: string, form: FormData, timeoutMs: number): Promise<T> {
    if (!this.baseUrl) return Promise.reject(new BridgeError(0, 'NO_ADDRESS', 'PC address is not set'));
    if (!this.token) return Promise.reject(new BridgeError(401, 'NOT_PAIRED', 'This phone is not paired'));
    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${this.baseUrl}${path}`);
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('Authorization', `Bearer ${this.token}`);
      xhr.timeout = timeoutMs;
      xhr.onload = () => {
        let json: unknown = null;
        try {
          json = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch {
          json = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(json as T);
        const e = (json as { error?: { code?: string; message?: string } } | null)?.error;
        reject(new BridgeError(xhr.status, e?.code ?? `HTTP_${xhr.status}`, e?.message ?? xhr.responseText.slice(0, 200)));
      };
      xhr.onerror = () => reject(new BridgeError(0, 'UNREACHABLE', 'Upload failed: network error'));
      xhr.ontimeout = () =>
        reject(new BridgeError(0, 'TIMEOUT', `No answer from the PC in ${Math.round(timeoutMs / 1000)}s`));
      xhr.send(form);
    });
  }

  /** Which Hermes session a phone chat turned into (null until the agent picked it up). */
  chatSession(chatId: string): Promise<{ chatId: string; sessionId: string | null }> {
    return this.request('GET', `/v1/chats/${encodeURIComponent(chatId)}/session`);
  }
}

export function wsUrl(baseUrl: string, token: string): string {
  const b = normalizeBaseUrl(baseUrl).replace(/^http/i, 'ws');
  return `${b}/v1/ws?access_token=${encodeURIComponent(token)}`;
}

export function newClientMessageId(): string {
  const rnd = Math.random().toString(36).slice(2, 10);
  return `m_${Date.now().toString(36)}_${rnd}`;
}
