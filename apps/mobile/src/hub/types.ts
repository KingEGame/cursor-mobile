/**
 * Hub API types — aligned with TOR-03 (`docs/reports/tor/TOR-03-hub-and-api-specification.md`).
 * Status: DESIGNED contract. Hub implementation may still be landing — keep TODOs honest.
 */

export type CdpStatus = 'connected' | 'disconnected' | 'error';
export type CursorStatus = 'running' | 'not_detected';
export type HubStatus = 'up';
/** LiveCursorAdapter triad from GET /health (Hub). */
export type LiveAdapterState = 'cdp_ok' | 'extractor_stale' | 'cursor_down';

export interface LiveAdapterHealthSlice {
  state: LiveAdapterState;
  cdpUrl?: string;
  selectorPack?: string;
  windowId?: string | null;
  workspaceId?: string | null;
  extractorReady: boolean;
  lastError?: string | null;
  /** Per-action pack flags from Hub (send may be VERIFIED while pack is partial). */
  actions?: Record<string, 'VERIFIED' | 'CANDIDATE'> | null;
  /** True when Hub reports send_message selectors VERIFIED. */
  sendMessageVerified?: boolean;
  lastSessionCreateAttempt?: {
    at: string;
    promptLen: number;
    promptPrefix: string;
    attachmentCount: number;
    model: string;
    ok: boolean;
    code?: string;
    queued?: boolean;
    queueId?: string;
  } | null;
}

export interface SessionCreateQueueHealthSlice {
  pending: number;
  items: Array<{
    id: string;
    status: string;
    model: string;
    promptLen: number;
    promptPrefix: string;
    attachmentCount: number;
    createdAt: string;
    lastError?: string;
    resultSessionId?: string;
  }>;
  lastDrained: {
    at: string;
    sessionId: string | null;
    queueId: string;
    ok: boolean;
    error?: string;
  } | null;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  apiVersion: string;
  time: string;
  hub: {
    status: HubStatus;
    uptimeSec: number;
  };
  cdp: {
    status: CdpStatus;
    urlConfigured: string;
    lastAttachAt: string | null;
    error: string | null;
  };
  cursor: {
    status: CursorStatus;
    windowsDetected: number;
  };
  /** Present on Phase 1+ Hub — drives honest sender / mutation UX. */
  liveAdapter?: LiveAdapterHealthSlice;
  /** Pending New-session creates while CDP down (Hub-side PC-local queue). */
  sessionCreateQueue?: SessionCreateQueueHealthSlice;
  workspace: {
    bound: boolean;
    workspaceId: string | null;
    name: string | null;
    path: string | null;
  } | null;
  pairing: {
    required: boolean;
    devicesPaired: number;
  };
}

export interface PairCompleteRequest {
  code: string;
  pairId?: string;
  deviceName: string;
  platform: 'android';
  appVersion: string;
  clientPublicKey?: string | null;
}

export interface PairCompleteResponse {
  deviceId: string;
  deviceToken: string;
  tokenType: 'Bearer';
  expiresAt: string | null;
  hub: {
    displayName: string;
    baseUrlHint: string;
  };
}

export interface WorkspaceWindow {
  windowId: string;
  title: string;
  workspaceId: string;
  path: string;
  selected: boolean;
}

export interface WorkspaceRoot {
  name: string;
  path: string;
}

/** Bound workspace (project open on PC). */
export interface WorkspaceBound {
  workspaceId: string;
  name: string;
  path: string;
  roots: WorkspaceRoot[];
  windowId: string | null;
  windows: WorkspaceWindow[];
  updatedAt: string;
  emptyReason?: undefined;
}

/** No folder open — APK must show empty state, never invent a project. */
export interface WorkspaceEmpty {
  workspaceId: null;
  name: null;
  path: null;
  roots: [];
  windowId: null;
  windows: [];
  updatedAt: string;
  emptyReason: 'NO_FOLDER_OPEN' | string;
}

export type WorkspaceResponse = WorkspaceBound | WorkspaceEmpty;

export function isWorkspaceBound(ws: WorkspaceResponse): ws is WorkspaceBound {
  return ws.workspaceId != null && ws.path != null;
}

export interface HubErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
  code?: string;
  message?: string;
  details?: unknown;
}

export class HubApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HubApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** True when Hub has not shipped this route yet (404 / stub gap). */
  get isRouteMissing(): boolean {
    return this.status === 404 || this.code === 'ROUTE_NOT_AVAILABLE';
  }

  /** True only when the Hub build lacks the route — not unknown session/workspace 404s. */
  get isHubRouteNotShipped(): boolean {
    return this.code === 'ROUTE_NOT_AVAILABLE';
  }

  /** True when Composer DOM send/approve is fail-closed (selectors or CDP). */
  get isSenderBlocked(): boolean {
    return (
      this.code === 'EXTRACTOR_STALE' ||
      this.code === 'CDP_UNAVAILABLE' ||
      this.code === 'CURSOR_DOWN'
    );
  }
}

