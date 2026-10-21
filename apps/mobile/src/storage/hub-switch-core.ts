/**
 * Switching the phone between saved PCs (Account → Computer, Pair → Saved computers).
 * Pure core (no Expo / React Native imports) so it runs under node --test.
 * A switch only happens after that PC's Hub answers an authenticated call, so the phone
 * never lands on a dead or revoked pairing.
 */
import { HubApiError } from '../hub/types';
import type { KnownHub } from './known-hubs-core';

export type HubReach = 'checking' | 'ok' | 'unauthorized' | 'unreachable' | 'not_hub';

/** Short operator label for a reachability state. Pure. */
export function hubReachLabel(reach: HubReach | undefined): string {
  switch (reach) {
    case 'ok':
      return 'Online';
    case 'unauthorized':
      return 'Needs re-pair';
    case 'unreachable':
      return 'Unreachable';
    case 'not_hub':
      return 'Not a Hub';
    case 'checking':
      return 'Checking…';
    default:
      return '';
  }
}

/** Classify a failed authenticated probe. Pure. */
export function reachFromError(err: unknown): HubReach {
  if (err instanceof HubApiError) {
    if (err.status === 401 || err.code === 'DEVICE_REVOKED' || err.code === 'UNAUTHORIZED') return 'unauthorized';
    if (err.code === 'ROUTE_NOT_AVAILABLE') return 'not_hub';
    if (err.status === 0 || err.code === 'NETWORK_ERROR') return 'unreachable';
    return 'ok';
  }
  return 'unreachable';
}

export interface ProbeDeps {
  /** Resolves when the Hub answered an authenticated call; rejects otherwise. */
  call?: (hub: KnownHub, timeoutMs: number) => Promise<unknown>;
  timeoutMs?: number;
}

/** Is this PC's Hub up, and does it still trust this phone? (`call` is required here; the
 * app-facing wrapper in hub-switch.ts supplies the Hub client.) */
export async function probeHub(hub: KnownHub, deps: ProbeDeps = {}): Promise<HubReach> {
  const call = deps.call;
  if (!call) throw new Error('probeHub needs deps.call (use storage/hub-switch in the app)');
  try {
    await call(hub, deps.timeoutMs ?? 4000);
    return 'ok';
  } catch (err) {
    return reachFromError(err);
  }
}

export interface SwitchDeps extends ProbeDeps {
  persist?: (hub: KnownHub) => Promise<void>;
}

/** Make `hub` the active PC when it answers; otherwise report why not and change nothing. */
export async function switchToHub(hub: KnownHub, deps: SwitchDeps = {}): Promise<HubReach> {
  const reach = await probeHub(hub, deps);
  if (reach !== 'ok') return reach;
  if (!deps.persist) throw new Error('switchToHub needs deps.persist (use storage/hub-switch in the app)');
  await deps.persist(hub);
  return 'ok';
}

/** One line for the operator when a switch did not happen. Pure. */
export function switchFailureText(hub: KnownHub, reach: HubReach): string {
  const name = hub.hubDisplayName || hub.hubBaseUrl;
  switch (reach) {
    case 'unauthorized':
      return `${name} no longer trusts this phone — scan the QR on that PC's pair page again.`;
    case 'not_hub':
      return `${hub.hubBaseUrl} answered, but not as a Cursor Mobile Hub — update or restart the Hub on ${name}.`;
    case 'unreachable':
      return `${name} is not reachable — check Tailscale on both devices. Staying on the current PC.`;
    default:
      return `Could not switch to ${name}.`;
  }
}
