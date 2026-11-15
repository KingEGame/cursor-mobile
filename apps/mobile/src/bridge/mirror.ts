/**
 * Pure, testable mirror of the PC's state.db as seen by the phone.
 * Every mutation goes through these functions; React only holds the resulting object.
 */
import type { Message, Session, SessionStatus, WsLiveUpdate, WsServerEvent } from './types';

export type OutboxState = 'sending' | 'sent' | 'failed';

export interface OutboxItem {
  clientMessageId: string;
  /** New phone chat (no session yet) — or the phone chat of a phone session. */
  chatId: string | null;
  /** Existing session being continued (any source). */
  sessionId: string | null;
  text: string;
  state: OutboxState;
  createdAt: number;
  /** Mirror cursor when queued — only later user messages can confirm it. */
  afterId: number;
  error?: string;
}

/** Ephemeral gateway output shown in a chat until the real (persisted) message replaces it. */
export interface LiveItem {
  liveId: string;
  chatId: string;
  sessionId: string | null;
  text: string;
  final: boolean;
  at: number;
  /** Arrived while the agent was running (stream preview / tool progress) vs. a standalone reply (/model…). */
  duringTurn: boolean;
}

export interface MirrorState {
  /** Newest first. */
  sessions: Session[];
  /** Only sessions the user opened are kept here (bounded memory). */
  messages: Record<string, Message[]>;
  working: Record<string, true>;
  /** Highest message id applied — sent as `since` on reconnect. */
  cursor: number;
  outbox: OutboxItem[];
  live: LiveItem[];
  /** A message arrived for a session we do not list yet → caller should refetch the list. */
  needsSessionRefresh: boolean;
}

export const emptyMirror: MirrorState = {
  sessions: [],
  messages: {},
  working: {},
  cursor: 0,
  outbox: [],
  live: [],
  needsSessionRefresh: false,
};

/** The stream consumer appends a typing cursor (" ▉") to previews. */
export function stripCursor(text: string): string {
  return text.replace(/\s*▉\s*$/u, '');
}

const norm = (t: string) => stripCursor(t).replace(/\s+/g, ' ').trim();

function sessionForChat(st: MirrorState, chatId: string): string | null {
  return st.sessions.find((s) => s.chatId === chatId)?.id ?? null;
}

function applyLive(st: MirrorState, ev: WsLiveUpdate): MirrorState {
  const sid = ev.sessionId ?? sessionForChat(st, ev.chatId);
  const text = stripCursor(ev.text);
  // Persisted copy already here (DB poll beat the final edit) → nothing to preview.
  const persisted = sid ? st.messages[sid] : undefined;
  if (ev.final && persisted?.some((m) => m.role === 'assistant' && norm(m.content) === norm(text))) {
    return { ...st, live: st.live.filter((l) => l.liveId !== ev.liveId) };
  }
  const prev = st.live.find((l) => l.liveId === ev.liveId);
  const item: LiveItem = {
    liveId: ev.liveId,
    chatId: ev.chatId,
    sessionId: sid,
    text,
    final: ev.final,
    at: prev?.at ?? (Date.parse(ev.at) || Date.now()),
    duringTurn: prev?.duringTurn ?? (sid ? Boolean(st.working[sid]) : true),
  };
  return { ...st, live: [...st.live.filter((l) => l.liveId !== ev.liveId), item] };
}

function belongs(l: LiveItem, sessionId: string | null | undefined, chatId: string | null | undefined): boolean {
  return (sessionId != null && l.sessionId === sessionId) || (chatId != null && l.chatId === chatId);
}

/** Drop previews that the persisted assistant message now covers. */
function consumeLive(st: MirrorState, m: Message): MirrorState {
  if (m.role !== 'assistant' || !m.content.trim() || !st.live.length) return st;
  const chatId = st.sessions.find((s) => s.id === m.sessionId)?.chatId ?? null;
  const content = norm(m.content);
  const keep = st.live.filter((l) => {
    if (!belongs(l, m.sessionId, chatId)) return true;
    const t = norm(l.text);
    return !(t && (content === t || content.startsWith(t)));
  });
  return keep.length === st.live.length ? st : { ...st, live: keep };
}

export function liveFor(st: MirrorState, chatId: string | null | undefined, sessionId: string | null | undefined): LiveItem[] {
  return st.live.filter((l) => belongs(l, sessionId, chatId)).sort((a, b) => a.at - b.at);
}

const MAX_MESSAGES_PER_SESSION = 1000;

