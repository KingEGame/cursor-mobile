import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  fitKnownHubs,
  parseKnownHubs,
  removeKnownHub,
  upsertKnownHub,
  type KnownHub,
} from './known-hubs-core';

const hub = (url: string, name: string, hubId?: string): KnownHub => ({
  hubBaseUrl: url,
  deviceToken: `t-${name}`,
  deviceId: `d-${name}`,
  hubDisplayName: name,
  lastUsedAt: '2026-10-02T00:00:00.000Z',
  ...(hubId ? { hubId } : {}),
});

describe('known hubs', () => {
  it('puts the latest PC first and replaces the same URL', () => {
    let list = upsertKnownHub([], hub('http://100.1.1.1:8787', 'Desk'));
    list = upsertKnownHub(list, hub('http://100.2.2.2:8787', 'Laptop'));
    list = upsertKnownHub(list, { ...hub('http://100.1.1.1:8787/', 'Desk'), deviceToken: 'new' });
    assert.deepEqual(list.map((h) => h.hubDisplayName), ['Desk', 'Laptop']);
    assert.equal(list[0]!.deviceToken, 'new');
  });

  it('matches the same PC by hubId when its Tailscale address changed', () => {
    let list = upsertKnownHub([], hub('http://100.1.1.1:8787', 'Desk', 'abc'));
    list = upsertKnownHub(list, hub('http://100.9.9.9:8787', 'Desk', 'abc'));
    assert.equal(list.length, 1);
    assert.equal(list[0]!.hubBaseUrl, 'http://100.9.9.9:8787');
    // A different PC on the old address is a new entry, not a replacement.
    list = upsertKnownHub(list, hub('http://100.9.9.9:8787', 'Other', 'zzz'));
    assert.deepEqual(list.map((h) => h.hubDisplayName), ['Other', 'Desk']);
  });

  it('keeps the serialized list under the secure-store limit by dropping the oldest PCs', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      hub(`http://100.1.1.${i}:8787`, `PC number ${i} with a long name`, `id${i}`.padEnd(12, 'x')),
    ).map((h) => ({ ...h, deviceToken: 'k'.repeat(43) }));
    const kept = fitKnownHubs(many, 900);
    assert.ok(kept.length < many.length && kept.length >= 1);
    assert.ok(Buffer.byteLength(JSON.stringify(kept), 'utf8') <= 900);
    assert.equal(kept[0]!.hubDisplayName, many[0]!.hubDisplayName);
    assert.equal(fitKnownHubs(many, 10).length, 1);
  });

  it('removes by URL and survives bad stored data', () => {
    const list = [hub('http://100.1.1.1:8787', 'Desk'), hub('http://100.2.2.2:8787', 'Laptop')];
    assert.deepEqual(removeKnownHub(list, 'http://100.2.2.2:8787').map((h) => h.hubDisplayName), ['Desk']);
    assert.deepEqual(parseKnownHubs('nope'), []);
    assert.deepEqual(parseKnownHubs('[{"hubBaseUrl":1}]'), []);
  });
});
