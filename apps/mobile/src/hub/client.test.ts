import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createHubClient,
  HubClient,
  formatApprovalError,
  formatSenderError,
  isLivePathDegraded,
  isSenderMutationsBlocked,
  livePathDegradedReason,
  shouldQueueSenderFailure,
} from './client';
import { formatRelativeTime, shortPath } from './format';
import { createIdempotencyKey } from './idempotency';
import {
  HubApiError,
  normalizeCreateSessionResponse,
  type HealthResponse,
  type WorkspaceResponse,
} from './types';
import { buildWsUrl } from './ws';

const sampleHealth: HealthResponse = {
  ok: true,
  version: '0.0.0-designed',
  apiVersion: '1',
  time: '2026-09-25T18:00:00.000Z',
  hub: { status: 'up', uptimeSec: 10 },
  cdp: {
    status: 'connected',
    urlConfigured: 'http://127.0.0.1:9222',
    lastAttachAt: '2026-09-25T17:59:50.000Z',
    error: null,
  },
  cursor: { status: 'running', windowsDetected: 1 },
  workspace: {
    bound: true,
    workspaceId: 'ws_abc',
    name: 'cursor_mobile',
    path: '/data/projects/cursor_mobile',
  },
  pairing: { required: true, devicesPaired: 1 },
};

const emptyWorkspace: WorkspaceResponse = {
  workspaceId: null,
  name: null,
  path: null,
  roots: [],
  windowId: null,
  windows: [],
  updatedAt: '2026-09-25T17:59:00.000Z',
  emptyReason: 'NO_FOLDER_OPEN',
};

