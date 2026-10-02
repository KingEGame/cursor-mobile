import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HUB_URL_HINTS, normalizeHubBaseUrl, isLoopbackHubUrl, resolvePairedHubBaseUrl } from './hub-url';

describe('normalizeHubBaseUrl', () => {
  it('trims and strips trailing slashes', () => {
    assert.equal(
      normalizeHubBaseUrl('  http://100.91.47.68:8787/  '),
      'http://100.91.47.68:8787',
    );
    assert.equal(normalizeHubBaseUrl('http://host:8787///'), 'http://host:8787');
  });

  it('returns empty for blank input', () => {
    assert.equal(normalizeHubBaseUrl(''), '');
    assert.equal(normalizeHubBaseUrl('   '), '');
  });
});

describe('resolvePairedHubBaseUrl', () => {
  it('keeps mesh URL when Hub baseUrlHint is loopback', () => {
    assert.equal(isLoopbackHubUrl('http://127.0.0.1:8787'), true);
    assert.equal(
      resolvePairedHubBaseUrl('http://100.91.47.68:8787', 'http://127.0.0.1:8787'),
      'http://100.91.47.68:8787',
    );
  });

  it('keeps the reachable URL the phone paired through over a MagicDNS hint', () => {
    assert.equal(
      resolvePairedHubBaseUrl(
        'http://100.91.47.68:8787',
        'http://kingwarpc.tail246b3f.ts.net:8787',
      ),
      'http://100.91.47.68:8787',
    );
  });

  it('falls back to the non-loopback hint when the phone paired via loopback', () => {
    assert.equal(
      resolvePairedHubBaseUrl('http://127.0.0.1:8787', 'http://100.108.160.99:8787'),
      'http://100.108.160.99:8787',
    );
  });
});

describe('HUB_URL_HINTS', () => {
  it('exposes Tailscale IPv4 and MagicDNS Hub URLs for this PC', () => {
    assert.equal(HUB_URL_HINTS.ipv4, 'http://100.108.160.99:8787');
    assert.equal(HUB_URL_HINTS.magicDns, 'http://kingwarpc-1.tail246b3f.ts.net:8787');
    assert.equal(HUB_URL_HINTS.placeholder, HUB_URL_HINTS.ipv4);
  });

  it('does not embed a remote CDP URL (AC-001-04 surface)', () => {
    const blob = JSON.stringify(HUB_URL_HINTS);
    assert.equal(blob.includes(':9222'), false);
    assert.equal(/cdp/i.test(blob), false);
  });
});
