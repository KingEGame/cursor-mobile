/**
 * Distinct companion connection / error states (NFR-OFF-01).
 * Prefer these over a single vague "error" string in UI.
 */
import type { HealthResponse } from './types';
import { HubApiError } from './types';

export type CompanionConnectionState =
  | 'Ready'
  | 'TailscaleDown'
  | 'HubDown'
  | 'CursorDown'
  | 'CDPOff'
  | 'SenderBlocked'
  | 'Unpaired'
  | 'Revoked'
  | 'Queuing'
  | 'Unknown';

export interface ConnectionStateInput {
  hubBaseUrl: string | null | undefined;
  deviceToken: string | null | undefined;
  health: HealthResponse | null | undefined;
  /** Last transport / API error if any */
  lastError?: HubApiError | Error | null;
  /** Pending offline queue depth */
  queuedCount?: number;
}

const COPY: Record<CompanionConnectionState, string> = {
  Ready: 'Connected — Hub and Cursor path look healthy.',
  TailscaleDown:
    'Cannot reach Hub — open Tailscale on this phone, sign in to the same tailnet as the PC, then retry.',
  HubDown:
    'Hub unreachable or unhealthy — confirm Tailscale Online, then Hub URL (MagicDNS/IP:8787).',
  CursorDown: 'Cursor not detected on the PC — open Cursor with the project.',
  CDPOff:
    'Composer remoting offline on PC — Hub still works; New-session Create queues until Cursor automation is available.',
  SenderBlocked:
    'Sender blocked: send_message selectors still CANDIDATE — verify Composer selectors on the PC Hub path.',
  Unpaired: 'This phone is not paired — enter a pair code from the PC.',
  Revoked: 'Device token revoked — re-pair from the PC operator console.',
  Queuing: 'Offline queue active — outbound sends wait until Ready (no auto-approve).',
  Unknown: 'Connection state unknown — open Health and Refresh.',
};

export function connectionStateLabel(state: CompanionConnectionState): string {
  return COPY[state];
}

function isSendPathBlocked(health: HealthResponse): boolean {
  const la = health.liveAdapter;
  if (!la) return false;
  if (la.state === 'cursor_down') return true;
  if (typeof la.sendMessageVerified === 'boolean') {
    return !la.sendMessageVerified;
  }
  if (la.actions?.send_message === 'VERIFIED') return false;
  if (la.actions?.send_message === 'CANDIDATE') return true;
  // Legacy Hub without per-action flags: pack-wide stale blocks send.
  return la.state === 'extractor_stale' || !la.extractorReady;
}

export function deriveConnectionState(
  input: ConnectionStateInput,
): CompanionConnectionState {
  if (!input.hubBaseUrl?.trim()) {
    return 'Unpaired';
  }
  if (!input.deviceToken) {
    return 'Unpaired';
  }

  const err = input.lastError;
  if (err instanceof HubApiError) {
    if (err.code === 'DEVICE_REVOKED' || err.status === 401) {
      return 'Revoked';
    }
    if (err.code === 'NETWORK_ERROR' || err.status === 0) {
      return 'TailscaleDown';
    }
    if (err.code === 'EXTRACTOR_STALE') {
      return 'SenderBlocked';
    }
    if (err.code === 'CDP_UNAVAILABLE' || err.code === 'CURSOR_DOWN') {
      return 'CDPOff';
    }
  }

  const health = input.health;
  if (!health) {
    if ((input.queuedCount ?? 0) > 0) return 'Queuing';
    return 'Unknown';
  }

  if (!health.ok) {
    return 'HubDown';
  }

  if (health.cdp.status !== 'connected') {
    return 'CDPOff';
  }

  if (health.cursor.status === 'not_detected') {
    return 'CursorDown';
  }

  if (health.liveAdapter?.state === 'cursor_down') {
    return 'CDPOff';
  }

  if (isSendPathBlocked(health)) {
    return 'SenderBlocked';
  }

  if ((input.queuedCount ?? 0) > 0) {
    return 'Queuing';
  }

  return 'Ready';
}

/** True when outbound flush is allowed (NFR-OFF-03). Approvals still need user decision. */
export function isReadyForFlush(state: CompanionConnectionState): boolean {
  return state === 'Ready' || state === 'Queuing';
}

/**
 * Flush only when Hub+CDP+Cursor are healthy and selector pack can mutate.
 * Queuing alone means items exist but mesh/CDP/selectors may still block.
 */
export function canFlushOutbound(input: ConnectionStateInput): boolean {
  const state = deriveConnectionState({ ...input, queuedCount: 0 });
  return state === 'Ready';
}
