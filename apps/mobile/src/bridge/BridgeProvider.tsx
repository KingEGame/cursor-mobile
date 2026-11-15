/**
 * One provider for the whole app: pairing, live socket, mirrored sessions/messages, outbox.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import Constants from 'expo-constants';
import { BridgeClient, isBridgeError, newClientMessageId } from './client';
import {
  applyEvent,
  dropOutbox,
  emptyMirror,
  enqueue,
  markOutbox,
  setMessages,
  setSessions,
  upsertSession,
  type MirrorState,
} from './mirror';
import { clearPairingToken, loadPairing, savePairing, type Pairing } from './pairing';
import { BridgeSocket, type SocketState } from './socket';
import type { Health, PairCompleteResponse, Session } from './types';
import { describeError } from './errors';

export type Connection = 'unpaired' | 'connecting' | 'online' | 'offline' | 'revoked';

interface BridgeApi {
  ready: boolean;
  pairing: Pairing;
  connection: Connection;
  health: Health | null;
  lastError: string | null;
  mirror: MirrorState;
  hasMoreSessions: boolean;
  client: BridgeClient;
  completePairing: (baseUrl: string, res: PairCompleteResponse) => Promise<void>;
  unpair: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  loadOlderSessions: () => Promise<void>;
  refreshHealth: () => Promise<Health | null>;
  /** Load (or incrementally update) a session's messages and keep it live. */
  openSession: (sessionId: string) => Promise<void>;
  closeSession: (sessionId: string) => void;
  newChat: () => Promise<string>;
  send: (chatId: string, text: string) => Promise<void>;
  retry: (clientMessageId: string) => Promise<void>;
  discard: (clientMessageId: string) => void;
  /** Wait until a phone chat has become a Hermes session (first agent pickup). */
  resolveChat: (chatId: string, timeoutMs?: number) => Promise<Session | null>;
}

const Ctx = createContext<BridgeApi | null>(null);
const PAGE = 50;
const emptyPairing: Pairing = { baseUrl: '', token: null, deviceId: null, pcName: null, hubId: null };

