import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BridgeClient, BridgeError, normalizeBaseUrl, wsUrl } from './client';
import { describeError, parsePairPayload } from './errors';
import { buildTranscript, relativeTime, sessionTitle, toolsLabel } from './format';
import {
  applyEvent,
  emptyMirror,
  enqueue,
  markOutbox,
  mergeMessages,
  outboxFor,
  setMessages,
  setSessions,
  type MirrorState,
} from './mirror';
import { helloFrame } from './socket';
import { addressKind, mergeAddresses, pickBest, pool, rankAddresses, subnetHosts } from './network';
import { liveFor, stripCursor } from './mirror';
import type { Message, Session } from './types';

const msg = (id: number, over: Partial<Message> = {}): Message => ({
  id,
  sessionId: 's1',
  role: 'assistant',
  content: `m${id}`,
  toolName: null,
  toolCalls: null,
  createdAt: new Date(1_800_000_000_000 + id * 1000).toISOString(),
  finishReason: null,
  ...over,
});

const sess = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  source: 'phone',
  title: id,
  chatId: `c_${id}`,
  model: null,
  messageCount: 1,
  startedAt: '2027-01-01T00:00:00Z',
  updatedAt: '2027-01-01T00:00:00Z',
  endedAt: null,
  endReason: null,
  status: 'idle',
  lastRole: null,
  preview: null,
  canSend: true,
  ...over,
});

describe('mirror', () => {
  it('merges messages by id, sorted, without duplicates', () => {
    const out = mergeMessages([msg(1), msg(3)], [msg(2), msg(3, { content: 'new' })]);
    assert.deepEqual(out.map((m) => m.id), [1, 2, 3]);
    assert.equal(out[2]!.content, 'new');
  });

  it('adopts the server head on first hello, keeps own cursor afterwards', () => {
    let st = applyEvent(emptyMirror, { type: 'server.hello', apiVersion: 1, cursor: 500, serverTime: '' });
    assert.equal(st.cursor, 500);
    st = applyEvent({ ...st, cursor: 400 }, { type: 'server.hello', apiVersion: 1, cursor: 900, serverTime: '' });
    assert.equal(st.cursor, 400, 'replay must advance it, not the hello');
  });

  it('never asks for replay from 0 (would stream the oldest history)', () => {
    assert.deepEqual(helloFrame(0), { type: 'client.hello', sessions: [] });
    assert.deepEqual(helloFrame(42), { type: 'client.hello', sessions: [], since: 42 });
  });

  it('applies live messages to open sessions and bumps the list', () => {
    let st: MirrorState = setSessions(emptyMirror, [sess('s0', { updatedAt: '2027-01-02T00:00:00Z' }), sess('s1')]);
    st = setMessages(st, 's1', [msg(1)]);
    st = applyEvent(st, { type: 'message.created', sessionId: 's1', message: msg(2, { content: 'hello' }) });
    assert.deepEqual(st.messages.s1!.map((m) => m.id), [1, 2]);
    assert.equal(st.cursor, 2);
    assert.equal(st.sessions[0]!.id, 's1', 'session with newest message moves to top');
    assert.equal(st.sessions[0]!.preview, 'hello');
    // replayed duplicate is a no-op
    const again = applyEvent(st, { type: 'message.created', sessionId: 's1', message: msg(2), replay: true });
    assert.equal(again, st);
  });

  it('flags a refresh when a message arrives for an unknown session', () => {
    const st = applyEvent(emptyMirror, { type: 'message.created', sessionId: 'zz', message: msg(7, { sessionId: 'zz' }) });
    assert.equal(st.needsSessionRefresh, true);
    assert.equal(st.messages.zz, undefined, 'unopened sessions do not accumulate messages');
  });

  it('tracks working/idle from snapshot and session.updated', () => {
    let st = setSessions(emptyMirror, [sess('s1'), sess('s2', { endedAt: '2027-01-01T01:00:00Z', status: 'ended' })]);
    st = applyEvent(st, { type: 'status.snapshot', working: ['s1'] });
    assert.equal(st.sessions.find((s) => s.id === 's1')!.status, 'working');
    st = applyEvent(st, { type: 'session.updated', sessionId: 's1', status: 'idle', lastMessage: msg(9), at: '' });
    assert.equal(st.sessions.find((s) => s.id === 's1')!.status, 'idle');
    assert.equal(st.sessions.find((s) => s.id === 's2')!.status, 'ended');
    assert.equal(st.cursor, 9);
  });

  it('outbox: confirmed by a newer identical user message, not by an old one', () => {
    let st = setSessions(emptyMirror, [sess('s1', { chatId: 'c1' })]);
    st = setMessages(st, 's1', [msg(1, { role: 'user', content: 'ok' })]);
    st = enqueue(st, { clientMessageId: 'a', chatId: 'c1', sessionId: null, text: 'ok' });
    st = markOutbox(st, 'a', 'sent');
    st = setMessages(st, 's1', []); // reconcile pass: old "ok" (id 1) must not count
    assert.equal(st.outbox.length, 1);
    st = applyEvent(st, { type: 'message.created', sessionId: 's1', message: msg(2, { role: 'user', content: 'ok' }) });
    assert.equal(st.outbox.length, 0);
  });

  it('outbox: a message into a foreign (desktop) session reconciles by sessionId', () => {
    let st = setSessions(emptyMirror, [sess('d1', { source: 'desktop', chatId: null })]);
    st = setMessages(st, 'd1', [msg(1, { sessionId: 'd1', role: 'user', content: 'old' })]);
    st = enqueue(st, { clientMessageId: 'a', chatId: null, sessionId: 'd1', text: 'from phone' });
    assert.equal(outboxFor(st, null, 'd1').length, 1);
    st = applyEvent(st, { type: 'message.created', sessionId: 'd1', message: msg(2, { sessionId: 'd1', role: 'user', content: 'from phone' }) });
    assert.equal(st.outbox.length, 0);
  });

  it('outbox: failed items stay until retried or discarded', () => {
    let st = setSessions(emptyMirror, [sess('s1', { chatId: 'c1' })]);
    st = setMessages(st, 's1', []);
    st = enqueue(st, { clientMessageId: 'a', chatId: 'c1', sessionId: null, text: 'hi' });
    st = markOutbox(st, 'a', 'failed', 'offline');
    st = applyEvent(st, { type: 'message.created', sessionId: 's1', message: msg(5, { role: 'user', content: 'hi' }) });
    assert.equal(st.outbox[0]!.state, 'failed');
  });
});

