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
import { addressKind, mergeAddresses, pickBest, type AddressKind } from './network';

export type Connection = 'unpaired' | 'connecting' | 'online' | 'offline' | 'revoked';

/** Existing session (any source) wins; a bare chatId is a new phone chat with no session yet. */
export interface SendTarget {
  sessionId?: string | null;
  chatId?: string | null;
}

interface BridgeApi {
  ready: boolean;
  pairing: Pairing;
  /** Address in use right now (picked from pairing.addresses: LAN when home, Tailscale outside). */
  activeUrl: string;
  activeKind: AddressKind | null;
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
  send: (target: SendTarget, text: string) => Promise<void>;
  retry: (clientMessageId: string) => Promise<void>;
  discard: (clientMessageId: string) => void;
  /** Re-probe all known PC addresses and switch to the best reachable one. */
  reresolve: () => Promise<string | null>;
  /** Wait until a phone chat has become a Hermes session (first agent pickup). */
  resolveChat: (chatId: string, timeoutMs?: number) => Promise<Session | null>;
}

const Ctx = createContext<BridgeApi | null>(null);
const PAGE = 50;
const emptyPairing: Pairing = { baseUrl: '', addresses: [], token: null, deviceId: null, pcName: null, hubId: null };
const PROBE_TIMEOUT_MS = 2500;