export function BridgeProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [pairing, setPairing] = useState<Pairing>(emptyPairing);
  const [socketState, setSocketState] = useState<SocketState>('idle');
  const [revoked, setRevoked] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [mirror, setMirror] = useState<MirrorState>(emptyMirror);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const mirrorRef = useRef<MirrorState>(emptyMirror);
  const openSessions = useRef(new Set<string>());
  const socketRef = useRef<BridgeSocket | null>(null);

  const update = useCallback((fn: (s: MirrorState) => MirrorState) => {
    setMirror((prev) => {
      const next = fn(prev);
      mirrorRef.current = next;
      return next;
    });
  }, []);

  const client = useMemo(
    () => new BridgeClient({ baseUrl: pairing.baseUrl, token: pairing.token }),
    [pairing.baseUrl, pairing.token],
  );

  useEffect(() => {
    void loadPairing().then((p) => {
      setPairing(p);
      setReady(true);
    });
  }, []);

  const fail = useCallback(
    (err: unknown) => {
      if (isBridgeError(err) && err.unauthorized) {
        setRevoked(true);
        socketRef.current?.stop();
      }
      setLastError(describeError(err, pairing.pcName));
    },
    [pairing.pcName],
  );

  const refreshSessions = useCallback(async () => {
    if (!pairing.token) return;
    try {
      const page = await client.sessions({ limit: PAGE });
      update((s) => setSessions(s, page.items));
      setNextBefore(page.nextBefore);
      setLastError(null);
    } catch (err) {
      fail(err);
    }
  }, [client, pairing.token, update, fail]);

  const loadOlderSessions = useCallback(async () => {
    if (!pairing.token || nextBefore == null) return;
    try {
      const page = await client.sessions({ limit: PAGE, before: nextBefore });
      update((s) => setSessions(s, page.items, true));
      setNextBefore(page.nextBefore);
    } catch (err) {
      fail(err);
    }
  }, [client, pairing.token, nextBefore, update, fail]);

  const refreshHealth = useCallback(async () => {
    try {
      const h = await client.health();
      setHealth(h);
      return h;
    } catch (err) {
      setHealth(null);
      fail(err);
      return null;
    }
  }, [client, fail]);

  const syncSession = useCallback(
    async (sessionId: string) => {
      const have = mirrorRef.current.messages[sessionId];
      const after = have?.length ? have[have.length - 1]!.id : 0;
      const page = await client.messages(sessionId, after ? { after, limit: 1000 } : { limit: 200 });
      update((s) => setMessages(s, sessionId, page.messages, page.status));
    },
    [client, update],
  );

  const openSession = useCallback(
    async (sessionId: string) => {
      openSessions.current.add(sessionId);
      try {
        if (!mirrorRef.current.sessions.some((x) => x.id === sessionId)) {
          const s = await client.session(sessionId);
          update((m) => upsertSession(m, s));
        }
        await syncSession(sessionId);
        setLastError(null);
      } catch (err) {
        fail(err);
      }
    },
    [client, syncSession, update, fail],
  );

  const closeSession = useCallback((sessionId: string) => {
    openSessions.current.delete(sessionId);
  }, []);

  // Live socket — one per pairing.
  useEffect(() => {
    if (!pairing.token || !pairing.baseUrl) return;
    setRevoked(false);
    const sock = new BridgeSocket({
      baseUrl: pairing.baseUrl,
      token: pairing.token,
      getSince: () => mirrorRef.current.cursor,
      onEvent: (ev) => update((s) => applyEvent(s, ev)),
      onState: setSocketState,
    });
    socketRef.current = sock;
    sock.start();
    return () => {
      sock.stop();
      socketRef.current = null;
    };
  }, [pairing.baseUrl, pairing.token, update]);

  // Every (re)connect: refresh the list and catch up open chats (covers replay limits).
  useEffect(() => {
    if (socketState !== 'open') return;
    void refreshSessions();
    void refreshHealth();
    for (const sid of openSessions.current) void syncSession(sid).catch(() => undefined);
  }, [socketState, refreshSessions, refreshHealth, syncSession]);

  // Socket keeps failing → find out why over REST (401 = revoked, else offline).
  useEffect(() => {
    if (socketState !== 'closed' || !pairing.token) return;
    const t = setTimeout(() => void client.sessions({ limit: 1 }).catch(fail), 1500);
    return () => clearTimeout(t);
  }, [socketState, pairing.token, client, fail]);

  // A message for an unknown session (e.g. a new chat just started) → refetch the list.
  useEffect(() => {
    if (!mirror.needsSessionRefresh) return;
    const t = setTimeout(() => void refreshSessions(), 300);
    return () => clearTimeout(t);
  }, [mirror.needsSessionRefresh, refreshSessions]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') socketRef.current?.kick();
    });
    return () => sub.remove();
  }, []);

  const completePairing = useCallback(async (baseUrl: string, res: PairCompleteResponse) => {
    const p: Pairing = {
      baseUrl,
      token: res.deviceToken,
      deviceId: res.deviceId,
      pcName: res.hub.displayName,
      hubId: res.hub.hubId,
    };
    await savePairing(p);
    mirrorRef.current = emptyMirror;
    setMirror(emptyMirror);
    setRevoked(false);
    setLastError(null);
    setPairing(p);
  }, []);

  const unpair = useCallback(async () => {
    await clearPairingToken();
    socketRef.current?.stop();
    mirrorRef.current = emptyMirror;
    setMirror(emptyMirror);
    setHealth(null);
    setPairing((p) => ({ ...p, token: null, deviceId: null }));
  }, []);

  const newChat = useCallback(async () => (await client.newChat()).chatId, [client]);

  const deliver = useCallback(
    async (chatId: string, text: string, id: string) => {
      try {
        await client.send(chatId, text, id);
        update((s) => markOutbox(s, id, 'sent'));
      } catch (err) {
        update((s) => markOutbox(s, id, 'failed', describeError(err, pairing.pcName)));
        if (isBridgeError(err) && err.unauthorized) fail(err);
      }
    },
    [client, update, pairing.pcName, fail],
  );

  const send = useCallback(
    async (chatId: string, text: string) => {
      const t = text.trim();
      if (!t) return;
      const id = newClientMessageId();
      update((s) => enqueue(s, { clientMessageId: id, chatId, text: t }));
      await deliver(chatId, t, id);
    },
    [update, deliver],
  );

  const retry = useCallback(
    async (id: string) => {
      const item = mirrorRef.current.outbox.find((o) => o.clientMessageId === id);
      if (!item) return;
      update((s) => enqueue(s, { clientMessageId: id, chatId: item.chatId, text: item.text }));
      await deliver(item.chatId, item.text, id); // same id → Gateway drops it if the first try landed
    },
    [update, deliver],
  );

  const discard = useCallback((id: string) => update((s) => dropOutbox(s, id)), [update]);

  const resolveChat = useCallback(
    async (chatId: string, timeoutMs = 90_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const known = mirrorRef.current.sessions.find((s) => s.chatId === chatId && s.source === 'phone');
        if (known) return known;
        try {
          const r = await client.chatSession(chatId);
          if (r.sessionId) {
            const s = await client.session(r.sessionId);
            update((m) => upsertSession(m, s));
            return s;
          }
        } catch {
          /* keep polling */
        }
        await new Promise((res) => setTimeout(res, 1500));
      }
      return null;
    },
    [client, update],
  );

  const connection: Connection = !pairing.token
    ? 'unpaired'
    : revoked
      ? 'revoked'
      : socketState === 'open'
        ? 'online'
        : socketState === 'closed'
          ? 'offline'
          : 'connecting';

  const value: BridgeApi = {
    ready,
    pairing,
    connection,
    health,
    lastError,
    mirror,
    hasMoreSessions: nextBefore != null,
    client,
    completePairing,
    unpair,
    refreshSessions,
    loadOlderSessions,
    refreshHealth,
    openSession,
    closeSession,
    newChat,
    send,
    retry,
    discard,
    resolveChat,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBridge(): BridgeApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useBridge must be used inside <BridgeProvider>');
  return v;
}

export function appVersion(): string {
  return Constants.expoConfig?.version ?? '0.0.0';
}