describe('client', () => {
  const fakeFetch =
    (status: number, body: unknown, seen?: { url?: string; init?: RequestInit }) =>
    async (url: unknown, init?: RequestInit) => {
      if (seen) Object.assign(seen, { url: String(url), init });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    };

  it('normalizes addresses and builds the ws url', () => {
    assert.equal(normalizeBaseUrl(' 100.1.2.3:8097/ '), 'http://100.1.2.3:8097');
    assert.equal(wsUrl('https://pc.ts.net:8097', 'a b'), 'wss://pc.ts.net:8097/v1/ws?access_token=a%20b');
  });

  it('sends bearer token and idempotency id', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const c = new BridgeClient({
      baseUrl: 'http://pc:8097',
      token: 'tok',
      fetchImpl: fakeFetch(202, { accepted: true, chatId: 'c1', messageId: 'x' }, seen) as typeof fetch,
    });
    await c.send('c1', 'hi', 'x');
    assert.equal(seen.url, 'http://pc:8097/v1/chats/c1/messages');
    assert.equal((seen.init!.headers as Record<string, string>).Authorization, 'Bearer tok');
    assert.deepEqual(JSON.parse(String(seen.init!.body)), { text: 'hi', clientMessageId: 'x' });
  });

  it('continues any session through /v1/sessions/:id/messages', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const c = new BridgeClient({
      baseUrl: 'http://pc:8097',
      token: 'tok',
      fetchImpl: fakeFetch(202, { accepted: true, sessionId: 'd 1', messageId: 'x' }, seen) as typeof fetch,
    });
    const r = await c.sendToSession('d 1', 'go on', 'x');
    assert.equal(seen.url, 'http://pc:8097/v1/sessions/d%201/messages');
    assert.equal(r.sessionId, 'd 1');
  });

  it('maps gateway errors to BridgeError', async () => {
    const c = new BridgeClient({
      baseUrl: 'http://pc:8097',
      token: 't',
      fetchImpl: fakeFetch(401, { error: { code: 'UNAUTHORIZED', message: 'pair this device first' } }) as typeof fetch,
    });
    await assert.rejects(c.sessions(), (e: unknown) => e instanceof BridgeError && e.unauthorized && e.code === 'UNAUTHORIZED');
  });

  it('rejects a server that is not a phone bridge', async () => {
    const c = new BridgeClient({ baseUrl: 'http://pc:8787', fetchImpl: fakeFetch(200, { ok: true }) as typeof fetch });
    await assert.rejects(c.health(), (e: unknown) => e instanceof BridgeError && e.code === 'NOT_A_BRIDGE');
  });

  it('reports network failures as unreachable', async () => {
    const c = new BridgeClient({
      baseUrl: 'http://pc:8097',
      fetchImpl: (async () => {
        throw new TypeError('Network request failed');
      }) as typeof fetch,
    });
    await assert.rejects(c.health(), (e: unknown) => e instanceof BridgeError && e.unreachable);
  });

  it('refuses authed calls without a token', async () => {
    const c = new BridgeClient({ baseUrl: 'http://pc:8097', fetchImpl: fakeFetch(200, {}) as typeof fetch });
    await assert.rejects(c.sessions(), (e: unknown) => e instanceof BridgeError && e.code === 'NOT_PAIRED');
  });
});

