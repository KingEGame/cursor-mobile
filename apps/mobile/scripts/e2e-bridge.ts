/**
 * Live E2E: the app's real BridgeClient + BridgeSocket + mirror reducer against a running
 * phone bridge (e2e_server.py). Usage: node --import tsx scripts/e2e-bridge.ts <baseUrl> <pairId> <code>
 */
import { BridgeClient, newClientMessageId } from '../src/bridge/client';
import { applyEvent, emptyMirror, enqueue, markOutbox, setMessages, setSessions, type MirrorState } from '../src/bridge/mirror';
import { BridgeSocket } from '../src/bridge/socket';
import { buildTranscript } from '../src/bridge/format';

const [baseUrl, pairId, code] = process.argv.slice(2);
let failed = 0;
const check = (name: string, ok: unknown, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`);
  if (!ok) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(100);
  }
  return false;
}

async function main() {
  const anon = new BridgeClient({ baseUrl: baseUrl! });
  const h = await anon.health();
  check('health identifies a phone bridge', h.apiVersion === 1 && h.hub.hubId, h.hub.displayName);

  const pair = await anon.pairComplete({ code: code!, pairId, deviceName: 'e2e', platform: 'node', appVersion: 'e2e' });
  check('pairComplete returns a token', pair.deviceToken.length > 20);
  const reuse = await anon
    .pairComplete({ code: code!, pairId, deviceName: 'e2e', platform: 'node', appVersion: 'e2e' })
    .then(() => 'accepted', (e) => e.code);
  check('pair code is single-use', reuse === 'PAIR_CODE_INVALID', reuse);

  check('health lists phone addresses', Array.isArray(h.hub.addresses) && h.pairing.oneTap === true, (h.hub.addresses ?? []).join(' '));

  // One-tap pairing: phone asks, the PC owner allows on http://127.0.0.1/pair (local POST here).
  const ask = await anon.pairRequest({ deviceName: 'e2e-phone', platform: 'node', appVersion: 'e2e' });
  check('one-tap request gives a confirm code', /^\d{4}$/.test(ask.confirm), ask.confirm);
  const pend = await anon.pairRequestStatus(ask.requestId);
  check('waits for the PC owner', pend.status === 'pending');
  const listed = (await (await fetch(`${baseUrl}/pair/requests`)).json()) as { items: { id: string; confirm: string }[] };
  check('PC page shows the same code', listed.items.some((x) => x.id === ask.requestId && x.confirm === ask.confirm));
  const allow = await fetch(`${baseUrl}/pair/requests/${ask.requestId}/approve`, { method: 'POST' });
  check('owner allows', allow.status === 200, String(allow.status));
  const got = await anon.pairRequestStatus(ask.requestId);
  check('phone receives its token', got.status === 'approved' && 'deviceToken' in got && got.deviceToken.length > 20);
  const oneTapToken = got.status === 'approved' ? got.deviceToken : '';

  const client = new BridgeClient({ baseUrl: baseUrl!, token: oneTapToken });
  let st: MirrorState = emptyMirror;
  const page = await client.sessions({ limit: 50 });
  st = setSessions(st, page.items);
  check('sessions list from real state.db', page.items.length > 0, `${page.items.length} sessions, sources=${[...new Set(page.items.map((s) => s.source))].join(',')}`);
  const foreign = page.items.find((s) => s.source !== 'phone');
  check('PC sessions are writable from the phone', foreign && foreign.canSend === true, foreign?.source);
  if (foreign) {
    const mp = await client.messages(foreign.id, { limit: 20 });
    st = setMessages(st, foreign.id, mp.messages, mp.status);
    check('read history of a PC session', mp.messages.length > 0 && typeof mp.messages[0]!.id === 'number', `${mp.messages.length} msgs`);
  }

  const states: string[] = [];
  const sock = new BridgeSocket({
    baseUrl: baseUrl!,
    token: oneTapToken,
    getSince: () => st.cursor,
    onEvent: (ev) => {
      st = applyEvent(st, ev);
    },
    onState: (s) => states.push(s),
    backoffMinMs: 200,
  });
  sock.start();
  check('websocket opens', await until(() => sock.getState() === 'open'), states.join('>'));

  // New phone chat → agent run → live reply over WS.
  const { chatId } = await client.newChat();
  const text = `e2e ping ${Date.now()}`;
  const id = newClientMessageId();
  st = enqueue(st, { clientMessageId: id, chatId, sessionId: null, text });
  const sent = await client.send(chatId, text, id);
  st = markOutbox(st, id, 'sent');
  check('send accepted', sent.accepted && sent.messageId === id);
  const dup = await client.send(chatId, text, id);
  check('retry with same id is deduplicated', dup.duplicate === true);

  let sid: string | null = null;
  await until(() => {
    void client.chatSession(chatId).then((r) => (sid = r.sessionId));
    return sid != null;
  });
  check('chat resolves to a Hermes session', sid, sid ?? '');
  // The mirror learns about the new session via needsSessionRefresh → list refetch.
  await until(() => st.needsSessionRefresh || st.sessions.some((s) => s.id === sid), 5000);
  st = setSessions(st, (await client.sessions({ limit: 50 })).items);
  const s = st.sessions.find((x) => x.id === sid);
  check('new session is phone + writable', s?.source === 'phone' && s.canSend === true);
  const mp = await client.messages(sid!, {});
  st = setMessages(st, sid!, mp.messages, mp.status);

  check('status goes working', await until(() => st.sessions.find((x) => x.id === sid)?.status === 'working', 5000));
  let peak = '';
  const streamed = await until(() => {
    const l = st.live.find((x) => x.chatId === chatId);
    if (l && l.text.length > peak.length) peak = l.text;
    return peak.length > '**echo:**'.length + 3;
  }, 6000);
  check('reply streams live before it is saved', streamed, peak);
  check('outbox cleared once the user message is in state.db', await until(() => st.outbox.length === 0, 5000), `${st.outbox.length} left`);
  check(
    'final reply streams in over WS',
    await until(() => (st.messages[sid!] ?? []).some((m) => m.role === 'assistant' && m.content.includes(text)), 8000),
  );
  check('status returns to idle', await until(() => st.sessions.find((x) => x.id === sid)?.status === 'idle', 5000));
  check('live preview replaced by the saved message', await until(() => !st.live.some((x) => x.chatId === chatId), 3000),
    `${st.live.length} left`);
  const tr = buildTranscript(st.messages[sid!] ?? []);
  check(
    'transcript = user, tools row, reply',
    tr.map((t) => (t.kind === 'tools' ? 'tools' : t.message.role)).join(',') === 'user,tools,assistant',
    tr.map((t) => t.kind === 'tools' ? `tools(${t.names})` : t.message.role).join(','),
  );

  // Reconnect replay: drop the socket, agent replies while we're away, reconnect with `since`.
  sock.stop();
  const cursorBefore = st.cursor;
  const text2 = `while offline ${Date.now()}`;
  await client.send(chatId, text2, newClientMessageId());
  await sleep(2800); // agent finishes while we're disconnected
  sock.start();
  check(
    'missed messages replayed after reconnect',
    await until(() => (st.messages[sid!] ?? []).some((m) => m.content.includes(text2) && m.role === 'assistant'), 6000),
    `cursor ${cursorBefore} → ${st.cursor}`,
  );
  sock.stop();

  // Continue a session that was started on the PC (desktop/cli/telegram…), not on the phone.
  if (foreign) {
    sock.start();
    await until(() => sock.getState() === 'open');
    const fid = foreign.id;
    const text3 = `continue from phone ${Date.now()}`;
    const cid = newClientMessageId();
    st = enqueue(st, { clientMessageId: cid, chatId: null, sessionId: fid, text: text3 });
    const r3 = await client.sendToSession(fid, text3, cid);
    st = markOutbox(st, cid, 'sent');
    check('send into a PC session accepted', r3.accepted && r3.sessionId === fid, `${foreign.source} ${fid}`);
    check(
      'reply lands in THAT session (not a new one)',
      await until(() => (st.messages[fid] ?? []).some((m) => m.role === 'assistant' && m.content.includes(text3)), 8000),
    );
    check('outbox for the PC session cleared', await until(() => st.outbox.length === 0, 3000));
    const s3 = await client.session(fid);
    // Same semantics as gateway /resume: the session now belongs to the route that resumed it.
    check('session moved to the phone route (like /resume), id unchanged', s3.id === fid && s3.source === 'phone' && s3.canSend, `${foreign.source} → ${s3.source}`);
    const busyText = `second ${Date.now()}`;
    await client.sendToSession(fid, busyText, newClientMessageId());
    await sleep(300);
    const again = await client.sendToSession(fid, 'while working', newClientMessageId()).then(
      (r) => `accepted ${r.accepted}`,
      (e) => e.code,
    );
    check('phone may queue behind its own running turn', again.startsWith('accepted'), again);
    await until(() => st.sessions.find((x) => x.id === fid)?.status === 'idle', 8000);
    sock.stop();
  }

  const bad = new BridgeClient({ baseUrl: baseUrl!, token: 'nope' });
  void pair; // code pairing token stays valid alongside the one-tap one
  const err = await bad.sessions().then(() => null, (e) => e);
  check('bad token → unauthorized', err?.unauthorized === true);

  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('E2E crashed:', e);
  process.exit(2);
});
