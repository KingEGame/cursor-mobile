/**
 * Mobile helpers for Hub New-session create queue (CURSOR_DOWN / cdp recovery).
 * Mirrors outbound-queue naming; Hub owns persistence — phone surfaces status.
 */

import type { HealthResponse, QueuedCreateSessionResponse } from '../hub/types';

export type CreateQueueUiStatus = 'idle' | 'queuing' | 'retrying' | 'failed';

export function createQueueStatusFromHealth(
  health: HealthResponse | null | undefined,
  localQueued: boolean,
): CreateQueueUiStatus {
  const pending = health?.sessionCreateQueue?.pending ?? 0;
  const last = health?.sessionCreateQueue?.lastDrained;
  if (pending > 0) {
    if (health?.liveAdapter?.state === 'cdp_ok') return 'retrying';
    return 'queuing';
  }
  if (localQueued && health?.liveAdapter?.state !== 'cdp_ok') return 'queuing';
  if (last && last.ok === false && pending === 0) return 'failed';
  return 'idle';
}

export function createQueueBannerText(status: CreateQueueUiStatus): string | null {
  switch (status) {
    case 'queuing':
      return 'Queuing — Hub accepted create; applies on PC when Composer remoting is available';
    case 'retrying':
      return 'Retrying queued create on PC…';
    case 'failed':
      return 'Queued create failed — open Health and retry Create';
    case 'idle':
      return null;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/** True when Hub accepted create into PC-local queue (HTTP 202). */
export function isHubQueuedCreate(
  body: unknown,
): body is QueuedCreateSessionResponse {
  return (
    !!body &&
    typeof body === 'object' &&
    (body as QueuedCreateSessionResponse).queued === true
  );
}

/**
 * When health shows a successful drain after we were queuing, return session id.
 */
export function drainedSessionIdFromHealth(
  health: HealthResponse | null | undefined,
): string | null {
  const last = health?.sessionCreateQueue?.lastDrained;
  if (last?.ok && typeof last.sessionId === 'string' && last.sessionId.length > 0) {
    return last.sessionId;
  }
  return null;
}