describe('errors & pairing payload', () => {
  it('explains failures in plain words', () => {
    assert.match(describeError(new BridgeError(0, 'UNREACHABLE', 'x'), 'kingwarpc'), /Tailscale.*kingwarpc/);
    assert.match(describeError(new BridgeError(400, 'PAIR_CODE_INVALID', 'x')), /127\.0\.0\.1:8097\/pair/);
    assert.match(describeError(new BridgeError(409, 'SESSION_BUSY', 'x'), 'pc'), /still working.*pc/);
  });
  it('parses QR deep links and bare codes', () => {
    assert.deepEqual(
      parsePairPayload('hermes-phone://pair?hubUrl=http%3A%2F%2F100.1.2.3%3A8097&code=12345678&pairId=ab&name=pc'),
      { hubUrl: 'http://100.1.2.3:8097', code: '12345678', pairId: 'ab', name: 'pc' },
    );
    assert.deepEqual(parsePairPayload('1234 5678'), { code: '12345678' });
    assert.equal(parsePairPayload('https://example.com'), null);
    assert.equal(parsePairPayload('cursor-companion://pair?code=12345678&host=x'), null, 'old Cursor Hub QR is not ours');
  });
});

describe('format', () => {
  it('collapses tool plumbing into one row and hides system prompts', () => {
    const items = buildTranscript([
      msg(1, { role: 'system', content: 'sys' }),
      msg(2, { role: 'user', content: 'list files' }),
      msg(3, { role: 'assistant', content: '', toolCalls: ['terminal'] }),
      msg(4, { role: 'tool', content: 'a b c', toolName: 'terminal' }),
      msg(5, { role: 'assistant', content: '', toolCalls: ['read_file', 'read_file'] }),
      msg(6, { role: 'tool', content: '...' }),
      msg(7, { role: 'assistant', content: 'Here they are' }),
    ]);
    assert.deepEqual(
      items.map((i) => (i.kind === 'tools' ? `tools:${i.names.join('+')}:${i.count}` : i.message.id)),
      [2, 'tools:terminal+read_file:3', 7],
    );
    assert.equal(toolsLabel(['terminal', 'read_file'], 3), 'Used terminal, read_file · 3 calls');
  });
  it('titles and times', () => {
    assert.equal(sessionTitle({ id: 'x', title: 'x', preview: '**Fix** the bug' }), 'Fix the bug');
    assert.equal(relativeTime(new Date(Date.now() - 5 * 60_000).toISOString()), '5m');
    assert.equal(relativeTime(null), '');
  });
});

describe('network', () => {
  it('classifies addresses', () => {
    assert.equal(addressKind('http://192.168.12.66:8097'), 'lan');
    assert.equal(addressKind('http://10.42.0.1:8097'), 'lan');
    assert.equal(addressKind('http://172.20.0.5:8097'), 'lan');
    assert.equal(addressKind('http://100.108.160.99:8097'), 'tailscale');
    assert.equal(addressKind('http://kingwarpc-1.tail246b3f.ts.net:8097'), 'name');
    assert.equal(addressKind('http://8.8.8.8:8097'), 'name');
  });
  it('ranks LAN → Tailscale IP → MagicDNS and dedupes', () => {
    assert.deepEqual(
      rankAddresses(['http://pc.ts.net:8097', 'http://100.101.2.3:8097/', 'http://192.168.1.5:8097', 'http://100.101.2.3:8097']),
      ['http://192.168.1.5:8097', 'http://100.101.2.3:8097', 'http://pc.ts.net:8097'],
    );
    assert.deepEqual(mergeAddresses(['http://100.101.2.3:8097'], null, ['http://192.168.1.5:8097']), [
      'http://192.168.1.5:8097',
      'http://100.101.2.3:8097',
    ]);
  });
  it('picks the best REACHABLE address (home: Wi-Fi; away: Tailscale)', () => {
    const ranked = ['http://192.168.1.5:8097', 'http://100.101.2.3:8097'];
    assert.equal(pickBest(ranked, new Set(ranked)), 'http://192.168.1.5:8097');
    assert.equal(pickBest(ranked, new Set(['http://100.101.2.3:8097'])), 'http://100.101.2.3:8097');
    assert.equal(pickBest(ranked, new Set()), null);
  });
  it('scans only the private /24, skipping the phone itself', () => {
    const h = subnetHosts('192.168.12.40');
    assert.equal(h.length, 253);
    assert.ok(!h.includes('192.168.12.40') && h.includes('192.168.12.66'));
    assert.deepEqual(subnetHosts('100.99.189.101'), [], 'never sweep the tailnet / carrier range');
    assert.deepEqual(subnetHosts(null), []);
  });
  it('pool keeps concurrency bounded and drops failures', async () => {
    let active = 0;
    let peak = 0;
    const out = await pool([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (n % 2) throw new Error('down');
      return n;
    });
    assert.ok(peak <= 3);
    assert.deepEqual(out.sort(), [2, 4, 6, 8]);
  });
});

