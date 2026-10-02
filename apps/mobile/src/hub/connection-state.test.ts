import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  connectionStateLabel,
  deriveConnectionState,
} from './connection-state';
import { HubApiError, type HealthResponse } from './types';

function health(partial: Partial<HealthResponse> = {}): HealthResponse {
  return {
    ok: true,
    version: '0.1.0',
    apiVersion: '1',
    time: '2026-09-30T00:00:00.000Z',
    hub: { status: 'up', uptimeSec: 1 },
    cdp: {
      status: 'connected',
      urlConfigured: 'http://127.0.0.1:9222',
      lastAttachAt: null,
      error: null,
    },
    cursor: { status: 'running', windowsDetected: 1 },
    liveAdapter: {
      state: 'cdp_ok',
      extractorReady: true,
      sendMessageVerified: true,
      actions: { send_message: 'VERIFIED' },
    },
    workspace: {
      bound: true,
      workspaceId: 'ws_x',
      name: 'cursor_mobile',
      path: '/data/projects/cursor_mobile',
    },
    pairing: { required: true, devicesPaired: 1 },
    ...partial,
  };
}

describe('connection-state (AC-003-03 / AC-012-04)', () => {
  it('AC-003-03 missing pair → Unpaired with pair prompt copy', () => {
    const state = deriveConnectionState({
      hubBaseUrl: 'http://100.108.160.99:8787',
      deviceToken: null,
      health: null,
    });
    assert.equal(state, 'Unpaired');
    assert.match(connectionStateLabel(state), /not paired|pair code/i);
  });

  it('AC-003-03 401 / revoked → Revoked (re-pair)', () => {
    const state = deriveConnectionState({
      hubBaseUrl: 'http://100.108.160.99:8787',
      deviceToken: 'stale',
      health: health(),
      lastError: new HubApiError(401, 'UNAUTHORIZED', 'Bearer required'),
    });
    assert.equal(state, 'Revoked');
    assert.match(connectionStateLabel(state), /re-pair|revoked/i);
  });

  it('AC-012-04 Cursor not detected → CursorDown messaging', () => {
    const state = deriveConnectionState({
      hubBaseUrl: 'http://100.108.160.99:8787',
      deviceToken: 'tok',
      health: health({
        cursor: { status: 'not_detected', windowsDetected: 0 },
      }),
    });
    assert.equal(state, 'CursorDown');
    assert.match(connectionStateLabel(state), /Cursor not detected|open Cursor/i);
  });

  it('cursor_down / CDP disconnected → CDPOff without relaunch instructions', () => {
    const state = deriveConnectionState({
      hubBaseUrl: 'http://100.108.160.99:8787',
      deviceToken: 'tok',
      health: health({
        cdp: {
          status: 'error',
          urlConfigured: 'http://127.0.0.1:9222',
          lastAttachAt: null,
          error: 'fetch failed',
        },
        liveAdapter: {
          state: 'cursor_down',
          extractorReady: false,
          sendMessageVerified: true,
          actions: { send_message: 'VERIFIED' },
        },
      }),
    });
    assert.equal(state, 'CDPOff');
    const label = connectionStateLabel(state);
    assert.match(label, /Composer remoting offline|queues/i);
    assert.doesNotMatch(label, /start:cursor:cdp|remote-debugging-port|quit/i);
  });
});