// --- Phase 1: sessions / workspace models / files / tools / approvals ---

export type SessionMode = 'live' | 'history' | 'editor';

export interface SessionListItem {
  id: string;
  workspaceId: string;
  mode: SessionMode;
  title: string;
  preview: string | null;
  model: string | null;
  updatedAt: string;
  createdAt: string;
  pendingApprovals: number;
}

export interface SessionListResponse {
  workspaceId: string;
  items: SessionListItem[];
  nextCursor: string | null;
  /** Present on Hub Phase 2+ history / all lists */
  history?: {
    ok: boolean;
    extractorStale: boolean;
    sessionCountForBind: number | null;
    lastScanAt: string | null;
    reason?: string;
  };
  liveAdapter?: {
    state: string;
    extractorReady: boolean;
  };
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  status?: 'streaming' | 'completed' | 'failed';
}

export interface SessionDetail {
  id: string;
  workspaceId: string;
  mode: SessionMode;
  title: string;
  model: string | null;
  agentMode: string | null;
  createdAt: string;
  updatedAt: string;
  attachments: string[];
  transcript: {
    messages: ChatMessage[];
    truncated: boolean;
    nextCursor: string | null;
  };
  capabilities: {
    canMessage: boolean;
    canApprove: boolean;
    canAttach: boolean;
    canOpenOnPc: boolean;
  };
}

export interface CreateSessionRequest {
  workspaceId: string;
  model: string;
  attachments?: string[];
  prompt?: string;
  agentMode?: string;
}

export interface CreateSessionResponse {
  id: string;
  workspaceId: string;
  mode: 'live';
  title: string | null;
  model: string;
  agentMode: string | null;
  attachments: string[];
  createdAt: string;
  updatedAt: string;
  /** Present on Phase 0 Hub stub only */
  note?: string;
}

/** Hub 202 — create queued until liveAdapter is cdp_ok. */
export interface QueuedCreateSessionResponse {
  queued: true;
  queueId: string;
  status: string;
  workspaceId: string;
  model: string;
  attachments: string[];
  prompt: string | null;
  promptLen: number;
  agentMode: string | null;
  deduped?: boolean;
  note?: string;
}

export type CreateSessionResult = CreateSessionResponse | QueuedCreateSessionResponse;

export function isQueuedCreateSession(
  r: CreateSessionResult,
): r is QueuedCreateSessionResponse {
  return (r as QueuedCreateSessionResponse).queued === true;
}

export interface PostMessageRequest {
  content: string;
  clientMessageId?: string;
}

export interface PostMessageResponse {
  messageId: string;
  sessionId: string;
  role: 'user';
  content: string;
  status: 'accepted';
  createdAt: string;
  /** True only when LiveCursorAdapter actually drove Composer DOM. */
  domApplied?: boolean;
}

export interface PostAttachmentsRequest {
  attachments: string[];
  mode: 'add';
}

export interface PostAttachmentsResponse {
  sessionId: string;
  attachments: string[];
  added: string[];
}

export type ApprovalDecision = 'approve' | 'deny';

export interface PostApprovalRequest {
  approvalId: string;
  decision: ApprovalDecision;
}

export interface PostApprovalResponse {
  approvalId: string;
  sessionId: string;
  decision: ApprovalDecision;
  status: 'applied' | 'recorded' | string;
  appliedAt: string;
  /** True only when approve/deny selectors VERIFIED and CDP click succeeded. */
  domApplied?: boolean;
  /** True when Hub synthetic UAT path recorded the decision (no Cursor DOM). */
  synthetic?: boolean;
  note?: string;
}

export interface WorkspaceModel {
  id: string;
  label: string;
  family?: string;
  available: boolean;
  default?: boolean;
}

export interface WorkspaceModelsResponse {
  workspaceId: string;
  models: WorkspaceModel[];
  source: string;
  updatedAt: string;
  /** Honest Hub note — never implies live CDP model scrape until VERIFIED. */
  note?: string;
  domSelectVerified?: boolean;
}

export interface WorkspaceFileItem {
  path: string;
  rootPath: string;
  kind: 'file' | 'dir';
  sizeBytes?: number;
}

export interface WorkspaceFilesResponse {
  workspaceId: string;
  items: WorkspaceFileItem[];
  nextCursor: string | null;
}

/** Optional Phase 3 — GET /v1/workspace/file?path= */
export interface WorkspaceFilePreview {
  workspaceId: string;
  path: string;
  rootPath: string;
  sizeBytes: number;
  truncated: boolean;
  encoding: 'utf8';
  content: string;
  binary: boolean;
  note?: string;
}