describe('live channel', () => {
  const live = (liveId: string, text: string, over: Record<string, unknown> = {}) =>
    ({ type: 'live.update', chatId: 'c1', sessionId: 's1', liveId, text, final: false, at: new Date().toISOString(), ...over }) as const;

  it('streams a preview into one bubble and drops it when the persisted reply lands', () => {
    let st = setSessions(emptyMirror, [sess('s1', { chatId: 'c1' })]);
    st = setMessages(st, 's1', [msg(1, { role: 'user', content: 'hi' })], 'working');
    st = applyEvent(st, live('L1', 'Hel ▉'));
    st = applyEvent(st, live('L1', 'Hello wor ▉'));
    assert.equal(liveFor(st, 'c1', 's1').length, 1);
    assert.equal(liveFor(st, 'c1', 's1')[0]!.text, 'Hello wor');
    assert.equal(liveFor(st, 'c1', 's1')[0]!.duringTurn, true);
    st = applyEvent(st, { type: 'message.created', sessionId: 's1', message: msg(2, { content: 'Hello world!' }) });
    assert.equal(liveFor(st, 'c1', 's1').length, 0);
  });

  it('turn end clears tool progress; standalone replies stay until the next message', () => {
    let st = setSessions(emptyMirror, [sess('s1', { chatId: 'c1' })]);
    st = setMessages(st, 's1', [], 'working');
    st = applyEvent(st, live('T1', '💻 terminal: ls'));
    st = applyEvent(st, { type: 'session.updated', sessionId: 's1', status: 'idle', lastMessage: null, at: '' });
    assert.equal(liveFor(st, 'c1', 's1').length, 0, 'tool progress is gone after the turn');
    st = applyEvent(st, live('M1', 'Current model: gpt-x'));
    assert.equal(liveFor(st, 'c1', 's1')[0]!.duringTurn, false);
    st = applyEvent(st, { type: 'session.updated', sessionId: 's1', status: 'idle', lastMessage: null, at: '' });
    assert.equal(liveFor(st, 'c1', 's1').length, 1, '/model output survives idle');
    st = enqueue(st, { clientMessageId: 'x', chatId: null, sessionId: 's1', text: 'next' });
    assert.equal(liveFor(st, 'c1', 's1').length, 0, 'retired by the next message');
  });

  it('live.remove deletes; a final edit already persisted is not shown', () => {
    let st = setSessions(emptyMirror, [sess('s1', { chatId: 'c1' })]);
    st = setMessages(st, 's1', [msg(3, { content: 'Done.' })]);
    st = applyEvent(st, live('L2', 'Done. ▉', { final: true }));
    assert.equal(liveFor(st, 'c1', 's1').length, 0);
    st = applyEvent(st, live('L3', 'x'));
    st = applyEvent(st, { type: 'live.remove', chatId: 'c1', sessionId: 's1', liveId: 'L3', at: '' });
    assert.equal(st.live.length, 0);
    assert.equal(stripCursor('abc ▉'), 'abc');
  });

  it('a new chat with no session yet still gets its preview by chatId', () => {
    const st = applyEvent(emptyMirror, live('N1', 'Hi ▉', { chatId: 'p_new', sessionId: null }));
    assert.equal(liveFor(st, 'p_new', null).length, 1);
  });
});

describe('one-tap pairing client', () => {
  it('posts the request and polls status without a token', async () => {
    const urls: string[] = [];
    const c = new BridgeClient({
      baseUrl: 'http://192.168.1.5:8097',
      fetchImpl: (async (u: unknown, init?: RequestInit) => {
        urls.push(`${init?.method} ${String(u)} ${(init?.headers as Record<string, string>).Authorization ?? '-'}`);
        return new Response(JSON.stringify(String(u).includes('/request/') ? { status: 'pending' } : { requestId: 'r', confirm: '1234', expiresAt: '', hub: { displayName: 'pc', hubId: 'h' } }), { status: 200 });
      }) as typeof fetch,
    });
    assert.equal((await c.pairRequest({ deviceName: 'Pixel', platform: 'android', appVersion: '1' })).confirm, '1234');
    assert.equal((await c.pairRequestStatus('r')).status, 'pending');
    assert.deepEqual(urls, [
      'POST http://192.168.1.5:8097/v1/pair/request -',
      'GET http://192.168.1.5:8097/v1/pair/request/r -',
    ]);
  });
});