function ts(s: Session): number {
  const t = s.updatedAt ? Date.parse(s.updatedAt) : NaN;
  return Number.isFinite(t) ? t : 0;
}

export function sortSessions(list: Session[]): Session[] {
  return [...list].sort((a, b) => ts(b) - ts(a));
}

/** Union by id (incoming wins), sorted ascending, capped. */
export function mergeMessages(existing: Message[] | undefined, incoming: Message[]): Message[] {
  if (!incoming.length) return existing ?? [];
  const byId = new Map<number, Message>();
  for (const m of existing ?? []) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  const out = [...byId.values()].sort((a, b) => a.id - b.id);
  return out.length > MAX_MESSAGES_PER_SESSION ? out.slice(-MAX_MESSAGES_PER_SESSION) : out;
}

function withStatus(s: Session, working: Record<string, true>): Session {
  const status: SessionStatus = working[s.id] ? 'working' : s.endedAt ? 'ended' : 'idle';
  return status === s.status ? s : { ...s, status };
}

/** Replace the list from REST (first page) — keeps live status from the socket. */
export function setSessions(st: MirrorState, items: Session[], append = false): MirrorState {
  const merged = new Map<string, Session>();
  if (append) for (const s of st.sessions) merged.set(s.id, s);
  for (const s of items) merged.set(s.id, s);
  if (!append) {
    // Keep sessions we know about that the page did not include only if they are newer (live arrivals).
    const oldest = items.length ? Math.min(...items.map(ts)) : Infinity;
    for (const s of st.sessions) if (!merged.has(s.id) && ts(s) > oldest) merged.set(s.id, s);
  }
  const working = { ...st.working };
  for (const s of items) {
    if (s.status === 'working') working[s.id] = true;
  }
  return {
    ...st,
    working,
    sessions: sortSessions([...merged.values()].map((s) => withStatus(s, working))),
    needsSessionRefresh: false,
  };
}

export function upsertSession(st: MirrorState, s: Session): MirrorState {
  const rest = st.sessions.filter((x) => x.id !== s.id);
  return { ...st, sessions: sortSessions([withStatus(s, st.working), ...rest]) };
}

export function setMessages(st: MirrorState, sessionId: string, msgs: Message[], status?: 'working' | 'idle'): MirrorState {
  const merged = mergeMessages(st.messages[sessionId], msgs);
  const maxId = merged.length ? merged[merged.length - 1]!.id : 0;
  let next: MirrorState = { ...st, messages: { ...st.messages, [sessionId]: merged } };
  if (st.cursor === 0) next.cursor = maxId; // first data: start live sync from here
  if (status) next = applyStatus(next, sessionId, status);
  for (const m of msgs) next = consumeLive(next, m);
  return reconcileOutbox(next);
}

function applyStatus(st: MirrorState, sessionId: string, status: 'working' | 'idle'): MirrorState {
  const working = { ...st.working };
  if (status === 'working') working[sessionId] = true;
  else delete working[sessionId];
  const chatId = st.sessions.find((s) => s.id === sessionId)?.chatId ?? null;
  // Turn over: stream previews and tool progress are done; the persisted reply is what stays.
  const live =
    status === 'idle' ? st.live.filter((l) => !(l.duringTurn && belongs(l, sessionId, chatId))) : st.live;
  return {
    ...st,
    working,
    live,
    sessions: st.sessions.map((s) => (s.id === sessionId ? withStatus(s, working) : s)),
  };
}

function previewOf(m: Message): string | null {
  if (m.role !== 'user' && m.role !== 'assistant') return null;
  const t = m.content.trim();
  return t ? t.slice(0, 200) : null;
}

function touchSession(st: MirrorState, m: Message): MirrorState {
  const idx = st.sessions.findIndex((s) => s.id === m.sessionId);
  if (idx < 0) return { ...st, needsSessionRefresh: true };
  const s = st.sessions[idx]!;
  const preview = previewOf(m);
  const updated: Session = {
    ...s,
    messageCount: s.messageCount + 1,
    updatedAt: m.createdAt ?? s.updatedAt,
    ...(preview ? { preview, lastRole: m.role } : {}),
  };
  const rest = st.sessions.filter((_, i) => i !== idx);
  return { ...st, sessions: sortSessions([updated, ...rest]) };
}

