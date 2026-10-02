import { createIdempotencyKey } from './idempotency';
import type { AppLatestResponse } from './app-update';
import {
  HubApiError,
  emptySessionList,
  normalizeCreateSessionResponse,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type CreateSessionResult,
  type QueuedCreateSessionResponse,
  type HealthResponse,
  type HubErrorBody,
  type PairCompleteRequest,
  type PairCompleteResponse,
  type PendingApproval,
  type PostApprovalRequest,
  type PostApprovalResponse,
  type PostAttachmentsRequest,
  type PostAttachmentsResponse,
  type PostMessageRequest,
  type PostMessageResponse,
  type SessionDetail,
  type SessionListResponse,
  type SessionMode,
  type ChatMessage,
  type WorkspaceFilesResponse,
  type WorkspaceFilePreview,
  type WorkspaceModelsResponse,
  type WorkspaceResponse,
  type WorkspaceToolsResponse,
  type AgentsResponse,
  type ChatFileChange,
  type ChatFileDiff,
  type ComposerOptions,
  type MentionOption,
  isQueuedCreateSession,
} from './types';

export type {
  HealthResponse,
  PairCompleteRequest,
  PairCompleteResponse,
  WorkspaceResponse,
  SessionListResponse,
  SessionDetail,
  CreateSessionRequest,
  CreateSessionResponse,
  CreateSessionResult,
  QueuedCreateSessionResponse,
  PostMessageRequest,
  PostMessageResponse,
  PostApprovalRequest,
  PostApprovalResponse,
  WorkspaceModelsResponse,
  WorkspaceFilesResponse,
  WorkspaceFilePreview,
  WorkspaceToolsResponse,
};

