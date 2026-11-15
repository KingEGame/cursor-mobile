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
  hub: { status: 'up'; uptimeSec: number; displayName: string; hubId: string };
  pairing: { required: boolean; devicesPaired: number };
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

export interface PairCompleteResponse {
  deviceId: string;
  deviceToken: string;
  tokenType: 'Bearer';
  expiresAt: string | null;
  hub: { displayName: string; hubId: string };
}

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

export type WsServerEvent =
  | WsServerHello
  | WsStatusSnapshot
  | WsMessageCreated
  | WsSessionUpdated
  | WsPong
  | WsError;