describe('HubClient', () => {
  it('rejects empty baseUrl', () => {
    assert.throws(() => createHubClient({ baseUrl: '  ' }), /baseUrl/);
  });

  it('GET /v1/health without Authorization', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = new HubClient({
      baseUrl: 'http://pc.tailnet.ts.net:8787/',
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify(sampleHealth), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    const health = await client.getHealth();
    assert.equal(health.ok, true);
    assert.equal(health.cdp.urlConfigured, 'http://127.0.0.1:9222');
    assert.equal(calls[0]?.url, 'http://pc.tailnet.ts.net:8787/v1/health');
    assert.equal(calls[0]?.init?.method, 'GET');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, undefined);
  });

  it('AC-003-04 / AC-004-04: request timeout → NETWORK_ERROR (no hang)', async () => {
    const client = new HubClient({
      baseUrl: 'http://199.199.199.199:8787',
      timeoutMs: 50,
      fetchImpl: async (_input, init) => {
        await new Promise<never>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            return;
          }
          signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
        return new Response('unreachable', { status: 500 });
      },
    });
    await assert.rejects(
      () => client.getHealth(),
      (err: unknown) => {
        assert.ok(err instanceof HubApiError);
        assert.equal(err.code, 'NETWORK_ERROR');
        assert.match(err.message, /timed out after 50ms|Cannot reach Hub/);
        return true;
      },
    );
  });

  it('AC-001-04: HubClient never dials CDP (:9222) — Hub Tailscale URL only', async () => {
    const urls: string[] = [];
    const client = new HubClient({
      baseUrl: 'http://100.91.47.68:8787',
      deviceToken: 'tok',
      fetchImpl: async (input) => {
        urls.push(String(input));
        return new Response(JSON.stringify(sampleHealth), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    await client.getHealth();
    await client.getWorkspace();
    for (const url of urls) {
      assert.equal(url.includes(':9222'), false, `must not dial CDP: ${url}`);
      assert.match(url, /^http:\/\/100\.91\.47\.68:8787\/v1\//);
    }
  });

  it('GET /v1/workspace sends Bearer and maps empty workspace', async () => {
    const client = new HubClient({
      baseUrl: 'http://pc.tailnet.ts.net:8787',
      deviceToken: 'tok_test',
      fetchImpl: async (input, init) => {
        assert.match(String(input), /\/v1\/workspace$/);
        const headers = init?.headers as Record<string, string>;
        assert.equal(headers.Authorization, 'Bearer tok_test');
        return new Response(JSON.stringify(emptyWorkspace), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    const ws = await client.getWorkspace();
    assert.equal(ws.workspaceId, null);
    assert.equal(ws.emptyReason, 'NO_FOLDER_OPEN');
  });

  it('maps HTTP errors to HubApiError', async () => {
    const client = new HubClient({
      baseUrl: 'http://pc.tailnet.ts.net:8787',
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { code: 'PAIR_CODE_INVALID', message: 'bad' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    await assert.rejects(
      () =>
        client.pairComplete({
          code: '000000',
          deviceName: 'test',
          platform: 'android',
          appVersion: '0.1.0',
        }),
      (err: unknown) => {
        assert.ok(err instanceof HubApiError);
        assert.equal(err.status, 400);
        assert.equal(err.code, 'PAIR_CODE_INVALID');
        return true;
      },
    );
  });

  it('listSessions tolerates missing route with empty list', async () => {
    const client = new HubClient({
      baseUrl: 'http://pc.tailnet.ts.net:8787',
      deviceToken: 'tok',
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
    const list = await client.listSessions('ws_abc', { tolerateMissing: true });
    assert.equal(list.workspaceId, 'ws_abc');
    assert.deepEqual(list.items, []);
  });

  it('listSessions throws ROUTE_NOT_AVAILABLE when not tolerated', async () => {
    const client = new HubClient({
      baseUrl: 'http://pc.tailnet.ts.net:8787',
      deviceToken: 'tok',
      fetchImpl: async () => new Response('missing', { status: 404 }),
    });
    await assert.rejects(
      () => client.listSessions('ws_abc', { tolerateMissing: false }),
      (err: unknown) => {
        assert.ok(err instanceof HubApiError);
        assert.equal(err.code, 'ROUTE_NOT_AVAILABLE');
        assert.equal(err.isRouteMissing, true);
        return true;
      },
    );
  });

  it('listSessions requests mode=history with limit for History tab', async () => {
    const urls: string[] = [];
    const client = new HubClient({
      baseUrl: 'http://hub:8787',
      deviceToken: 'tok',
      fetchImpl: async (input) => {
        urls.push(String(input));
        return new Response(
          JSON.stringify({
            workspaceId: 'ws_abc',
            items: [
              {
                id: 'hist_1',
                workspaceId: 'ws_abc',
                mode: 'history',
                title: 'Past',
                preview: 'hello',
                model: null,
                updatedAt: '2026-09-25T18:00:00.000Z',
                createdAt: '2026-09-25T17:00:00.000Z',
                pendingApprovals: 0,
              },
            ],
            nextCursor: null,
            history: {
              ok: true,
              extractorStale: false,
              sessionCountForBind: 1,
              lastScanAt: '2026-09-25T18:00:00.000Z',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    const list = await client.listSessions('ws_abc', {
      mode: 'history',
      limit: 100,
      tolerateMissing: false,
    });
    assert.match(urls[0]!, /mode=history/);
    assert.match(urls[0]!, /limit=100/);
    assert.equal(list.items[0]?.mode, 'history');
    assert.equal(list.history?.sessionCountForBind, 1);
  });

  it('getSessionMessages and openOnPc hit history continue paths', async () => {
    const urls: string[] = [];
    const client = new HubClient({
      baseUrl: 'http://hub:8787',
      deviceToken: 'tok',
      fetchImpl: async (input, init) => {
        urls.push(`${init?.method ?? 'GET'} ${String(input)}`);
        if (String(input).includes('/messages')) {
          return new Response(
            JSON.stringify({
              sessionId: 'hist_1',
              mode: 'history',
              messages: [
                {
                  id: 'm1',
                  role: 'user',
                  content: 'hi',
                  createdAt: '2026-09-25T18:00:00.000Z',
                },
              ],
              truncated: false,
              nextCursor: null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            id: 'live_1',
            sessionId: 'live_1',
            workspaceId: 'ws_abc',
            mode: 'live',
            previousMode: 'history',
            historySessionId: 'hist_1',
            openedAt: '2026-09-25T18:01:00.000Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    const msgs = await client.getSessionMessages('hist_1', { limit: 50 });
    assert.equal(msgs.messages[0]?.content, 'hi');
    const opened = await client.openOnPc('hist_1');
    assert.equal(opened.mode, 'live');
    assert.equal(opened.previousMode, 'history');
    assert.match(urls[0]!, /GET .*\/sessions\/hist_1\/messages\?limit=50$/);
    assert.match(urls[1]!, /POST .*\/sessions\/hist_1\/open-on-pc$/);
  });

  it('createSession normalizes Phase 0 stub sessionId', async () => {
    const client = new HubClient({
      baseUrl: 'http://pc.tailnet.ts.net:8787',
      deviceToken: 'tok',
      fetchImpl: async (_input, init) => {
        const headers = init?.headers as Record<string, string>;
        assert.ok(headers['Idempotency-Key']);
        return new Response(
          JSON.stringify({
            sessionId: 'sess_phase0_stub',
            workspaceId: 'ws_abc',
            mode: 'live',
            note: 'stub',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    const created = await client.createSession({
      workspaceId: 'ws_abc',
      model: 'composer-1',
    });
    assert.equal('queued' in created && created.queued === true, false);
    assert.equal('id' in created ? created.id : null, 'sess_phase0_stub');
    assert.equal('note' in created ? created.note : null, 'stub');
  });

  it('createSession accepts Hub 202 queued body', async () => {
    const client = new HubClient({
      baseUrl: 'http://pc.tailnet.ts.net:8787',
      deviceToken: 'tok',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            queued: true,
            queueId: 'q_create_test',
            status: 'pending',
            workspaceId: 'ws_abc',
            model: 'composer',
            attachments: ['a.ts'],
            prompt: 'queued prompt',
            promptLen: 13,
            agentMode: 'agent',
            note: 'Queued until cdp_ok',
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } },
        ),
    });
    const created = await client.createSession({
      workspaceId: 'ws_abc',
      model: 'composer',
      prompt: 'queued prompt',
    });
    assert.equal('queued' in created && created.queued, true);
    assert.equal('queueId' in created ? created.queueId : null, 'q_create_test');
  });

  it('postApproval sends Idempotency-Key and decision', async () => {
    const client = new HubClient({
      baseUrl: 'http://hub:8787',
      deviceToken: 'tok',
      fetchImpl: async (input, init) => {
        assert.match(String(input), /\/v1\/sessions\/sess_1\/approvals$/);
        const headers = init?.headers as Record<string, string>;
        assert.ok(headers['Idempotency-Key']);
        const body = JSON.parse(String(init?.body));
        assert.equal(body.approvalId, 'apr_1');
        assert.equal(body.decision, 'deny');
        return new Response(
          JSON.stringify({
            approvalId: 'apr_1',
            sessionId: 'sess_1',
            decision: 'deny',
            status: 'applied',
            appliedAt: '2026-09-25T18:00:00.000Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    const res = await client.postApproval('sess_1', {
      approvalId: 'apr_1',
      decision: 'deny',
    });
    assert.equal(res.decision, 'deny');
  });

  it('getWorkspaceModels and getWorkspaceFiles use query paths', async () => {
    const urls: string[] = [];
    const client = new HubClient({
      baseUrl: 'http://hub:8787',
      deviceToken: 'tok',
      fetchImpl: async (input) => {
        urls.push(String(input));
        if (String(input).includes('/models')) {
          return new Response(
            JSON.stringify({
              workspaceId: 'ws',
              models: [{ id: 'm1', label: 'M', available: true, default: true }],
              source: 'cursor_local',
              updatedAt: '2026-09-25T18:00:00.000Z',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({ workspaceId: 'ws', items: [], nextCursor: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    await client.getWorkspaceModels(true);
    await client.getWorkspaceFiles({ q: 'hub', limit: 10 });
    assert.match(urls[0]!, /\/v1\/workspace\/models\?refresh=true$/);
    assert.match(urls[1]!, /\/v1\/workspace\/files\?q=hub&limit=10$/);
  });
});

describe('helpers', () => {
  it('normalizeCreateSessionResponse prefers id over sessionId', () => {
    const a = normalizeCreateSessionResponse({
      id: 'sess_a',
      sessionId: 'sess_b',
      workspaceId: 'ws',
      model: 'm',
    });
    assert.equal('queued' in a && a.queued === true, false);
    assert.equal('id' in a ? a.id : null, 'sess_a');
  });

  it('normalizeCreateSessionResponse parses queued 202 body', () => {
    const q = normalizeCreateSessionResponse({
      queued: true,
      queueId: 'q_create_x',
      status: 'pending',
      workspaceId: 'ws',
      model: 'composer',
      attachments: [],
      prompt: 'p',
      promptLen: 1,
      agentMode: null,
    });
    assert.equal('queued' in q && q.queued, true);
    assert.equal('queueId' in q ? q.queueId : null, 'q_create_x');
  });

  it('formatRelativeTime and shortPath', () => {
    const now = Date.parse('2026-09-25T18:00:00.000Z');
    assert.equal(formatRelativeTime('2026-09-25T17:59:30.000Z', now), 'just now');
    assert.equal(formatRelativeTime('2026-09-25T17:00:00.000Z', now), '1h ago');
    assert.equal(shortPath('docs/architecture/AGENT-CONTEXT.md', 20).startsWith('…'), true);
  });

  it('createIdempotencyKey prefixes safely', () => {
    const key = createIdempotencyKey('create-session');
    assert.match(key, /^create-session-/);
  });

  it('buildWsUrl switches scheme and adds token', () => {
    assert.equal(
      buildWsUrl('http://pc.tailnet.ts.net:8787', 'tok'),
      'ws://pc.tailnet.ts.net:8787/v1/ws?access_token=tok',
    );
    assert.equal(
      buildWsUrl('https://pc.tailnet.ts.net:8787'),
      'wss://pc.tailnet.ts.net:8787/v1/ws',
    );
  });

  it('isLivePathDegraded detects CDP/cursor issues', () => {
    assert.equal(isLivePathDegraded(sampleHealth), false);
    assert.equal(
      isLivePathDegraded({
        ...sampleHealth,
        cdp: { ...sampleHealth.cdp, status: 'disconnected' },
      }),
      true,
    );
    assert.match(
      livePathDegradedReason({
        ...sampleHealth,
        cdp: { ...sampleHealth.cdp, status: 'error', error: 'timeout' },
      }),
      /Sender blocked.*CDP/i,
    );
  });

  it('isLivePathDegraded / formatSenderError for extractor_stale', () => {
    const stale: HealthResponse = {
      ...sampleHealth,
      liveAdapter: {
        state: 'extractor_stale',
        extractorReady: false,
        selectorPack: 'cursor-ui@2026.09-candidate',
      },
    };
    assert.equal(isLivePathDegraded(stale), true);
    assert.equal(isSenderMutationsBlocked(stale), true);
    assert.match(livePathDegradedReason(stale), /Sender blocked.*selectors/i);

    const sendVerifiedPartial: HealthResponse = {
      ...sampleHealth,
      liveAdapter: {
        state: 'extractor_stale',
        extractorReady: false,
        selectorPack: 'cursor-ui@2026.09-candidate',
        sendMessageVerified: true,
        actions: {
          send_message: 'VERIFIED',
          approve: 'CANDIDATE',
          deny: 'CANDIDATE',
        },
      },
    };
    assert.equal(isSenderMutationsBlocked(sendVerifiedPartial), false);
    assert.equal(isLivePathDegraded(sendVerifiedPartial), false);
    assert.match(livePathDegradedReason(sendVerifiedPartial), /Send path ready/i);

    const err = new HubApiError(503, 'EXTRACTOR_STALE', 'not verified', {
      action: 'send_message',
      actionStatus: 'CANDIDATE',
    });
    assert.match(formatSenderError(err), /send_message.*CANDIDATE/i);
    assert.equal(shouldQueueSenderFailure(err), false);
    assert.equal(
      shouldQueueSenderFailure(new HubApiError(503, 'CDP_UNAVAILABLE', 'down')),
      true,
    );

    const aprErr = new HubApiError(
      503,
      'EXTRACTOR_STALE',
      'Cannot click deny — deny selectors not VERIFIED',
      { action: 'deny', actionStatus: 'CANDIDATE' },
    );
    assert.match(formatApprovalError(aprErr), /Approve\/Deny blocked.*deny.*CANDIDATE/i);
    assert.match(formatApprovalError(aprErr), /fail-closed/i);
  });
});
