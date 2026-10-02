/**
 * Phase 4 — offline outbound queue helpers (FR-091 / NFR-OFF-03)
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canFlushOutbound,
  deriveConnectionState,
  isReadyForFlush,
  type CompanionConnectionState,
} from '../hub/connection-state';
import { HubApiError, type HealthResponse } from '../hub/types';
import {
  createMemoryQueueStorage,
  enqueueApproval,
  enqueueMessage,
  flushOutboundQueue,
  OutboundQueue,
  pendingCount,
} from './outbound-queue';

const healthy: HealthResponse = {
  ok: true,
  version: '0.1.0',
  apiVersion: '1',
  time: '2026-09-25T18:00:00.000Z',
  hub: { status: 'up', uptimeSec: 10 },
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
    selectorPack: 'cursor-ui@test',
  },
  workspace: {
    bound: true,
    workspaceId: 'ws_1',
    name: 'proj',
    path: '/tmp/proj',
  },
  pairing: { required: true, devicesPaired: 1 },
};

describe('outbound queue helpers', () => {
  it('enqueues message with idempotency key', () => {
    const { items, item } = enqueueMessage([], {
      sessionId: 'sess_1',
      content: 'hello',
      idempotencyKey: 'msg-fixed-key',
    });
    assert.equal(items.length, 1);
    assert.equal(item.kind, 'message');
    assert.equal(item.idempotencyKey, 'msg-fixed-key');
    assert.equal(item.status, 'pending');
    assert.equal(pendingCount(items), 1);
  });

  it('enqueues user decision only — never invents approve', () => {
    const { item: deny } = enqueueApproval([], {
      sessionId: 'sess_1',
      approvalId: 'apr_1',
      decision: 'deny',
    });
    assert.equal(deny.decision, 'deny');
    assert.match(deny.idempotencyKey, /apr-deny/);

    const { items, item: again } = enqueueApproval([deny], {
      sessionId: 'sess_1',
      approvalId: 'apr_1',
      decision: 'approve',
    });
    // First decision wins — no silent flip to approve
    assert.equal(items.length, 1);
    assert.equal(again.decision, 'deny');
  });

  it('flush skipped when not Ready', async () => {
    const { items } = enqueueMessage([], {
      sessionId: 'sess_1',
      content: 'offline',
    });
    let called = 0;
    const result = await flushOutboundQueue(items, {
      isReady: false,
      postMessage: async () => {
        called += 1;
      },
      postApproval: async () => {
        called += 1;
      },
    });
    assert.equal(result.skipped, true);
    assert.equal(called, 0);
    assert.equal(result.items.length, 1);
  });

  it('flush delivers once with same idempotency key', async () => {
    const { items, item } = enqueueMessage([], {
      sessionId: 'sess_1',
      content: 'ping',
      idempotencyKey: 'msg-once',
    });
    const keys: string[] = [];
    const result = await flushOutboundQueue(items, {
      isReady: true,
      postMessage: async (_sid, _body, key) => {
        keys.push(key);
      },
      postApproval: async () => {
        throw new Error('should not approve');
      },
    });
    assert.deepEqual(keys, ['msg-once']);
    assert.deepEqual(result.flushedIds, [item.id]);
    assert.equal(result.items.length, 0);
  });

  it('flush idempotency: second flush after success does not re-POST', async () => {
    const { items } = enqueueMessage([], {
      sessionId: 'sess_1',
      content: 'once',
      idempotencyKey: 'msg-idem-1',
    });
    let posts = 0;
    const deps = {
      isReady: true,
      postMessage: async () => {
        posts += 1;
      },
      postApproval: async () => {
        throw new Error('no approval');
      },
    };
    const first = await flushOutboundQueue(items, deps);
    assert.equal(posts, 1);
    assert.equal(first.items.length, 0);
    const second = await flushOutboundQueue(first.items, deps);
    assert.equal(posts, 1);
    assert.equal(second.flushedIds.length, 0);
    assert.equal(second.skipped, false);
  });

  it('failed item re-flush reuses the same Idempotency-Key (Hub-safe)', async () => {
    const { items, item } = enqueueMessage([], {
      sessionId: 'sess_1',
      content: 'retry',
      idempotencyKey: 'msg-retry-stable',
    });
    const keys: string[] = [];
    let attempt = 0;
    const first = await flushOutboundQueue(items, {
      isReady: true,
      postMessage: async (_sid, _body, key) => {
        keys.push(key);
        attempt += 1;
        if (attempt === 1) throw new Error('network');
      },
      postApproval: async () => {
        throw new Error('no approval');
      },
    });
    assert.deepEqual(keys, ['msg-retry-stable']);
    assert.equal(first.failedIds[0], item.id);
    assert.equal(first.items[0]?.status, 'failed');

    const second = await flushOutboundQueue(first.items, {
      isReady: true,
      postMessage: async (_sid, _body, key) => {
        keys.push(key);
      },
      postApproval: async () => {
        throw new Error('no approval');
      },
    });
    assert.deepEqual(keys, ['msg-retry-stable', 'msg-retry-stable']);
    assert.deepEqual(second.flushedIds, [item.id]);
    assert.equal(second.items.length, 0);
  });

  it('flush approvals reuses stored decision (no auto-approve)', async () => {
    const { items } = enqueueApproval([], {
      sessionId: 'sess_1',
      approvalId: 'apr_9',
      decision: 'deny',
      idempotencyKey: 'apr-deny-9',
    });
    const seen: string[] = [];
    await flushOutboundQueue(items, {
      isReady: true,
      postMessage: async () => {
        throw new Error('no message');
      },
      postApproval: async (_sid, body, key) => {
        seen.push(`${body.decision}:${key}`);
      },
    });
    assert.deepEqual(seen, ['deny:apr-deny-9']);
  });

  it('OutboundQueue class persists via storage', async () => {
    const storage = createMemoryQueueStorage();
    const q = new OutboundQueue(storage);
    await q.enqueueMessage({ sessionId: 's', content: 'a' });
    const q2 = new OutboundQueue(storage);
    assert.equal(await q2.pendingCount(), 1);
    await q2.flush({
      isReady: true,
      postMessage: async () => undefined,
      postApproval: async () => undefined,
    });
    assert.equal(await q2.pendingCount(), 0);
  });
});

describe('connection states (NFR-OFF-01)', () => {
  it('maps health + errors to distinct states', () => {
    const base = {
      hubBaseUrl: 'http://pc.tailnet.ts.net:8787',
      deviceToken: 'tok',
      health: healthy,
    };
    assert.equal(deriveConnectionState(base), 'Ready');

    assert.equal(
      deriveConnectionState({
        ...base,
        health: {
          ...healthy,
          cdp: { ...healthy.cdp, status: 'disconnected' },
        },
      }),
      'CDPOff',
    );

    assert.equal(
      deriveConnectionState({
        ...base,
        health: {
          ...healthy,
          cursor: { status: 'not_detected', windowsDetected: 0 },
        },
      }),
      'CursorDown',
    );

    // AC-004-04: Hub reports unhealthy → HubDown (distinct from TailscaleDown)
    assert.equal(
      deriveConnectionState({
        ...base,
        health: { ...healthy, ok: false },
      }),
      'HubDown',
    );

    assert.equal(
      deriveConnectionState({
        ...base,
        lastError: new HubApiError(0, 'NETWORK_ERROR', 'down'),
      }),
      'TailscaleDown',
    );

    assert.equal(
      deriveConnectionState({
        ...base,
        lastError: new HubApiError(401, 'DEVICE_REVOKED', 'revoked'),
      }),
      'Revoked',
    );

    assert.equal(
      deriveConnectionState({
        hubBaseUrl: 'http://pc:8787',
        deviceToken: null,
        health: null,
      }),
      'Unpaired',
    );

    assert.equal(
      deriveConnectionState({ ...base, queuedCount: 2 }),
      'Queuing',
    );

    assert.equal(
      deriveConnectionState({
        ...base,
        health: {
          ...healthy,
          liveAdapter: {
            state: 'extractor_stale',
            extractorReady: false,
          },
        },
      }),
      'SenderBlocked',
    );

    assert.equal(
      deriveConnectionState({
        ...base,
        health: {
          ...healthy,
          liveAdapter: {
            state: 'extractor_stale',
            extractorReady: false,
            sendMessageVerified: true,
            actions: { send_message: 'VERIFIED', approve: 'CANDIDATE' },
          },
        },
      }),
      'Ready',
    );
  });

  it('canFlushOutbound only when Hub path Ready', () => {
    assert.equal(
      canFlushOutbound({
        hubBaseUrl: 'http://pc:8787',
        deviceToken: 't',
        health: healthy,
        queuedCount: 3,
      }),
      true,
    );
    assert.equal(
      canFlushOutbound({
        hubBaseUrl: 'http://pc:8787',
        deviceToken: 't',
        health: {
          ...healthy,
          cdp: { ...healthy.cdp, status: 'error' },
        },
      }),
      false,
    );
    assert.equal(
      canFlushOutbound({
        hubBaseUrl: 'http://pc:8787',
        deviceToken: 't',
        health: {
          ...healthy,
          liveAdapter: {
            state: 'extractor_stale',
            extractorReady: false,
          },
        },
      }),
      false,
    );
    const queuing: CompanionConnectionState = 'Queuing';
    assert.equal(isReadyForFlush(queuing), true);
    assert.equal(isReadyForFlush('TailscaleDown'), false);
  });
});
