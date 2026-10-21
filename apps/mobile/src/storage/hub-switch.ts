/**
 * App-facing PC switching: the pure core from hub-switch-core.ts with the real Hub client
 * and secure-store persistence plugged in.
 */
import { createHubClient } from '../hub/client';
import {
  probeHub as probeHubCore,
  switchToHub as switchToHubCore,
  type ProbeDeps,
  type SwitchDeps,
} from './hub-switch-core';
import type { KnownHub } from './known-hubs-core';
import { savePairingSuccess } from './pairing';

export { hubReachLabel, reachFromError, switchFailureText, type HubReach } from './hub-switch-core';

async function callWorkspace(hub: KnownHub, timeoutMs: number): Promise<unknown> {
  return createHubClient({ baseUrl: hub.hubBaseUrl, deviceToken: hub.deviceToken, timeoutMs }).getWorkspace();
}

function persistActive(hub: KnownHub): Promise<void> {
  return savePairingSuccess({
    hubBaseUrl: hub.hubBaseUrl,
    deviceToken: hub.deviceToken,
    deviceId: hub.deviceId,
    hubDisplayName: hub.hubDisplayName || 'PC',
    hubId: hub.hubId ?? null,
  });
}

export function probeHub(hub: KnownHub, deps: ProbeDeps = {}) {
  return probeHubCore(hub, { call: callWorkspace, ...deps });
}

export function switchToHub(hub: KnownHub, deps: SwitchDeps = {}) {
  return switchToHubCore(hub, { call: callWorkspace, persist: persistActive, ...deps });
}
