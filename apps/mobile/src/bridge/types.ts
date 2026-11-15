/**
 * Wire types of the Hermes Gateway `phone` platform (plugin ~/.hermes/plugins/phone_bridge).
 * The PC's ~/.hermes/state.db is the single source of truth: the phone only mirrors it.
 */

export const BRIDGE_API_VERSION = 1;
export const DEFAULT_BRIDGE_PORT = 8097;

export type SessionStatus = 'working' | 'idle' | 'ended';
export type Role = 'user' | 'assistant' | 'system' | 'tool';

export interface Health {
  ok: boolean;
  apiVersion: number;
  time: string;
  hub: {
    status: 'up';
    uptimeSec: number;
    displayName: string;
    hubId: string;
    /** Every address a phone may use (Tailscale IP, MagicDNS, LAN). */
    addresses?: string[];
  };
  pairing: { required: boolean; devicesPaired: number; oneTap?: boolean };
  /** Highest message id the Gateway has seen. */
  cursor: number;
  /** Connected WebSocket clients. */
  clients: number;
}

export interface Session {
  id: string;
  /** Where the session was started: cli, desktop, telegram, discord, phone, … */
  source: string;
  title: string;
  chatId: string | null;
  model: string | null;
  messageCount: number;
  startedAt: string | null;
  updatedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  status: SessionStatus;
  lastRole: string | null;
  preview: string | null;
  /** Phone may only write into sessions it started itself. */
  canSend: boolean;
  /** Hermes project (desktop sidebar / `hermes project`) the session belongs to. */
  project?: ProjectRef | null;
}

export interface ProjectRef {
  slug: string;
  name: string;
}

export interface Project extends ProjectRef {
  icon: string | null;
  color: string | null;
  description: string | null;
  /** Primary folder on the PC. */
  path: string | null;
  sessionCount: number;
  workingCount: number;
  updatedAt: string | null;
}

export interface SessionsPage {
  items: Session[];
  /** Pass as `before` for the next (older) page; null when exhausted. */
  nextBefore: number | null;
  cursor: number;
}

export interface Message {
  /** state.db messages.id — INTEGER, monotonically increasing across all sessions. */
  id: number;
  sessionId: string;
  role: Role;
  content: string;
  toolName: string | null;
  toolCalls: string[] | null;
  createdAt: string | null;
  finishReason: string | null;
}

export interface MessagesPage {
  sessionId: string;
  status: 'working' | 'idle';
  messages: Message[];
  cursor: number;
}

export interface PairCompleteRequest {
  code: string;
  pairId?: string;
  deviceName: string;
  platform: string;
  appVersion: string;
}

export interface HubInfo {
  displayName: string;
  hubId: string;
  addresses?: string[];
}

export interface PairCompleteResponse {
  deviceId: string;
  deviceToken: string;
  tokenType: 'Bearer';
  expiresAt: string | null;
  hub: HubInfo;
}

/** One-tap pairing: the phone asks, the PC owner taps Allow on http://127.0.0.1:8097/pair. */
export interface PairRequestResponse {
  requestId: string;
  /** Shown on both screens so the owner approves the right phone. */
  confirm: string;
  expiresAt: string;
  hub: HubInfo;
}

export type PairRequestStatus =
  | { status: 'pending' | 'denied' | 'expired' }
  | ({ status: 'approved' } & PairCompleteResponse);

export interface SendResponse {
  accepted: boolean;
  duplicate?: boolean;
  chatId?: string;
  sessionId?: string;
  messageId: string;
}

// ── WebSocket ──────────────────────────────────────────────────────────────

export interface WsServerHello {
  type: 'server.hello';
  apiVersion: number;
  cursor: number;
  serverTime: string;
}
export interface WsStatusSnapshot {
  type: 'status.snapshot';
  working: string[];
}
export interface WsMessageCreated {
  type: 'message.created';
  sessionId: string;
  message: Message;
  replay?: boolean;
}
export interface WsSessionUpdated {
  type: 'session.updated';
  sessionId: string;
  status: 'working' | 'idle';
  lastMessage: Message | null;
  at: string;
}
export interface WsPong {
  type: 'pong';
  ts: number;
}
export interface WsError {
  type: 'error';
  code: string;
  message?: string;
}

/** Ephemeral gateway output (streaming preview, tool progress, command reply) — never persisted. */
export interface WsLiveUpdate {
  type: 'live.update';
  chatId: string;
  sessionId: string | null;
  liveId: string;
  text: string;
  final: boolean;
  at: string;
}
export interface WsLiveRemove {
  type: 'live.remove';
  chatId: string;
  sessionId: string | null;
  liveId: string;
  at: string;
}

export type WsServerEvent =
  | WsLiveUpdate
  | WsLiveRemove
  | WsServerHello
  | WsStatusSnapshot
  | WsMessageCreated
  | WsSessionUpdated
  | WsPong
  | WsError;
