import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ApprovalCard } from '../components/ApprovalCard';
import { ComposerBar } from '../components/ComposerBar';
import { ConnectionChip } from '../components/ConnectionChip';
import { FilePickerSheet } from '../components/FilePickerSheet';
import {
  createHubClient,
  formatApprovalError,
  formatSenderError,
  isSenderMutationsBlocked,
  livePathDegradedReason,
  shouldQueueSenderFailure,
} from '../hub/client';
import {
  defaultAgentMode,
  type AgentModeId,
  type ComposerOverflowId,
} from '../hub/composer-chrome';
import {
  canFlushOutbound,
  connectionStateLabel,
  deriveConnectionState,
} from '../hub/connection-state';
import { createIdempotencyKey } from '../hub/idempotency';
import {
  HubApiError,
  isWorkspaceBound,
  type ChatMessage,
  type PendingApproval,
  type WorkspaceBound,
} from '../hub/types';
import { HubWebSocket, type HubWsConnectionState } from '../hub/ws';
import type { RootStackParamList } from '../navigation/types';
import { useAppSession } from '../session/AppSessionContext';
import { colors, radii, spacing, type } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'LiveChat'>;

export function LiveChatScreen({ navigation, route }: Props) {
  const { sessionId, title: initialTitle, prefill, autosend } = route.params;
  const session = useAppSession();
  // Stable callbacks only — depending on `session` itself re-creates loaders on every
  // setHealthAndWorkspace and causes an endless refresh / WS reconnect loop.
  const { setHealthAndWorkspace } = session;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [input, setInput] = useState(prefill ?? '');
  /** Native draft — adb `input text` may skip onChangeText until blur/end-editing. */
  const nativeDraftRef = useRef(prefill ?? '');
  const composerRef = useRef<TextInput>(null);
  const autosendDoneRef = useRef(false);
  const [title, setTitle] = useState(initialTitle ?? 'Chat');
  const [busy, setBusy] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wsState, setWsState] = useState<HubWsConnectionState>('idle');
  const [canMessage, setCanMessage] = useState(true);
  const [routeGap, setRouteGap] = useState<string | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);
  const [lastApiError, setLastApiError] = useState<HubApiError | null>(null);
  const [agentMode, setAgentMode] = useState<AgentModeId>(defaultAgentMode());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attachPaths, setAttachPaths] = useState<string[]>([]);
  const wsRef = useRef<HubWebSocket | null>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const degradedReason = livePathDegradedReason(session.health);
  const senderBlocked = isSenderMutationsBlocked(session.health);
  const connectionState = deriveConnectionState({
    hubBaseUrl: session.hubBaseUrl,
    deviceToken: session.deviceToken,
    health: session.health,
    lastError: lastApiError,
    queuedCount,
  });
  // Keep composer editable when Hub is reachable so offline/CDP-down queue works.
  // Send is HTTP POST — WS stream errors must not lock the input (adb Live Send).
  // Selector-stale blocks live inject but still allows a clear send attempt → error.
  // routeGap (missing GET detail) still blocks until session detail loads.
  const inputDisabled = !canMessage || sendBusy || !!routeGap;

  const refreshQueuedCount = useCallback(async () => {
    setQueuedCount(await session.outboundQueue.pendingCount());
  }, [session.outboundQueue]);

  const client = useCallback(() => {
    if (!session.hubBaseUrl || !session.deviceToken) {
      throw new HubApiError(401, 'NOT_PAIRED', 'Not paired');
    }
    return createHubClient({
      baseUrl: session.hubBaseUrl,
      deviceToken: session.deviceToken,
    });
  }, [session.hubBaseUrl, session.deviceToken]);

  const tryFlushQueue = useCallback(async () => {
    const ready = canFlushOutbound({
      hubBaseUrl: session.hubBaseUrl,
      deviceToken: session.deviceToken,
      health: session.health,
      lastError: lastApiError,
    });
    if (!ready) return;
    try {
      const hub = client();
      const result = await session.outboundQueue.flush({
        isReady: true,
        postMessage: (sid, body, key) => hub.postMessage(sid, body, key),
        postApproval: (sid, body, key) => hub.postApproval(sid, body, key),
      });
      await refreshQueuedCount();
      if (result.flushedIds.length > 0) {
        setLastApiError(null);
        setError(null);
      }
    } catch (err) {
      if (err instanceof HubApiError) {
        setLastApiError(err);
        setError(`${err.code}: ${err.message}`);
      }
    }
  }, [
    session.hubBaseUrl,
    session.deviceToken,
    session.health,
    session.outboundQueue,
    lastApiError,
    client,
    refreshQueuedCount,
  ]);

  const loadSession = useCallback(async () => {
    setError(null);
    setRouteGap(null);
    setBusy(true);
    try {
      const hub = client();
      const detail = await hub.getSession(sessionId);
      setTitle(detail.title || initialTitle || 'Live chat');
      setMessages(detail.transcript.messages);
      setCanMessage(detail.capabilities.canMessage && detail.mode === 'live');
      setLastApiError(null);
      try {
        const pending = await hub.getSessionApprovals(sessionId);
        setApprovals(
          pending.items.map((a) => ({
            ...a,
            status: a.status === 'pending' ? 'pending' : a.status,
          })),
        );
      } catch (aprErr) {
        // List route may be missing on older Hub — WS-only still works.
        if (!(aprErr instanceof HubApiError && aprErr.isRouteMissing)) {
          // keep chat usable; approvals arrive via WS
        }
      }
    } catch (err) {
      if (err instanceof HubApiError && err.status === 401) {
        // Keep the token: a 401 can come from a Hub restarted with another data dir.
        // Pair overwrites it on success; Account → Clear pairing still wipes it.
        navigation.replace('Pair');
        return;
      }
      if (err instanceof HubApiError && err.isHubRouteNotShipped) {
        setRouteGap(
          'GET /sessions/:id not on Hub yet — chat UI is ready; waiting on live adapter.',
        );
        setMessages([]);
        setCanMessage(false);
      } else if (err instanceof HubApiError && err.code === 'SESSION_NOT_FOUND') {
        setLastApiError(err);
        setError(`${err.code}: ${err.message}`);
        setCanMessage(true);
      } else if (err instanceof HubApiError) {
        setLastApiError(err);
        setError(`${err.code}: ${err.message}`);
      } else {
        setError(err instanceof Error ? err.message : 'Load failed');
      }
    } finally {
      setBusy(false);
    }
  }, [client, sessionId, initialTitle, navigation]);

  const refreshApprovals = useCallback(async () => {
    try {
      const pending = await client().getSessionApprovals(sessionId);
      setApprovals(
        pending.items.map((a) => ({
          ...a,
          status: a.status === 'pending' ? 'pending' : a.status,
        })),
      );
    } catch {
      // List may be missing on older Hub — WS path still works when Hub pushes.
    }
  }, [client, sessionId]);

  const refreshHealthFromHub = useCallback(async () => {
    try {
      const hub = client();
      const [health, workspace] = await Promise.all([
        hub.getHealth(),
        hub.getWorkspace(),
      ]);
      setHealthAndWorkspace(health, workspace);
    } catch {
      // Mesh flap — connection chip stays on last known health until next success.
    }
  }, [client, setHealthAndWorkspace]);

  useEffect(() => {
    void loadSession();
    void refreshQueuedCount();
  }, [loadSession, refreshQueuedCount]);

  // Fail-closed: poll Hub approvals while Live is open (WS may have missed a push).
  useEffect(() => {
    const id = setInterval(() => {
      void refreshApprovals();
    }, 15_000);
    return () => clearInterval(id);
  }, [refreshApprovals]);

  useEffect(() => {
    if (wsState === 'open') {
      void tryFlushQueue();
      void refreshApprovals();
      void refreshHealthFromHub();
    }
  }, [wsState, tryFlushQueue, refreshApprovals, refreshHealthFromHub]);

  useEffect(() => {
    void tryFlushQueue();
  }, [session.health, tryFlushQueue]);

  useEffect(() => {
    if (!session.hubBaseUrl || !session.deviceToken) return;

    const ws = new HubWebSocket({
      baseUrl: session.hubBaseUrl,
      deviceToken: session.deviceToken,
      subscriptions: { sessions: [sessionId], health: true, workspace: true },
      reconnect: true,
      onState: (state, detail) => {
        setWsState(state);
        if (state === 'error' && detail) {
          setError((prev) => prev ?? detail);
        }
      },
      onEvent: (ev) => {
        switch (ev.type) {
          case 'health.changed': {
            void refreshHealthFromHub();
            break;
          }
          case 'session.message.delta': {
            if (ev.sessionId !== sessionId) return;
            const messageId = String(ev.messageId ?? '');
            const delta = String(ev.delta ?? '');
            setMessages((prev) => {
              const idx = prev.findIndex((m) => m.id === messageId);
              if (idx >= 0) {
                const next = [...prev];
                const cur = next[idx]!;
                next[idx] = {
                  ...cur,
                  content: cur.content + delta,
                  status: 'streaming',
                };
                return next;
              }
              return [
                ...prev,
                {
                  id: messageId,
                  role: 'assistant',
                  content: delta,
                  createdAt: new Date().toISOString(),
                  status: 'streaming',
                },
              ];
            });
            break;
          }
          case 'session.message.completed': {
            if (ev.sessionId !== sessionId) return;
            const message = ev.message as ChatMessage | undefined;
            if (!message?.id) return;
            setMessages((prev) => {
              const idx = prev.findIndex((m) => m.id === message.id);
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = { ...message, status: 'completed' };
                return next;
              }
              return [...prev, { ...message, status: 'completed' }];
            });
            break;
          }
          case 'session.approval.requested': {
            if (ev.sessionId !== sessionId) return;
            const approvalId = String(ev.approvalId ?? '');
            if (!approvalId) return;
            const toolRaw = ev.tool;
            const tool: PendingApproval['tool'] =
              typeof toolRaw === 'string'
                ? { name: toolRaw }
                : toolRaw &&
                    typeof toolRaw === 'object' &&
                    typeof (toolRaw as { name?: unknown }).name === 'string'
                  ? (toolRaw as PendingApproval['tool'])
                  : { name: 'tool' };
            setApprovals((prev) => {
              if (prev.some((a) => a.approvalId === approvalId)) return prev;
              return [
                ...prev,
                {
                  approvalId,
                  sessionId,
                  tool,
                  summary: String(ev.summary ?? 'Tool call pending'),
                  argsPreview: ev.argsPreview,
                  createdAt: String(ev.createdAt ?? new Date().toISOString()),
                  expiresAt: (ev.expiresAt as string | null | undefined) ?? null,
                  status: 'pending',
                  synthetic: Boolean(ev.synthetic),
                },
              ];
            });
            break;
          }
          case 'session.approval.resolved': {
            const approvalId = String(ev.approvalId ?? '');
            const decision = String(ev.decision ?? '');
            setApprovals((prev) =>
              prev.map((a) =>
                a.approvalId === approvalId
                  ? {
                      ...a,
                      status:
                        decision === 'approve'
                          ? 'approved'
                          : decision === 'deny'
                            ? 'denied'
                            : a.status,
                    }
                  : a,
              ),
            );
            break;
          }
          case 'error': {
            setError(String(ev.message ?? ev.code ?? 'Stream error'));
            break;
          }
          default:
            break;
        }
      },
    });
    wsRef.current = ws;
    ws.connect();
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [
    session.hubBaseUrl,
    session.deviceToken,
    sessionId,
    refreshHealthFromHub,
  ]);

  const send = async (overrideContent?: string) => {
    const content = (
      overrideContent?.trim() ||
      input.trim() ||
      nativeDraftRef.current.trim()
    );
    if (!content || inputDisabled) return;
    setSendBusy(true);
    setError(null);
    const idempotencyKey = createIdempotencyKey('msg');
    const clientMessageId = createIdempotencyKey('cmsg');
    try {
      const res = await client().postMessage(
        sessionId,
        { content, clientMessageId },
        idempotencyKey,
      );
      setMessages((prev) => [
        ...prev,
        {
          id: res.messageId,
          role: 'user',
          content: res.content,
          createdAt: res.createdAt,
          status: 'completed',
        },
      ]);
      setInput('');
      nativeDraftRef.current = '';
      setLastApiError(null);
      if (res.domApplied === false) {
        setError(
          'Hub accepted the message but Composer DOM was not driven (sender not verified).',
        );
      }
    } catch (err) {
      if (err instanceof HubApiError && shouldQueueSenderFailure(err)) {
        await session.outboundQueue.enqueueMessage({
          sessionId,
          content,
          clientMessageId,
          idempotencyKey,
        });
        await refreshQueuedCount();
        setLastApiError(err);
        setMessages((prev) => [
          ...prev,
          {
            id: clientMessageId,
            role: 'user',
            content,
            createdAt: new Date().toISOString(),
            status: 'completed',
          },
        ]);
        setInput('');
        const reason =
          err.code === 'NETWORK_ERROR'
            ? 'Queued offline — will send once Ready (same Idempotency-Key).'
            : `${formatSenderError(err)} Queued — will flush when CDP is up and selectors VERIFIED.`;
        setError(reason);
      } else if (err instanceof HubApiError && err.isRouteMissing) {
        setError('POST /sessions/:id/messages not on Hub yet.');
      } else if (err instanceof HubApiError) {
        setLastApiError(err);
        setError(formatSenderError(err));
      } else {
        setError(err instanceof Error ? err.message : 'Send failed');
      }
    } finally {
      setSendBusy(false);
    }
  };

  useEffect(() => {
    if (!autosend || autosendDoneRef.current) return;
    if (inputDisabled || busy || sendBusy) return;
    const text = (prefill ?? input).trim();
    if (!text) return;
    autosendDoneRef.current = true;
    nativeDraftRef.current = text;
    setInput(text);
    void send(text);
  }, [autosend, prefill, input, inputDisabled, busy, sendBusy]);

  const decide = async (approvalId: string, decision: 'approve' | 'deny') => {
    setApprovalBusy(true);
    setError(null);
    const idempotencyKey = createIdempotencyKey(`apr-${decision}`);
    try {
      const res = await client().postApproval(
        sessionId,
        { approvalId, decision },
        idempotencyKey,
      );
      setApprovals((prev) =>
        prev.map((a) =>
          a.approvalId === approvalId
            ? { ...a, status: decision === 'approve' ? 'approved' : 'denied' }
            : a,
        ),
      );
      setLastApiError(null);
      if (res.synthetic || res.domApplied === false) {
        setError(
          res.note ??
            'Decision recorded on Hub — Cursor DOM was not clicked (synthetic/UAT or fail-closed).',
        );
      }
    } catch (err) {
      if (err instanceof HubApiError && shouldQueueSenderFailure(err)) {
        // User already tapped — queue that decision; never invent Approve on flush.
        await session.outboundQueue.enqueueApproval({
          sessionId,
          approvalId,
          decision,
          idempotencyKey,
        });
        await refreshQueuedCount();
        setLastApiError(err);
        setApprovals((prev) =>
          prev.map((a) =>
            a.approvalId === approvalId
              ? {
                  ...a,
                  status: decision === 'approve' ? 'approved' : 'denied',
                }
              : a,
          ),
        );
        setError(
          err.code === 'NETWORK_ERROR'
            ? `Approval "${decision}" queued offline — will apply on Ready (no silent auto-approve).`
            : `${formatApprovalError(err)} Approval "${decision}" queued until CDP is up.`,
        );
      } else if (err instanceof HubApiError && err.isRouteMissing) {
        setError('POST /sessions/:id/approvals not on Hub yet.');
      } else if (err instanceof HubApiError) {
        setLastApiError(err);
        // Keep card pending so operator can retry after pack verify / CDP.
        setError(formatApprovalError(err));
      } else {
        setError(err instanceof Error ? err.message : 'Approval failed');
      }
    } finally {
      setApprovalBusy(false);
    }
  };

  const pendingApprovals = approvals.filter((a) => a.status === 'pending');
  const projectName =
    session.workspace && isWorkspaceBound(session.workspace)
      ? session.workspace.name
      : null;
  const boundWs: WorkspaceBound | null =
    session.workspace && isWorkspaceBound(session.workspace) ? session.workspace : null;

  const onOverflow = async (id: ComposerOverflowId) => {
    if (id === 'attach') {
      if (!boundWs) {
        setError('No PC project bound — open a folder in Cursor, then attach.');
        return;
      }
      setPickerOpen(true);
      return;
    }
    if (id === 'mention') {
      const next = `${nativeDraftRef.current}@`;
      nativeDraftRef.current = next;
      setInput(next);
      setError('Inserted @ — Hub @-mention picker is designed (partial).');
      return;
    }
    if (id === 'slash') {
      const next = `${nativeDraftRef.current}/`;
      nativeDraftRef.current = next;
      setInput(next);
      setError('Inserted / — slash menu is designed (partial).');
      return;
    }
    if (id === 'mic' || id === 'camera') {
      setError(
        id === 'mic'
          ? 'Voice is designed — not wired to Hub yet.'
          : 'Camera is designed — attach workspace images via Attach file.',
      );
    }
  };

  const applyAttachments = async (paths: string[]) => {
    setAttachPaths(paths);
    if (paths.length === 0) return;
    try {
      await client().postAttachments(
        sessionId,
        { attachments: paths, mode: 'add' },
        createIdempotencyKey('attach'),
      );
      setError(null);
    } catch (err) {
      if (err instanceof HubApiError && err.isHubRouteNotShipped) {
        setError('POST /sessions/:id/attachments not on Hub yet (designed).');
        return;
      }
      setError(err instanceof Error ? err.message : 'Attach failed');
    }
  };

  const closePicker = () => {
    setPickerOpen(false);
    if (attachPaths.length > 0) {
      void applyAttachments(attachPaths);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={88}
    >
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {title}
          </Text>
          <ConnectionChip
            state={connectionState}
            onPress={() => navigation.navigate('Health')}
          />
        </View>
        <Text style={styles.headerMeta} numberOfLines={1}>
          {[projectName, wsState !== 'open' ? `WS ${wsState}` : null, queuedCount > 0 ? `queue ${queuedCount}` : null]
            .filter(Boolean)
            .join(' · ')}
        </Text>
        {connectionState !== 'Ready' ? (
          <Text style={styles.warn}>{connectionStateLabel(connectionState)}</Text>
        ) : null}
        {degradedReason ? <Text style={styles.warn}>{degradedReason}</Text> : null}
        {senderBlocked && !degradedReason ? (
          <Text style={styles.warn}>
            Sender blocked until CDP / selectors are ready on the PC.
          </Text>
        ) : null}
        {routeGap ? <Text style={styles.warn}>{routeGap}</Text> : null}
        {attachPaths.length > 0 ? (
          <Text style={styles.headerMeta} numberOfLines={1}>
            Attached {attachPaths.length} file(s)
          </Text>
        ) : null}
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {busy ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          style={styles.list}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={styles.listContent}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          ListHeaderComponent={
            pendingApprovals.length ? (
              <View>
                {pendingApprovals.map((a) => (
                  <ApprovalCard
                    key={a.approvalId}
                    approval={a}
                    busy={approvalBusy}
                    onApprove={(id) => void decide(id, 'approve')}
                    onDeny={(id) => void decide(id, 'deny')}
                  />
                ))}
              </View>
            ) : null
          }
          ListEmptyComponent={
            <Text style={styles.empty}>
              {routeGap
                ? 'Waiting for Hub live session detail.'
                : 'No messages yet. Send a prompt — tools run on the PC.'}
            </Text>
          }
          renderItem={({ item }) => (
            <View
              style={[
                styles.bubble,
                item.role === 'user' ? styles.userBubble : styles.assistantBubble,
              ]}
            >
              <Text style={styles.bubbleText}>{item.content}</Text>
              {item.status === 'streaming' ? (
                <Text style={styles.streaming}>streaming…</Text>
              ) : null}
            </View>
          )}
        />
      )}

      <ComposerBar
        inputRef={composerRef}
        defaultValue={prefill ?? ''}
        placeholder={
          inputDisabled
            ? 'Input disabled — check Health'
            : senderBlocked
              ? 'Message (queues until Ready)…'
              : 'Message…'
        }
        editable={!inputDisabled}
        sendBusy={sendBusy}
        sendDisabled={inputDisabled}
        agentMode={agentMode}
        attachAvailable={!!boundWs}
        onChangeText={(t) => {
          nativeDraftRef.current = t;
          setInput(t);
        }}
        onEndEditing={(native) => {
          nativeDraftRef.current = native;
          setInput(native);
        }}
        onSend={() => {
          composerRef.current?.blur();
          Keyboard.dismiss();
          setTimeout(() => void send(), 200);
        }}
        onAgentModeChange={setAgentMode}
        onOverflowAction={(id) => void onOverflow(id)}
      />

      {boundWs && session.hubBaseUrl && session.deviceToken ? (
        <FilePickerSheet
          visible={pickerOpen}
          workspace={boundWs}
          selected={attachPaths}
          onChangeSelected={setAttachPaths}
          onClose={closePicker}
          client={createHubClient({
            baseUrl: session.hubBaseUrl,
            deviceToken: session.deviceToken,
          })}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
    gap: 2,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  headerTitle: {
    flex: 1,
    color: colors.text,
    fontSize: 18,
    fontWeight: '600',
  },
  headerMeta: { color: colors.muted, fontSize: 12 },
  warn: { color: colors.warn, fontSize: 12, marginTop: 4 },
  error: {
    color: colors.danger,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    fontSize: 13,
  },
  list: { flex: 1 },
  // Same flex as the list so the composer stays pinned to the bottom while loading.
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  listContent: { padding: spacing.md, paddingBottom: spacing.xl },
  empty: {
    color: colors.muted,
    textAlign: 'center',
    marginTop: spacing.xl,
    fontSize: type.body,
    lineHeight: 22,
  },
  bubble: {
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    maxWidth: '92%',
  },
  userBubble: {
    backgroundColor: colors.bubbleUser,
    alignSelf: 'flex-end',
  },
  assistantBubble: {
    backgroundColor: colors.bubbleAssistant,
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  bubbleText: { color: colors.text, fontSize: 15, lineHeight: 22 },
  streaming: { color: colors.warn, fontSize: 11, marginTop: 4 },
});
