import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HubApiError } from '../hub/types';
import type { KnownHub } from './known-hubs-core';
import { hubReachLabel, probeHub, reachFromError, switchFailureText, switchToHub } from './hub-switch-core';

const laptop: KnownHub = {
  hubBaseUrl: 'http://100.2.2.2:8787',
  deviceToken: 'tok',
  deviceId: 'dev',
  hubDisplayName: 'Laptop',
  lastUsedAt: '2026-10-21T00:00:00.000Z',
  hubId: 'abc',
};

describe('hub switch', () => {
  it('classifies probe failures', () => {
    assert.equal(reachFromError(new HubApiError(401, 'DEVICE_REVOKED', 'x')), 'unauthorized');
    assert.equal(reachFromError(new HubApiError(0, 'NETWORK_ERROR', 'x')), 'unreachable');
    assert.equal(reachFromError(new HubApiError(404, 'ROUTE_NOT_AVAILABLE', 'x')), 'not_hub');
    assert.equal(reachFromError(new HubApiError(409, 'NO_FOLDER_OPEN', 'x')), 'ok');
    assert.equal(reachFromError(new Error('boom')), 'unreachable');
    assert.equal(hubReachLabel('unauthorized'), 'Needs re-pair');
  });

  it('switches only when the PC answers, and persists that PC', async () => {
    const saved: KnownHub[] = [];
    const ok = await switchToHub(laptop, { call: async () => ({}), persist: async (h) => void saved.push(h) });
    assert.equal(ok, 'ok');
    assert.deepEqual(saved, [laptop]);

    const down = await switchToHub(laptop, {
      call: async () => {
        throw new HubApiError(0, 'NETWORK_ERROR', 'x');
      },
      persist: async () => assert.fail('must not persist an unreachable PC'),
    });
    assert.equal(down, 'unreachable');
    assert.match(switchFailureText(laptop, down), /Laptop is not reachable/);
    assert.match(switchFailureText(laptop, 'unauthorized'), /scan the QR/);
  });

  it('probe passes the timeout through', async () => {
    let seen = 0;
    await probeHub(laptop, { timeoutMs: 1234, call: async (_h, t) => void (seen = t) });
    assert.equal(seen, 1234);
  });
});
