import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPairTokenInjectDeepLink,
  isPairTokenInject,
  parsePairDeepLink,
  softDecode,
} from './pair-deep-link';

describe('softDecode', () => {
  it('decodes percent-encoding once', () => {
    assert.equal(softDecode('http%3A%2F%2F100.108.160.99%3A8787'), 'http://100.108.160.99:8787');
  });

  it('returns raw value when decode throws', () => {
    assert.equal(softDecode('%E0%A4%A'), '%E0%A4%A');
  });
});

describe('parsePairDeepLink', () => {
  it('returns null for unrelated schemes', () => {
    assert.equal(parsePairDeepLink('https://example.com/pair?code=1'), null);
    assert.equal(parsePairDeepLink('cursor-companion://health'), null);
  });

  it('parses token-inject query with multiple & params (adb UAT)', () => {
    const url =
      'cursor-companion://pair?hubUrl=http%3A%2F%2F100.108.160.99%3A8787' +
      '&deviceToken=tok_abc123&deviceId=dev_xyz&hubDisplayName=Desk%20PC&auto=1';
    const params = parsePairDeepLink(url);
    assert.ok(params);
    assert.equal(params.hubUrl, 'http://100.108.160.99:8787');
    assert.equal(params.deviceToken, 'tok_abc123');
    assert.equal(params.deviceId, 'dev_xyz');
    assert.equal(params.hubDisplayName, 'Desk PC');
    assert.equal(params.auto, '1');
    assert.equal(isPairTokenInject(params), true);
  });

  it('parses code + host QR style', () => {
    const params = parsePairDeepLink(
      'cursor-companion://pair?host=100.108.160.99&port=8787&code=482913&pairId=pair_abc',
    );
    assert.ok(params);
    assert.equal(params.host, '100.108.160.99');
    assert.equal(params.port, '8787');
    assert.equal(params.code, '482913');
    assert.equal(params.pairId, 'pair_abc');
    assert.equal(isPairTokenInject(params), false);
  });

  it('parses host+port token-inject (adb-safe, no nested http://)', () => {
    const url =
      'cursor-companion://pair?host=100.108.160.99&port=8787' +
      '&deviceToken=tok_abc123&deviceId=dev_xyz&hubDisplayName=Desk%20PC&auto=1';
    const params = parsePairDeepLink(url);
    assert.ok(params);
    assert.equal(params.host, '100.108.160.99');
    assert.equal(params.port, '8787');
    assert.equal(params.deviceToken, 'tok_abc123');
    assert.equal(params.deviceId, 'dev_xyz');
    assert.equal(isPairTokenInject(params), true);
  });

  it('buildPairTokenInjectDeepLink omits hubUrl', () => {
    const url = buildPairTokenInjectDeepLink({
      host: '100.108.160.99',
      port: '8787',
      deviceToken: 'tok_x',
      deviceId: 'dev_y',
      hubDisplayName: 'Desk PC',
    });
    assert.match(url, /^cursor-companion:\/\/pair\?/);
    assert.equal(url.includes('hubUrl='), false);
    assert.equal(url.toLowerCase().includes('http'), false);
    const params = parsePairDeepLink(url);
    assert.equal(isPairTokenInject(params), true);
    assert.equal(params?.host, '100.108.160.99');
  });

  it('parses path form pair?query used by getStateFromPath', () => {
    const params = parsePairDeepLink(
      'pair?hubUrl=http://100.108.160.99:8787&deviceToken=t1&deviceId=d1',
    );
    assert.ok(params);
    assert.equal(params.deviceToken, 't1');
    assert.equal(params.deviceId, 'd1');
  });

  it('accepts bare pair path', () => {
    assert.deepEqual(parsePairDeepLink('cursor-companion://pair'), {});
    assert.deepEqual(parsePairDeepLink('pair'), {});
  });
});
