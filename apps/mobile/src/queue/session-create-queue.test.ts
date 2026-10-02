/**
 * Unit tests — New-session create queue UI helpers
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HealthResponse } from '../hub/types';
import {
  createQueueBannerText,
  createQueueStatusFromHealth,
  drainedSessionIdFromHealth,
  isHubQueuedCreate,
} from './session-create-queue';

const baseHealth: HealthResponse = {
  ok: true,
  version: '0.1.0',
  apiVersion: '1',
  time: '2026-09-30T00:00:00.000Z',
  hub: { status: 'up', uptimeSec: 1 },
  cdp: {
    status: 'error',
    urlConfigured: 'http://127.0.0.1:9222',
    lastAttachAt: null,
    error: 'down',
  },
  cursor: { status: 'not_detected', windowsDetected: 0 },
  liveAdapter: { state: 'cursor_down', extractorReady: false },
  workspace: {
    bound: true,
    workspaceId: 'ws_1',
    name: 'proj',
    path: '/tmp/proj',
  },
  pairing: { required: true, devicesPaired: 1 },
};

describe('session-create-queue UI helpers', () => {
  it('detects Hub 202 queued body', () => {
    assert.equal(
      isHubQueuedCreate({
        queued: true,
        queueId: 'q_create_1',
        status: 'pending',
        workspaceId: 'ws_1',
        model: 'composer',
        attachments: [],
        prompt: 'hi',
        promptLen: 2,
        agentMode: 'agent',
      }),
      true,
    );
    assert.equal(isHubQueuedCreate({ id: 'sess_1' }), false);
  });

  it('surfaces Queuing when Hub pending and CDP down', () => {
    const health: HealthResponse = {
      ...baseHealth,
      sessionCreateQueue: {
        pending: 1,
        items: [],
        lastDrained: null,
      },
    };
    assert.equal(createQueueStatusFromHealth(health, false), 'queuing');
    assert.match(
      createQueueBannerText('queuing') ?? '',
      /Queuing.*Hub accepted|Composer remoting/i,
    );
  });

  it('surfaces Retrying when pending and cdp_ok', () => {
    const health: HealthResponse = {
      ...baseHealth,
      cdp: {
        status: 'connected',
        urlConfigured: 'http://127.0.0.1:9222',
        lastAttachAt: null,
        error: null,
      },
      cursor: { status: 'running', windowsDetected: 1 },
      liveAdapter: { state: 'cdp_ok', extractorReady: true },
      sessionCreateQueue: {
        pending: 1,
        items: [],
        lastDrained: null,
      },
    };
    assert.equal(createQueueStatusFromHealth(health, false), 'retrying');
    assert.match(createQueueBannerText('retrying') ?? '', /Retrying/);
  });

  it('reads drained session id from health', () => {
    const health: HealthResponse = {
      ...baseHealth,
      sessionCreateQueue: {
        pending: 0,
        items: [],
        lastDrained: {
          at: '2026-09-30T00:00:00.000Z',
          sessionId: 'sess_live_drained',
          queueId: 'q_create_1',
          ok: true,
        },
      },
    };
    assert.equal(drainedSessionIdFromHealth(health), 'sess_live_drained');
    assert.equal(createQueueStatusFromHealth(health, false), 'idle');
  });
});