export function BridgeProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [pairing, setPairing] = useState<Pairing>(emptyPairing);
  const [socketState, setSocketState] = useState<SocketState>('idle');
  const [revoked, setRevoked] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [mirror, setMirror] = useState<MirrorState>(emptyMirror);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [activeUrl, setActiveUrl] = useState('');
  const resolving = useRef<Promise<string | null> | null>(null);
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

  const baseUrl = activeUrl || pairing.baseUrl;
  const client = useMemo(() => new BridgeClient({ baseUrl, token: pairing.token }), [baseUrl, pairing.token]);
  const pairingRef = useRef(pairing);
  pairingRef.current = pairing;

  useEffect(() => {
    void loadPairing().then((p) => {
      setPairing(p);
      setActiveUrl(p.addresses[0] ?? p.baseUrl);
      setReady(true);
    });
  }, []);

  /** Remember new addresses the PC reports (e.g. a new Wi-Fi IP) so roaming keeps working. */
  const learnAddresses = useCallback(async (more: string[] | undefined) => {
    const p = pairingRef.current;
    if (!p.token || !more?.length) return;
    const merged = mergeAddresses(p.addresses, more);
    if (merged.join() === p.addresses.join()) return;
    const next = { ...p, addresses: merged };
    pairingRef.current = next;
    setPairing(next);
    await savePairing(next);
  }, []);

  const reresolve = useCallback(async (): Promise<string | null> => {
    if (resolving.current) return resolving.current;
    const run = (async () => {
      const p = pairingRef.current;
      const candidates = mergeAddresses(p.addresses, [p.baseUrl]);
      if (!p.token || !candidates.length) return null;
      const reachable = new Set<string>();
      const seen: string[][] = [];
      await Promise.all(
        candidates.map(async (u) => {
          try {
            const h = await new BridgeClient({ baseUrl: u, timeoutMs: PROBE_TIMEOUT_MS }).health();
            if (p.hubId && h.hub.hubId !== p.hubId) return; // a different PC answered on that IP
            reachable.add(u);
            if (h.hub.addresses) seen.push(h.hub.addresses);
          } catch {
            /* unreachable from here */
          }
        }),
      );
      const best = pickBest(candidates, reachable);
      if (best) setActiveUrl((cur) => (cur === best ? cur : best));
      if (seen.length) void learnAddresses(seen.flat());
      return best;
    })();
    resolving.current = run;
    try {
      return await run;
    } finally {
      resolving.current = null;
    }
  }, [learnAddresses]);

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
      void learnAddresses(h.hub.addresses);
      return h;
    } catch (err) {
      setHealth(null);
      fail(err);
      return null;
    }
  }, [client, fail, learnAddresses]);

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

  // Live socket — one per pairing + active address.
  useEffect(() => {
    if (!pairing.token || !baseUrl) return;
    setRevoked(false);
    const sock = new BridgeSocket({
      baseUrl,
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
  }, [baseUrl, pairing.token, update]);

  // Pick the best address at start-up (LAN beats Tailscale when both answer).
  useEffect(() => {
    if (ready && pairing.token) void reresolve();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, pairing.token]);

  // Every (re)connect: refresh the list and catch up open chats (covers replay limits).
  useEffect(() => {
    if (socketState !== 'open') return;
    void refreshSessions();
    void refreshHealth();
    for (const sid of openSessions.current) void syncSession(sid).catch(() => undefined);
  }, [socketState, refreshSessions, refreshHealth, syncSession]);

  // Socket dropped → maybe we changed networks: try every known address, then find out why (401 = revoked).
  useEffect(() => {
    if (socketState !== 'closed' || !pairing.token) return;
    const t = setTimeout(() => {
      void reresolve().then((best) => {
        if (!best || best === baseUrl) void client.sessions({ limit: 1 }).catch(fail);
      });
    }, 1200);
    return () => clearTimeout(t);
  }, [socketState, pairing.token, client, fail, reresolve, baseUrl]);

  // A message for an unknown session (e.g. a new chat just started) → refetch the list.
  useEffect(() => {
    if (!mirror.needsSessionRefresh) return;
    const t = setTimeout(() => void refreshSessions(), 300);
    return () => clearTimeout(t);
  }, [mirror.needsSessionRefresh, refreshSessions]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active') return;
      // Back in the app: networks may have changed (home Wi-Fi ↔ mobile + Tailscale).
      void reresolve().then(() => socketRef.current?.kick());
    });
    return () => sub.remove();
  }, [reresolve]);

  const completePairing = useCallback(async (pairedUrl: string, res: PairCompleteResponse) => {
    const p: Pairing = {
      baseUrl: pairedUrl,
      addresses: mergeAddresses(res.hub.addresses, [pairedUrl]),
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
    pairingRef.current = p;
    setActiveUrl(pairedUrl); // proven reachable right now
    setPairing(p);
  }, []);

  const unpair = useCallback(async () => {
    // Best effort: revoke on the PC so a copied token is useless; offline PCs keep it until re-pair.
    await client.revokeSelf().catch(() => undefined);
    await clearPairingToken();
    socketRef.current?.stop();
    mirrorRef.current = emptyMirror;
    setMirror(emptyMirror);
    setHealth(null);
    setPairing((p) => ({ ...p, token: null, deviceId: null }));
  }, [client]);

  const newChat = useCallback(async () => (await client.newChat()).chatId, [client]);

  const deliver = useCallback(
    async (target: SendTarget, text: string, id: string) => {
      try {
        if (target.sessionId) await client.sendToSession(target.sessionId, text, id);
        else if (target.chatId) await client.send(target.chatId, text, id);
        else throw new Error('Nothing to send to');
        update((s) => markOutbox(s, id, 'sent'));
      } catch (err) {
        update((s) => markOutbox(s, id, 'failed', describeError(err, pairing.pcName)));
        if (isBridgeError(err) && err.unauthorized) fail(err);
      }
    },
    [client, update, pairing.pcName, fail],
  );

  const send = useCallback(
    async (target: SendTarget, text: string) => {
      const t = text.trim();
      if (!t) return;
      const id = newClientMessageId();
      const sessionId = target.sessionId ?? null;
      const chatId = sessionId ? null : (target.chatId ?? null);
      update((s) => enqueue(s, { clientMessageId: id, chatId, sessionId, text: t }));
      await deliver({ sessionId, chatId }, t, id);
    },
    [update, deliver],
  );

  const retry = useCallback(
    async (id: string) => {
      const item = mirrorRef.current.outbox.find((o) => o.clientMessageId === id);
      if (!item) return;
      update((s) => enqueue(s, { clientMessageId: id, chatId: item.chatId, sessionId: item.sessionId, text: item.text }));
      // same id → Gateway drops it if the first try landed
      await deliver({ sessionId: item.sessionId, chatId: item.chatId }, item.text, id);
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
    activeUrl: baseUrl,
    activeKind: baseUrl ? addressKind(baseUrl) : null,
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
    reresolve,
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