export function applyEvent(st: MirrorState, ev: WsServerEvent): MirrorState {
  switch (ev.type) {
    case 'server.hello':
      // Nothing synced yet → start from the server's head; otherwise the replay advances us.
      return st.cursor === 0 ? { ...st, cursor: ev.cursor } : st;
    case 'status.snapshot': {
      const working: Record<string, true> = {};
      for (const id of ev.working) working[id] = true;
      return { ...st, working, sessions: st.sessions.map((s) => withStatus(s, working)) };
    }
    case 'live.update':
      return applyLive(st, ev);
    case 'live.remove':
      return { ...st, live: st.live.filter((l) => l.liveId !== ev.liveId) };
    case 'message.created': {
      const m = ev.message;
      if (m.id <= st.cursor && st.messages[m.sessionId]?.some((x) => x.id === m.id)) return st;
      let next: MirrorState = { ...st, cursor: Math.max(st.cursor, m.id) };
      if (next.messages[m.sessionId]) {
        next = { ...next, messages: { ...next.messages, [m.sessionId]: mergeMessages(next.messages[m.sessionId], [m]) } };
      }
      next = touchSession(next, m);
      next = consumeLive(next, m);
      return reconcileOutbox(next);
    }
    case 'session.updated': {
      let next = applyStatus(st, ev.sessionId, ev.status);
      if (ev.lastMessage) {
        next = { ...next, cursor: Math.max(next.cursor, ev.lastMessage.id) };
        if (next.messages[ev.sessionId]) {
          next = {
            ...next,
            messages: { ...next.messages, [ev.sessionId]: mergeMessages(next.messages[ev.sessionId], [ev.lastMessage]) },
          };
        }
        next = consumeLive(next, ev.lastMessage);
      }
      if (!next.sessions.some((s) => s.id === ev.sessionId)) next = { ...next, needsSessionRefresh: true };
      return next;
    }
    default:
      return st;
  }
}

// ── outbox (optimistic phone → PC messages) ──────────────────────────────────

export function enqueue(
  st: MirrorState,
  item: Omit<OutboxItem, 'state' | 'createdAt' | 'afterId'>,
  now = Date.now(),
): MirrorState {
  const prev = st.outbox.find((o) => o.clientMessageId === item.clientMessageId);
  const entry: OutboxItem = { ...item, state: 'sending', createdAt: prev?.createdAt ?? now, afterId: prev?.afterId ?? st.cursor };
  // A new message from the user retires earlier standalone replies (e.g. the /model listing) in that chat.
  const live = st.live.filter((l) => l.duringTurn || !belongs(l, item.sessionId, item.chatId));
  return { ...st, live, outbox: [...st.outbox.filter((o) => o.clientMessageId !== item.clientMessageId), entry] };
}

export function markOutbox(st: MirrorState, clientMessageId: string, state: OutboxState, error?: string): MirrorState {
  return {
    ...st,
    outbox: st.outbox.map((o) => (o.clientMessageId === clientMessageId ? { ...o, state, error } : o)),
  };
}

export function dropOutbox(st: MirrorState, clientMessageId: string): MirrorState {
  return { ...st, outbox: st.outbox.filter((o) => o.clientMessageId !== clientMessageId) };
}

/** Accepted items disappear once state.db holds the same user text in that chat's session. */
export function reconcileOutbox(st: MirrorState): MirrorState {
  if (!st.outbox.length) return st;
  const chatToSession = new Map<string, string>();
  for (const s of st.sessions) if (s.chatId) chatToSession.set(s.chatId, s.id);
  const consumed = new Set<number>();
  const keep = st.outbox.filter((o) => {
    if (o.state === 'failed') return true;
    const sid = o.sessionId ?? (o.chatId ? chatToSession.get(o.chatId) : undefined);
    const msgs = sid ? st.messages[sid] : undefined;
    if (!msgs) return true;
    const users = msgs.filter((m) => m.role === 'user' && m.id > o.afterId && !consumed.has(m.id));
    // Exact text first; otherwise any user message stored after we sent (Gateway may decorate text).
    const hit =
      users.find((m) => m.content.trim() === o.text.trim()) ??
      (o.state === 'sent'
        ? users.find((m) => m.createdAt != null && Date.parse(m.createdAt) >= o.createdAt - 2_000)
        : undefined);
    if (!hit) return true;
    consumed.add(hit.id);
    return false;
  });
  return keep.length === st.outbox.length ? st : { ...st, outbox: keep };
}

export function outboxFor(st: MirrorState, chatId: string | null | undefined, sessionId?: string | null): OutboxItem[] {
  return st.outbox.filter(
    (o) => (sessionId != null && o.sessionId === sessionId) || (chatId != null && o.chatId === chatId),
  );
}

export function findSessionByChat(st: MirrorState, chatId: string): Session | undefined {
  return st.sessions.find((s) => s.chatId === chatId && s.source === 'phone');
}
