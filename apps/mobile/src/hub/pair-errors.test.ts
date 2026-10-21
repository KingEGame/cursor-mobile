import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isLoopbackHost, loopbackQrText, pairErrorText } from './pair-errors';
import { HubApiError } from './types';

describe('pairErrorText', () => {
  it('keeps the Hub explanation for an unknown code (restart / other PC)', () => {
    const err = new HubApiError(400, 'PAIR_CODE_INVALID', 'This QR is not known to Desk. Either the Hub restarted…', { reason: 'unknown_pair' });
    assert.equal(pairErrorText(err, 'Desk'), err.message);
  });

  it('names the PC for expired, used and throttled codes', () => {
    assert.match(pairErrorText(new HubApiError(410, 'PAIR_CODE_EXPIRED', 'x'), 'Laptop'), /expired.*Laptop/);
    assert.match(pairErrorText(new HubApiError(409, 'PAIR_CODE_USED', 'x'), 'Laptop'), /already used.*Laptop/);
    assert.match(pairErrorText(new HubApiError(429, 'RATE_LIMITED', 'Wait 30s'), 'Laptop'), /Wait 30s/);
  });

  it('turns transport failures into a Tailscale hint', () => {
    assert.match(pairErrorText(new HubApiError(0, 'NETWORK_ERROR', 'Network request failed'), null), /Tailscale/);
    assert.match(pairErrorText(new Error('Network request failed'), 'Desk'), /Cannot reach Desk/);
    assert.match(pairErrorText(new HubApiError(404, 'ROUTE_NOT_AVAILABLE', 'no'), 'Desk'), /not as a Cursor Mobile Hub/);
  });

  it('flags loopback QR hosts', () => {
    assert.equal(isLoopbackHost('127.0.0.1'), true);
    assert.equal(isLoopbackHost('localhost'), true);
    assert.equal(isLoopbackHost('100.108.160.99'), false);
    assert.match(loopbackQrText('Desk'), /only Desk can reach/);
  });
});