export interface HubClientOptions {
  /** Hub base URL, e.g. http://pc.tailnet.ts.net:8787 — no trailing slash */
  baseUrl: string;
  /** Device Bearer token from pairing; omit for public routes */
  deviceToken?: string | null;
  /** Optional fetch inject for tests */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (default 8000). Prevents silent hang on Hub-down / wrong host. */
  timeoutMs?: number;
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function joinUrl(base: string, path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${normalizeBaseUrl(base)}${p}`;
}

function queryString(params: Record<string, string | number | undefined | null>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

async function parseError(res: Response, path: string): Promise<HubApiError> {
  let code = `HTTP_${res.status}`;
  let message = res.statusText || 'Hub request failed';
  let details: unknown;
  try {
    const body = (await res.json()) as HubErrorBody;
    code = body.error?.code ?? body.code ?? code;
    message = body.error?.message ?? body.message ?? message;
    details = body.error?.details ?? body.details;
  } catch {
    // non-JSON body
  }
  if (res.status === 404) {
    return new HubApiError(
      404,
      'ROUTE_NOT_AVAILABLE',
      `Hub route not available yet (${path}): ${message}`,
      details,
    );
  }
  return new HubApiError(res.status, code, message, details);
}

/**
 * Typed Hub HTTP client (TOR-03 `/v1/*`).
 *
 * Phase 1 routes: sessions, messages, approvals, workspace models/files/tools.
 * Missing routes surface as HubApiError `ROUTE_NOT_AVAILABLE` (404).
 * Phone never dials CDP — only Hub over Tailscale.
 */
export class HubClient {
  private readonly baseUrl: string;
  private deviceToken: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: HubClientOptions) {
    if (!opts.baseUrl?.trim()) {
      throw new Error('HubClient requires baseUrl (Tailscale MagicDNS or IP)');
    }
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    this.deviceToken = opts.deviceToken ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  setDeviceToken(token: string | null): void {
    this.deviceToken = token;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private async request<T>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      auth?: boolean;
      headers?: Record<string, string>;
      /** When true, 404 becomes ROUTE_NOT_AVAILABLE with clear message */
      expectRoute?: boolean;
    },
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(options?.headers ?? {}),
    };

    if (options?.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    // auth: true = Bearer required; false/omitted = public (health, pair/complete).
    if (options?.auth === true) {
      if (!this.deviceToken) {
        throw new HubApiError(401, 'NOT_PAIRED', 'Device token missing — pair this phone first');
      }
      headers.Authorization = `Bearer ${this.deviceToken}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(joinUrl(this.baseUrl, path), {
        method,
        headers,
        body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const aborted =
        (err instanceof Error && err.name === 'AbortError') ||
        (typeof err === 'object' &&
          err !== null &&
          'name' in err &&
          (err as { name?: string }).name === 'AbortError');
      const msg = aborted
        ? `timed out after ${this.timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : 'Network error';
      throw new HubApiError(0, 'NETWORK_ERROR', `Cannot reach Hub at ${this.baseUrl}: ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw await parseError(res, path);
    }

    if (res.status === 204) {
      return undefined as T;
    }

    return (await res.json()) as T;
  }

  /** GET /v1/app/latest — release the PC Hub offers for self-update (paired). */
  getAppLatest(): Promise<AppLatestResponse> {
    return this.request<AppLatestResponse>('GET', '/v1/app/latest', { auth: true });
  }

  /** Absolute URL for the APK download (the native downloader sets the Bearer header). */
  appDownloadUrl(downloadPath = '/v1/app/apk'): string {
    return joinUrl(this.baseUrl, downloadPath);
  }

  getDeviceToken(): string | null {
    return this.deviceToken;
  }

  /** GET /v1/health — public (pre-pair reachability). */
  getHealth(): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', '/v1/health', { auth: false });
  }

  /** POST /v1/pair/complete — public (code proves proximity). */
  pairComplete(body: PairCompleteRequest): Promise<PairCompleteResponse> {
    return this.request<PairCompleteResponse>('POST', '/v1/pair/complete', {
      auth: false,
      body,
      headers: {
        'Idempotency-Key': `pair-${body.code}-${body.deviceName}`,
      },
    });
  }

  /** GET /v1/workspace — paired. */
  getWorkspace(): Promise<WorkspaceResponse> {
    return this.request<WorkspaceResponse>('GET', '/v1/workspace', { auth: true });
  }

  /** GET /v1/workspace/models — paired. Empty list disables New session Create. */
  getWorkspaceModels(refresh = false): Promise<WorkspaceModelsResponse> {
    const q = queryString({ refresh: refresh ? 'true' : undefined });
    return this.request<WorkspaceModelsResponse>('GET', `/v1/workspace/models${q}`, {
      auth: true,
    });
  }

  /** GET /v1/workspace/files — paired. Stub/empty OK for Phase 1 basic attach. */
  getWorkspaceFiles(opts?: {
    q?: string;
    root?: string;
    limit?: number;
    cursor?: string;
  }): Promise<WorkspaceFilesResponse> {
    const q = queryString({
      q: opts?.q,
      root: opts?.root,
      limit: opts?.limit,
      cursor: opts?.cursor,
    });
    return this.request<WorkspaceFilesResponse>('GET', `/v1/workspace/files${q}`, {
      auth: true,
    });
  }

  /** GET /v1/workspace/file?path= — optional Phase 3 text preview (FR-070). */
  getWorkspaceFile(path: string): Promise<WorkspaceFilePreview> {
    const q = queryString({ path });
    return this.request<WorkspaceFilePreview>('GET', `/v1/workspace/file${q}`, {
      auth: true,
    });
  }

  /** GET /v1/workspace/tools — informational; empty still allows create. */
  getWorkspaceTools(): Promise<WorkspaceToolsResponse> {
    return this.request<WorkspaceToolsResponse>('GET', '/v1/workspace/tools', { auth: true });
  }

  /**
   * GET /v1/sessions — live list for bound workspace.
   * On ROUTE_NOT_AVAILABLE returns empty list (degraded) when `tolerateMissing` is true.
   */
  /**
   * POST /v1/agents/chats/:composerId/messages — the Hub opens that chat on the PC
   * (sidebar click, verified switch) and types + sends `text` into it.
   */
  async sendToAgentChat(
    composerId: string,
    text: string,
    options?: ComposerOptions,
  ): Promise<{ ok: true; composerId: string; switchedOnPc: boolean }> {
    return this.request('POST', `/v1/agents/chats/${encodeURIComponent(composerId)}/messages`, {
      auth: true,
      body: { text, ...options },
    });
  }

  /** PUT /v1/agents/chats/:id/messages/:messageId — edit an earlier message and resubmit. */
  async editAgentMessage(composerId: string, messageId: string, text: string): Promise<{ ok: true }> {
    return this.request(
      'PUT',
      `/v1/agents/chats/${encodeURIComponent(composerId)}/messages/${encodeURIComponent(messageId)}`,
      { auth: true, body: { text } },
    );
  }

  /** GET /v1/agents/chats/:id/mentions — Cursor's "@" / "/" options for a query. */
  async listChatMentions(
    composerId: string,
    trigger: '@' | '/',
    q: string,
  ): Promise<{ options: MentionOption[] }> {
    const query = `?trigger=${encodeURIComponent(trigger)}&q=${encodeURIComponent(q)}`;
    return this.request('GET', `/v1/agents/chats/${encodeURIComponent(composerId)}/mentions${query}`, {
      auth: true,
    });
  }


  /**
   * POST /v1/agents/projects/new — start a new chat in one sidebar project on the PC and
   * send its first message. Returns the new chat's session id when Cursor reported one.
   */
  async newAgentChat(
    projectId: string,
    text: string,
    options?: ComposerOptions,
  ): Promise<{ ok: true; composerId: string | null; sessionId: string | null }> {
    return this.request('POST', '/v1/agents/projects/new', {
      auth: true,
      body: { projectId, text, ...options },
    });
  }

  /** POST /v1/agents/chats/:id/stop — click Stop generation for that chat on the PC. */
  async stopAgentChat(composerId: string): Promise<{ ok: true }> {
    return this.request('POST', `/v1/agents/chats/${encodeURIComponent(composerId)}/stop`, {
      auth: true,
      body: {},
    });
  }

  /** GET /v1/agents/chats/:id/changes — files this chat changed (read-only). */
  async listChatChanges(composerId: string): Promise<{ composerId: string; files: ChatFileChange[] }> {
    return this.request('GET', `/v1/agents/chats/${encodeURIComponent(composerId)}/changes`, { auth: true });
  }

  /** GET /v1/agents/chats/:id/changes/:index — one file's diff (original → current). */
  async getChatFileDiff(composerId: string, index: number): Promise<ChatFileDiff> {
    return this.request('GET', `/v1/agents/chats/${encodeURIComponent(composerId)}/changes/${index}`, {
      auth: true,
    });
  }

  /** GET /v1/agents — projects → chats exactly as the PC Agents sidebar shows them. */
  async listAgents(): Promise<AgentsResponse> {
    return this.request<AgentsResponse>('GET', '/v1/agents', { auth: true });
  }

  async listSessions(
    workspaceId: string,
    opts?: {
      mode?: SessionMode | 'all';
      limit?: number;
      cursor?: string;
      /** Default true — empty list when Hub has not shipped GET /sessions yet */
      tolerateMissing?: boolean;
    },
  ): Promise<SessionListResponse> {
    const q = queryString({
      workspaceId,
      mode: opts?.mode ?? 'live',
      limit: opts?.limit,
      cursor: opts?.cursor,
    });
    try {
      return await this.request<SessionListResponse>('GET', `/v1/sessions${q}`, { auth: true });
    } catch (err) {
      if (
        err instanceof HubApiError &&
        err.isRouteMissing &&
        (opts?.tolerateMissing ?? true)
      ) {
        return emptySessionList(workspaceId);
      }
      throw err;
    }
  }

  /** GET /v1/sessions/:id */
  getSession(sessionId: string): Promise<SessionDetail> {
    return this.request<SessionDetail>('GET', `/v1/sessions/${encodeURIComponent(sessionId)}`, {
      auth: true,
    });
  }

  /**
   * POST /v1/sessions — create live Composer session on PC-open workspace.
   * Normalizes Phase 0 Hub stub `{ sessionId }` → `{ id }`.
   */
  async createSession(
    body: CreateSessionRequest,
    idempotencyKey?: string,
  ): Promise<CreateSessionResult> {
    const raw = await this.request<unknown>('POST', '/v1/sessions', {
      auth: true,
      body,
      headers: {
        'Idempotency-Key': idempotencyKey ?? createIdempotencyKey('create-session'),
      },
    });
    return normalizeCreateSessionResponse(raw);
  }

  /** POST /v1/sessions/:id/messages */
  postMessage(
    sessionId: string,
    body: PostMessageRequest,
    idempotencyKey?: string,
  ): Promise<PostMessageResponse> {
    return this.request<PostMessageResponse>(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        auth: true,
        body,
        headers: {
          'Idempotency-Key': idempotencyKey ?? createIdempotencyKey('msg'),
        },
      },
    );
  }

  /** POST /v1/sessions/:id/attachments */
  postAttachments(
    sessionId: string,
    body: PostAttachmentsRequest,
    idempotencyKey?: string,
  ): Promise<PostAttachmentsResponse> {
    return this.request<PostAttachmentsResponse>(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/attachments`,
      {
        auth: true,
        body,
        headers: {
          'Idempotency-Key': idempotencyKey ?? createIdempotencyKey('attach'),
        },
      },
    );
  }

  /** POST /v1/sessions/:id/approvals */
  postApproval(
    sessionId: string,
    body: PostApprovalRequest,
    idempotencyKey?: string,
  ): Promise<PostApprovalResponse> {
    return this.request<PostApprovalResponse>(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/approvals`,
      {
        auth: true,
        body,
        headers: {
          'Idempotency-Key':
            idempotencyKey ?? createIdempotencyKey(`apr-${body.decision}`),
        },
      },
    );
  }

  /** GET /v1/sessions/:id/approvals — pending list (WS may have missed events). */
  getSessionApprovals(sessionId: string): Promise<{
    sessionId: string;
    items: PendingApproval[];
  }> {
    return this.request(
      'GET',
      `/v1/sessions/${encodeURIComponent(sessionId)}/approvals`,
      { auth: true },
    );
  }

  /** GET /v1/sessions/:id/messages — history transcript (live snapshot may be empty). */
  getSessionMessages(
    sessionId: string,
    opts?: { limit?: number },
  ): Promise<{
    sessionId: string;
    mode: SessionMode;
    messages: ChatMessage[];
    truncated: boolean;
    nextCursor: string | null;
  }> {
    const q = queryString({ limit: opts?.limit });
    return this.request(
      'GET',
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages${q}`,
      { auth: true },
    );
  }

  /** POST /v1/sessions/:id/open-on-pc — history → live (best-effort). */
  openOnPc(
    sessionId: string,
    idempotencyKey?: string,
  ): Promise<{
    id: string;
    sessionId: string;
    workspaceId: string;
    mode: 'live';
    previousMode: SessionMode;
    historySessionId?: string;
    openedAt: string;
    note?: string;
  }> {
    return this.request(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/open-on-pc`,
      {
        auth: true,
        body: {},
        headers: {
          'Idempotency-Key': idempotencyKey ?? createIdempotencyKey('open-on-pc'),
        },
      },
    );
  }
}

export function createHubClient(opts: HubClientOptions): HubClient {
  return new HubClient(opts);
}

/** True when health says CDP/Cursor live path is degraded (chat may fail). */
export function isLivePathDegraded(health: HealthResponse | null | undefined): boolean {
  if (!health) return true;
  if (!health.ok) return true;
  if (health.cdp.status !== 'connected') return true;
  if (health.cursor.status === 'not_detected') return true;
  // Soft pack-partial (send VERIFIED, other actions CANDIDATE) is NOT degraded for
  // send / New-session gates — use livePathDegradedReason for the informational banner.
  if (isSenderMutationsBlocked(health)) return true;
  return false;
}

/**
 * True when Composer **send** mutations cannot succeed yet (CDP down or
 * send_message still CANDIDATE). Pack-wide extractor_stale alone is NOT enough —
 * approve/deny/model_select may stay CANDIDATE while send_message is VERIFIED.
 */
export function isSenderMutationsBlocked(
  health: HealthResponse | null | undefined,
): boolean {
  if (!health) return true;
  if (health.cdp.status !== 'connected') return true;
  if (health.cursor.status === 'not_detected') return true;
  const la = health.liveAdapter;
  if (!la) {
    // Older Hub without liveAdapter — treat CDP+cursor as enough for degrade checks.
    return false;
  }
  if (la.state === 'cursor_down') return true;
  // Prefer explicit Hub flag when present (Phase 1+ with per-action health).
  if (typeof la.sendMessageVerified === 'boolean') {
    return !la.sendMessageVerified;
  }
  if (la.actions?.send_message === 'VERIFIED') return false;
  if (la.actions?.send_message === 'CANDIDATE') return true;
  // Legacy Hub: pack-wide stale ⇒ assume send blocked.
  if (la.state === 'extractor_stale') return true;
  if (!la.extractorReady) return true;
  return false;
}

export function livePathDegradedReason(health: HealthResponse | null | undefined): string {
  if (!health) return 'Hub health unknown — refresh Health.';
  if (!health.ok) return 'Hub reports unhealthy.';
  if (health.cdp.status !== 'connected') {
    return health.cdp.error
      ? `Sender blocked: enable CDP (${health.cdp.status}: ${health.cdp.error}).`
      : 'Sender blocked: enable CDP on the PC (Cursor --remote-debugging-port=9222, 127.0.0.1 only).';
  }
  if (health.cursor.status === 'not_detected') {
    return 'Sender blocked: open Cursor with the project on the PC.';
  }
  const la = health.liveAdapter;
  if (la?.state === 'cursor_down') {
    return 'Sender blocked: enable CDP / relaunch Cursor with remote debugging.';
  }
  if (isSenderMutationsBlocked(health)) {
    return (
      'Sender blocked: verify Composer selectors (send_message still CANDIDATE). ' +
      'Mark VERIFIED after live DOM proof — mutations stay fail-closed.'
    );
  }
  // Send path OK — other actions may still be CANDIDATE (approvals / @-attach).
  if (la?.state === 'extractor_stale' || (la && !la.extractorReady)) {
    return (
      'Send path ready (send_message VERIFIED). Approve/Deny and other mutations ' +
      'stay fail-closed until their selectors are VERIFIED on the PC.'
    );
  }
  return '';
}

/** Operator-facing copy for Composer send failures (POST …/messages). */
export function formatSenderError(err: HubApiError): string {
  switch (err.code) {
    case 'EXTRACTOR_STALE': {
      const details = err.details as
        | { action?: string; actionStatus?: string }
        | undefined;
      const action = details?.action ?? 'send_message';
      const status = details?.actionStatus ?? 'CANDIDATE';
      return (
        `Sender blocked: ${action} selectors are still ${status} ` +
        `(${err.message}). Do not queue; fix pack on PC first.`
      );
    }
    case 'CDP_UNAVAILABLE':
    case 'CURSOR_DOWN':
      return (
        'Sender blocked: enable CDP on the PC (127.0.0.1:9222). ' +
        `${err.message}`
      );
    case 'SESSION_NOT_FOUND':
      return `Sender failed: session not on Hub live adapter — ${err.message}`;
    case 'SESSION_NOT_LIVE':
      return `Sender blocked: history session — ${err.message}`;
    case 'IDEMPOTENCY_KEY_MISSING':
    case 'IDEMPOTENCY_KEY_REUSE':
      return `Sender failed (idempotency): ${err.message}`;
    case 'VALIDATION_ERROR':
      return `Sender failed: ${err.message}`;
    default:
      return `${err.code}: ${err.message}`;
  }
}

/**
 * Operator-facing copy for Approve/Deny failures (POST …/approvals).
 * EXTRACTOR_STALE here means approve/deny selectors are CANDIDATE — not send_message.
 */
export function formatApprovalError(err: HubApiError): string {
  switch (err.code) {
    case 'EXTRACTOR_STALE': {
      const details = err.details as
        | { action?: string; actionStatus?: string }
        | undefined;
      const action = details?.action ?? 'approve/deny';
      const status = details?.actionStatus ?? 'CANDIDATE';
      return (
        `Approve/Deny blocked: ${action} selectors are still ${status} — ` +
        `Hub fail-closed (no Cursor DOM click). ${err.message}`
      );
    }
    case 'APPROVAL_NOT_FOUND':
      return `Approval not found on Hub — ${err.message}`;
    case 'APPROVAL_APPLY_FAILED':
      return `Approval apply failed — ${err.message}`;
    case 'CDP_UNAVAILABLE':
    case 'CURSOR_DOWN':
      return (
        `Approve/Deny blocked: enable CDP on the PC (127.0.0.1:9222). ${err.message}`
      );
    case 'SESSION_NOT_FOUND':
      return `Approval failed: session not on Hub — ${err.message}`;
    case 'IDEMPOTENCY_KEY_MISSING':
    case 'IDEMPOTENCY_KEY_REUSE':
      return `Approval failed (idempotency): ${err.message}`;
    case 'VALIDATION_ERROR':
      return `Approval failed: ${err.message}`;
    default:
      return `${err.code}: ${err.message}`;
  }
}

/** Network / CDP-down failures may be queued; selector stale must not. */
export function shouldQueueSenderFailure(err: HubApiError): boolean {
  return (
    err.code === 'NETWORK_ERROR' ||
    err.code === 'CDP_UNAVAILABLE' ||
    err.code === 'CURSOR_DOWN'
  );
}
