import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseKnownHubs, removeKnownHub, upsertKnownHub, type KnownHub } from './known-hubs-core';

const hub = (url: string, name: string): KnownHub => ({
  hubBaseUrl: url,
  deviceToken: `t-${name}`,
  deviceId: `d-${name}`,
  hubDisplayName: name,
  lastUsedAt: '2026-10-02T00:00:00.000Z',
});

describe('known hubs', () => {
  it('puts the latest PC first and replaces the same URL', () => {
    let list = upsertKnownHub([], hub('http://100.1.1.1:8787', 'Desk'));
    list = upsertKnownHub(list, hub('http://100.2.2.2:8787', 'Laptop'));
    list = upsertKnownHub(list, { ...hub('http://100.1.1.1:8787/', 'Desk'), deviceToken: 'new' });
    assert.deepEqual(list.map((h) => h.hubDisplayName), ['Desk', 'Laptop']);
    assert.equal(list[0]!.deviceToken, 'new');
  });

  it('removes by URL and survives bad stored data', () => {
    const list = [hub('http://100.1.1.1:8787', 'Desk'), hub('http://100.2.2.2:8787', 'Laptop')];
    assert.deepEqual(removeKnownHub(list, 'http://100.2.2.2:8787').map((h) => h.hubDisplayName), ['Desk']);
    assert.deepEqual(parseKnownHubs('nope'), []);
    assert.deepEqual(parseKnownHubs('[{"hubBaseUrl":1}]'), []);
  });
});