export interface WorkspaceToolsResponse {
  workspaceId: string;
  summary: {
    mcpServers: Array<{ name: string; enabled: boolean; toolCount?: number }>;
    plugins: Array<{ name: string; enabled: boolean }>;
    note?: string;
  };
  updatedAt: string;
  source?: string;
  liveAdapter?: {
    state: string;
    extractorReady: boolean;
  };
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'failed' | 'expired';

export interface PendingApproval {
  approvalId: string;
  sessionId: string;
  tool: {
    name: string;
    server?: string | null;
    kind?: string | null;
  };
  summary: string;
  argsPreview?: unknown;
  createdAt: string;
  expiresAt?: string | null;
  status: ApprovalStatus;
  /** Hub synthetic UAT — not a live Cursor tool card. */
  synthetic?: boolean;
}

/** Normalize create-session payloads from TOR (`id`) or Phase 0 Hub stub (`sessionId`). */
export function normalizeCreateSessionResponse(raw: unknown): CreateSessionResult {
  if (!raw || typeof raw !== 'object') {
    throw new HubApiError(502, 'INVALID_RESPONSE', 'Create session returned empty body');
  }
  const body = raw as Record<string, unknown>;
  if (body.queued === true) {
    return {
      queued: true,
      queueId: typeof body.queueId === 'string' ? body.queueId : 'unknown',
      status: typeof body.status === 'string' ? body.status : 'pending',
      workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : '',
      model: typeof body.model === 'string' ? body.model : '',
      attachments: Array.isArray(body.attachments)
        ? body.attachments.filter((p): p is string => typeof p === 'string')
        : [],
      prompt: typeof body.prompt === 'string' ? body.prompt : null,
      promptLen: typeof body.promptLen === 'number' ? body.promptLen : 0,
      agentMode: typeof body.agentMode === 'string' ? body.agentMode : null,
      deduped: body.deduped === true,
      note: typeof body.note === 'string' ? body.note : undefined,
    };
  }
  const id =
    typeof body.id === 'string'
      ? body.id
      : typeof body.sessionId === 'string'
        ? body.sessionId
        : null;
  if (!id) {
    throw new HubApiError(502, 'INVALID_RESPONSE', 'Create session missing id/sessionId');
  }
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
  const model = typeof body.model === 'string' ? body.model : '';
  const now = new Date().toISOString();
  return {
    id,
    workspaceId,
    mode: 'live',
    title: typeof body.title === 'string' ? body.title : null,
    model,
    agentMode: typeof body.agentMode === 'string' ? body.agentMode : null,
    attachments: Array.isArray(body.attachments)
      ? body.attachments.filter((p): p is string => typeof p === 'string')
      : [],
    createdAt: typeof body.createdAt === 'string' ? body.createdAt : now,
    updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : now,
    note: typeof body.note === 'string' ? body.note : undefined,
  };
}

export function emptySessionList(workspaceId: string): SessionListResponse {
  return { workspaceId, items: [], nextCursor: null };
}

/** GET /v1/agents — Cursor Agents-window list (projects → chats) from the PC. */
export type AgentChatStatus = 'working' | 'waiting_approval' | 'error' | 'idle';

export interface AgentsChatRow {
  /** Open with GET /v1/sessions/:id (read-only transcript). */
  sessionId: string;
  composerId: string;
  title: string;
  /** Age as shown in the PC sidebar ("42m", "7d"); null in history fallback. */
  ageLabel: string | null;
  updatedAt: string | null;
  status: AgentChatStatus;
  unread: boolean;
  linesAdded: number;
  linesRemoved: number;
  activeOnPc: boolean;
}

export interface AgentsProjectRow {
  projectId: string;
  name: string;
  path: string | null;
  hasMore: boolean;
  /** Expanded in the PC sidebar; null when unknown (history fallback). */
  expanded: boolean | null;
  chats: AgentsChatRow[];
}

export interface AgentsResponse {
  source: 'sidebar' | 'history';
  note: string | null;
  scannedAt: string;
  projects: AgentsProjectRow[];
}

/** GET /v1/agents/chats/:id/changes */
export interface ChatFileChange {
  index: number;
  path: string;
  isNew: boolean;
  deleted: boolean;
  added: number;
  removed: number;
  skipped: string | null;
}

/** GET /v1/agents/chats/:id/changes/:index */
export interface ChatFileDiff extends ChatFileChange {
  hunks: Array<{ oldStart: number; newStart: number; lines: string[] }>;
}

/** Cursor composer modes offered by the Agents-window "+" list. */
export type AgentMode = 'Plan' | 'Debug' | 'Multitask' | 'Ask';

/** "@" files / plugins or "/" skills, inserted as Cursor chips. */
export interface MentionRef {
  trigger: '@' | '/';
  label: string;
  detail?: string;
}

/** GET /v1/agents/chats/:id/mentions — what Cursor offers for "@q" / "/q". */
export interface MentionOption {
  label: string;
  detail: string;
  hint: string;
}

export interface PhonePhoto {
  name: string;
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  base64: string;
}

/** Optional composer settings sent with a message (applied and verified on the PC). */
export interface ComposerOptions {
  mode?: AgentMode | null;
  model?: string | null;
  mentions?: MentionRef[];
  images?: PhonePhoto[];
}
