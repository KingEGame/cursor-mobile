import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Pressable,
  FlatList,
  Share,
  StyleSheet,
  Text,
  View,
  AppState,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ArrowLeft } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApprovalCard } from '../components/ApprovalCard';
import { Markdown } from '../components/Markdown';
import { dayLabel, lastToolStep, sameDay } from '../chat/format';
import { stabilize } from '../chat/stable';
import { AssistantRow, DayRow, OutgoingRow, ToolRow, UserRow, WorkingBar, type ChatRow } from '../chat/ChatRows';
import { buzz } from '../chat/feedback';
import {
  addOutgoing,
  dropOutgoing,
  markFailed,
  markSending,
  markSent,
  newOutgoingId,
  reconcile,
  type OutgoingMessage,
} from '../chat/outgoing';
import { useReducedMotion } from '../chat/useReducedMotion';
import { useDraftSync } from '../chat/useDraftSync';
import { CalmEnter } from '../motion/calmEnter';
import { ChatComposer, type ComposerSubmit } from '../composer/ChatComposer';
import { loadLockSettings, unlock } from '../security/app-lock';
import { cursorProblem } from '../hub/agents-list';
import { createHubClient } from '../hub/client';
import { describeSendFailure, sendFailureText } from '../hub/send-errors';
import { HubApiError, type ChatMessage, type ComposerOptions, type PendingApproval } from '../hub/types';
import type { RootStackParamList } from '../navigation/types';
import { useAppSession } from '../session/AppSessionContext';
import { colors, radii, spacing, type, weight, lineHeight } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'HistoryRead'>;

/** Re-read the chat from the PC while it is open, so agent replies show up. */
const POLL_MS = 4_000;
/** Slower while the agent is idle; the Hub pushes no events for Agents-chat transcripts. */
const IDLE_POLL_MS = 8_000;

/** Opens the system share sheet (which includes Copy). */
function shareText(text: string) {
  void Share.share({ message: text }).catch(() => undefined);
}

/** `hist_<composerId>` → composerId (Agents-window chats only). */
function composerIdFromSession(sessionId: string): string | null {
  return sessionId.startsWith('hist_') && !sessionId.startsWith('hist_cli_')
    ? sessionId.slice('hist_'.length)
    : null;
}

/**
 * One Cursor Agents chat on the PC: read the transcript and send follow-ups.
 * Sending makes the Hub open this chat on the PC and type into it — no "Open on PC" step.
 */
export function HistoryReadScreen({ navigation, route }: Props) {
  const session = useAppSession();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const scrollRef = useRef<FlatList<ChatRow>>(null);
  const atBottom = useRef(true);
  /** Set when the operator just acted (sent / failed): stay pinned to the end until they drag. */
  const stick = useRef(false);
  const { sessionId, title } = route.params;
  const composerId = composerIdFromSession(sessionId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  /** Earlier message being edited from the phone (Cursor re-runs from it). */
  const [editing, setEditing] = useState<{ messageId: string; text: string } | null>(null);
  /** Sent from the phone: sending / sent / failed until the PC transcript shows them. */
  const [outgoing, setOutgoing] = useState<OutgoingMessage<ComposerOptions>[]>([]);
  /** Live run state of this chat on the PC (from the Agents sidebar). */
  const [running, setRunning] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [keyboardUp, setKeyboardUp] = useState(false);
  const [composerHasAttachments, setComposerHasAttachments] = useState(false);
  /** Reader scrolled up while newer messages arrived. */
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const seenCount = useRef(0);
  /** Error banner Cursor shows on the PC (e.g. needs Reload Window). */
  const [cursorAlert, setCursorAlert] = useState<string | null>(null);
  /** Totals of files this chat changed on the PC (null until loaded / none). */
  const [changes, setChanges] = useState<{ files: number; added: number; removed: number } | null>(
    null,
  );

  const client = useMemo(() => {
    if (!session.hubBaseUrl || !session.deviceToken) return null;
    return createHubClient({ baseUrl: session.hubBaseUrl, deviceToken: session.deviceToken });
  }, [session.hubBaseUrl, session.deviceToken]);

  const load = useCallback(async () => {
    if (!client) {
      navigation.replace('Pair');
      return;
    }
    try {
      const [packed, agents] = await Promise.all([
        client.getSessionMessages(sessionId),
        client.listAgents().catch(() => null),
      ]);
      setMessages((prev) => stabilize(prev, packed.messages));
      setCursorAlert(cursorProblem(agents));
      if (agents && composerId) {
        const chat = agents.projects.flatMap((p) => p.chats).find((c) => c.composerId === composerId);
        setRunning(chat?.status === 'working');
        setWaiting(chat?.status === 'waiting_approval');
      }
      // Phone-sent messages that the PC transcript now contains are real messages.
      setOutgoing((prev) => reconcile(prev, packed.messages));
      setError(null);
    } catch (err) {
      setError(
        err instanceof HubApiError
          ? `Couldn’t load this chat — ${sendFailureText(err.code, err.status, err.message)}`
          : 'Couldn’t load this chat — check your connection.',
      );
    } finally {
      setLoading(false);
    }
  }, [client, sessionId, composerId, navigation]);

  useEffect(() => {
    void load();
    const id = setInterval(
      () => {
        if (AppState.currentState === 'active') void load();
      },
      running || waiting ? POLL_MS : IDLE_POLL_MS,
    );
    return () => clearInterval(id);
  }, [load, running, waiting]);

  // With the keyboard up the home-indicator inset is covered; padding for it leaves a gap.
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardUp(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardUp(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // A phone-sent message was added or changed state (e.g. failed with Retry): keep it in view.
  const outgoingKey = outgoing.map((m) => `${m.id}:${m.state}`).join('|');
  useEffect(() => {
    if (!outgoingKey) return;
    atBottom.current = true;
    stick.current = true;
    const end = () => scrollRef.current?.scrollToEnd({ animated: false });
    requestAnimationFrame(end);
    // The failed bubble grows after the first layout pass; scroll again once it has.
    const t = setTimeout(end, 200);
    return () => clearTimeout(t);
  }, [outgoingKey]);

  // Pending tool approvals, when the Hub can list them for this chat.
  useEffect(() => {
    if (!client || !waiting) {
      setApprovals([]);
      return;
    }
    let cancelled = false;
    client
      .getSessionApprovals(sessionId)
      .then((r) => !cancelled && setApprovals(r.items.filter((a) => a.status === 'pending')))
      .catch(() => !cancelled && setApprovals([]));
    return () => {
      cancelled = true;
    };
  }, [client, waiting, sessionId, messages.length]);

  // Re-count changed files whenever the transcript grows (a turn may have edited files).
  useEffect(() => {
    if (!client || !composerId) return;
    let cancelled = false;
    client
      .listChatChanges(composerId)
      .then(({ files }) => {
        if (cancelled) return;
        setChanges(
          files.length === 0
            ? null
            : {
                files: files.length,
                added: files.reduce((n, f) => n + f.added, 0),
                removed: files.reduce((n, f) => n + f.removed, 0),
              },
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, composerId, messages.length]);

  // New messages while the reader is scrolled up: count them instead of yanking the view.
  useEffect(() => {
    const fresh = messages.length - seenCount.current;
    seenCount.current = messages.length;
    if (fresh > 0 && !atBottom.current) setUnseen((n) => n + fresh);
  }, [messages.length]);

  /** One send attempt for a tracked outgoing message; updates its delivery state. */
  const deliver = async (id: string, text: string, options: ComposerOptions) => {
    if (!client || !composerId) return;
    try {
      await client.sendToAgentChat(composerId, text, options);
      setOutgoing((prev) => markSent(prev, id));
      buzz('sent');
      setTimeout(() => void load(), 1_500);
    } catch (err) {
      const info = err instanceof HubApiError ? describeSendFailure(err.code, err.status) : null;
      const reason =
        err instanceof HubApiError
          ? sendFailureText(err.code, err.status, err.message)
          : 'Could not reach your PC. Check Tailscale on both devices.';
      setOutgoing((prev) => markFailed(prev, id, reason, info ? info.definitelyNotSent : false));
      buzz('error');
    }
  };

  const submit = async ({ text, options }: ComposerSubmit): Promise<boolean> => {
    if (!client || !composerId || sending) return false;
    setSending(true);
    setError(null);
    try {
      // Sending makes an agent act on the PC — optional unlock (Account → Security).
      const { lockSend } = await loadLockSettings();
      if (!(await unlock(lockSend, 'Unlock to send to your PC'))) {
        setError('Not sent — unlock was cancelled. Your text is still in the box.');
        return false;
      }
      atBottom.current = true;
      if (editing) {
        try {
          await client.editAgentMessage(composerId, editing.messageId, text);
          setEditing(null);
          setTimeout(() => void load(), 1_500);
          buzz('sent');
          return true;
        } catch (err) {
          setError(
            err instanceof HubApiError
              ? `Not saved — ${sendFailureText(err.code, err.status, err.message)}`
              : 'Not saved — check the connection.',
          );
          buzz('error');
          return false;
        }
      }
      // The message appears at once as "Sending…" and keeps its text if it fails.
      const id = newOutgoingId();
      setOutgoing((prev) => addOutgoing(prev, text, options, id));
      draftSync.reset();
      await deliver(id, text, options);
      return true;
    } finally {
      setSending(false);
    }
  };

  const retry = (m: OutgoingMessage<ComposerOptions>) => {
    setOutgoing((prev) => markSending(prev, m.id));
    void deliver(m.id, m.text, m.options);
  };

  /** One tap, per the UI-SPEC: Stop is the send button while the agent runs. */
  const stop = async () => {
    if (!client || !composerId || stopping) return;
    setStopping(true);
    setError(null);
    try {
      await client.stopAgentChat(composerId);
      setRunning(false);
      setTimeout(() => void load(), 1_500);
    } catch (err) {
      setError(
        err instanceof HubApiError
          ? `Not stopped — ${sendFailureText(err.code, err.status, err.message)}`
          : 'Not stopped — check the connection.',
      );
      buzz('error');
    } finally {
      setStopping(false);
    }
  };

  const decide = async (approvalId: string, decision: 'approve' | 'deny') => {
    if (!client || approvalBusy) return;
    setApprovalBusy(true);
    try {
      // Approving lets a tool run on the PC: ask for fingerprint / PIN first (deny never asks).
      if (decision === 'approve') {
        const { lockApprove } = await loadLockSettings();
        if (!(await unlock(lockApprove, 'Unlock to approve tools on your PC'))) {
          setError('Not approved — unlock was cancelled.');
          return;
        }
      }
      await client.postApproval(sessionId, { approvalId, decision });
      buzz('approved');
      setApprovals((prev) => prev.filter((a) => a.approvalId !== approvalId));
      setTimeout(() => void load(), 1_000);
    } catch (err) {
      setError(
        err instanceof HubApiError
          ? `${decision === 'approve' ? 'Not approved' : 'Not denied'} — ${sendFailureText(err.code, err.status, err.message)}`
          : 'Could not reach your PC. Check Tailscale on both devices.',
      );
      buzz('error');
    } finally {
      setApprovalBusy(false);
    }
  };

  /** Raise Cursor on the PC and show this chat there (e.g. to approve a tool). */
  const openOnPc = async () => {
    if (!client || !composerId) return;
    try {
      await client.openAgentChatOnPc(composerId);
      buzz('sent');
      setNotice('Opened on your PC.');
      setTimeout(() => setNotice(null), 4_000);
    } catch (err) {
      setError(
        err instanceof HubApiError
          ? `Couldn’t open it on your PC — ${sendFailureText(err.code, err.status, err.message)}`
          : 'Couldn’t open it on your PC — check the connection.',
      );
      buzz('error');
    }
  };

  const jumpToLatest = () => {
    atBottom.current = true;
    setAway(false);
    setUnseen(0);
    scrollRef.current?.scrollToEnd({ animated: !reduceMotion });
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const bottom = contentOffset.y + layoutMeasurement.height >= contentSize.height - 48;
    atBottom.current = bottom;
    const isAway = !bottom;
    setAway((prev) => (prev === isAway ? prev : isAway));
    if (bottom) setUnseen((n) => (n === 0 ? n : 0));
  };

  const draftSync = useDraftSync({
    client,
    composerId,
    enabled: !!composerId && !editing && !sending && !composerHasAttachments,
  });
  const onDraftChange = useCallback(
    (text: string, hasAttachments: boolean) => {
      setComposerHasAttachments(hasAttachments);
      draftSync.onLocalChange(text);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draftSync.onLocalChange],
  );
  const step = lastToolStep(messages);
  // At most two status strips above the composer, by priority, so the transcript keeps its room.
  const strips = [!!error, !!cursorAlert, waiting, running, !!(changes && composerId)];
  const shown = new Set<number>();
  strips.forEach((on, i) => {
    if (on && shown.size < 2) shown.add(i);
  });
  const showError = shown.has(0);
  const showAlert = shown.has(1);
  const showWaiting = shown.has(2);
  const showRunning = shown.has(3);
  const showChanges = shown.has(4);
  const editingId = editing?.messageId ?? null;
  const startEdit = useCallback((id: string, text: string) => setEditing({ messageId: id, text }), []);
  const discard = useCallback((id: string) => setOutgoing((prev) => dropOutgoing(prev, id)), []);

  const rows: ChatRow[] = useMemo(() => {
    const out: ChatRow[] = [];
    let inAgentTurn = false;
    messages.forEach((m, i) => {
      const prev = messages[i - 1];
      if (m.createdAt && (!prev || !sameDay(prev.createdAt, m.createdAt))) {
        out.push({ kind: 'day', id: `day-${m.id}`, label: dayLabel(m.createdAt) });
      }
      if (m.role === 'system') out.push({ kind: 'tool', id: m.id, text: m.content });
      else if (m.role === 'user') {
        inAgentTurn = false;
        out.push({ kind: 'user', id: m.id, msg: m });
      } else {
        // Agent identity heads each agent turn once, not every message in it.
        out.push({ kind: 'assistant', id: m.id, msg: m, lead: !inAgentTurn });
        inAgentTurn = true;
      }
    });
    return out;
  }, [messages]);

  const renderRow = useCallback(
    ({ item }: { item: ChatRow }) => {
      switch (item.kind) {
        case 'day':
          return <DayRow label={item.label} />;
        case 'tool':
          return <ToolRow text={item.text} />;
        case 'user':
          return <UserRow msg={item.msg} editing={editingId === item.id} onShare={shareText} onEdit={startEdit} />;
        default:
          return <AssistantRow msg={item.msg} lead={item.lead} onShare={shareText} />;
      }
    },
    [editingId, startEdit],
  );

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior="padding"
      keyboardVerticalOffset={0}
    >
      <View style={[styles.header, { paddingTop: insets.top }]}>
        <Pressable
          onPress={() => navigation.goBack()}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Back to chats"
          testID="chat-back"
        >
          <ArrowLeft size={22} color={colors.text} strokeWidth={1.75} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1} accessibilityRole="header">
          {title?.trim() || 'Chat'}
        </Text>
      </View>
      <View style={styles.scroll}>
        <FlatList
          ref={scrollRef}
          style={styles.scroll}
          contentContainerStyle={styles.content}
          data={rows}
          keyExtractor={(r) => r.id}
          renderItem={renderRow}
          onScroll={onScroll}
          onScrollBeginDrag={() => {
            stick.current = false;
          }}
          onLayout={() => {
            // A status strip appearing shrinks the list; keep the newest message in view.
            if (stick.current || atBottom.current) {
              requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
            }
          }}
          scrollEventThrottle={100}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={12}
          windowSize={9}
          removeClippedSubviews
          // Follow new messages only when the reader is already at the bottom.
          onContentSizeChange={() => {
            if (atBottom.current || stick.current) {
              // Android drops a scroll issued during a layout pass; wait one frame.
              requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
            }
          }}
          ListHeaderComponent={
            loading ? (
              <View style={styles.loadingRow} accessibilityLiveRegion="polite">
                <ActivityIndicator color={colors.accent} />
                <Text style={styles.muted}>Loading this chat from your PC…</Text>
              </View>
            ) : null
          }
          ListFooterComponent={
            <View style={styles.footer}>
              {outgoing.map((m) => (
                <CalmEnter key={m.id}>
                  <OutgoingRow m={m} onRetry={retry} onDiscard={discard} />
                </CalmEnter>
              ))}
              {!loading && messages.length === 0 && outgoing.length === 0 ? (
                <View style={styles.emptyBox}>
                  <Text style={styles.emptyTitle}>No messages in this chat</Text>
                  <Text style={styles.muted}>
                    Tell Cursor what you want done. It runs on your PC and its reply shows up here.
                  </Text>
                  <Pressable
                    onPress={() => void openOnPc()}
                    style={styles.cta}
                    accessibilityRole="button"
                    accessibilityLabel="Open this chat on your PC"
                  >
                    <Text style={styles.ctaText}>Open on PC</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          }
        />
        {away ? (
          <CalmEnter style={styles.jumpWrap}>
          <Pressable
            onPress={jumpToLatest}
            style={styles.jump}
            accessibilityRole="button"
            accessibilityLabel={unseen > 0 ? `Jump to latest, ${unseen} new message${unseen === 1 ? '' : 's'}` : 'Jump to latest'}
            testID="chat-jump-latest"
          >
            <Text style={styles.jumpText}>{unseen > 0 ? `${unseen} new ↓` : 'Latest ↓'}</Text>
          </Pressable>
          </CalmEnter>
        ) : null}
      </View>

      {showError ? (
        <View style={styles.errorBar} accessibilityLiveRegion="assertive">
          <Text style={styles.errorText}>{error}</Text>
          <Pressable
            onPress={() => setError(null)}
            style={styles.action}
            accessibilityRole="button"
            accessibilityLabel="Dismiss message"
          >
            <Text style={styles.actionText}>Dismiss</Text>
          </Pressable>
        </View>
      ) : null}
      {showAlert ? (
        <Text style={styles.cursorAlert} testID="chat-cursor-alert" accessibilityLiveRegion="polite">
          {cursorAlert}
        </Text>
      ) : null}

      {showWaiting ? (
        <CalmEnter>
        <View style={styles.waitingBox} accessibilityLiveRegion="polite" testID="chat-waiting">
          <Text style={styles.waitingTitle}>Waiting for your approval</Text>
          {approvals.length > 0 ? (
            approvals.map((a) => (
              <ApprovalCard
                key={a.approvalId}
                approval={a}
                busy={approvalBusy}
                onApprove={(id) => void decide(id, 'approve')}
                onDeny={(id) => void decide(id, 'deny')}
              />
            ))
          ) : (
            <>
              <Text style={styles.waitingText}>
                Cursor wants to run a tool. The request can’t be shown here yet, so approve or deny it on your PC.
              </Text>
              <Pressable
                onPress={() => void openOnPc()}
                style={styles.cta}
                accessibilityRole="button"
                accessibilityLabel="Open this chat on your PC to approve"
                testID="chat-open-on-pc"
              >
                <Text style={styles.ctaText}>Open on PC</Text>
              </Pressable>
            </>
          )}
        </View>
        </CalmEnter>
      ) : null}
      {notice ? (
        <Text style={styles.notice} accessibilityLiveRegion="polite">
          {notice}
        </Text>
      ) : null}

      {showRunning ? (
        <CalmEnter>
          <WorkingBar stopping={stopping} step={step} />
        </CalmEnter>
      ) : null}

      {showChanges && changes && composerId ? (
        <Pressable
          style={styles.changesBar}
          onPress={() => navigation.navigate('ChatChanges', { composerId, title })}
          accessibilityRole="button"
          accessibilityLabel={`${changes.files} files changed, view changes`}
          testID="chat-changes"
        >
          <Text style={styles.changesText}>
            {changes.files} file{changes.files === 1 ? '' : 's'} changed{'  '}
            <Text style={styles.plus}>+{changes.added}</Text>{' '}
            <Text style={styles.minus}>−{changes.removed}</Text>
          </Text>
          <Text style={styles.changesLink}>View changes ›</Text>
        </Pressable>
      ) : null}

      {draftSync.conflict ? (
        <View style={styles.conflictBox} accessibilityLiveRegion="polite" testID="chat-draft-conflict">
          <Text style={styles.conflictTitle}>Different text on your PC</Text>
          <Text style={styles.conflictText} numberOfLines={2}>
            PC: {draftSync.conflict.pc}
          </Text>
          <View style={styles.actionsRow}>
            <Pressable
              onPress={draftSync.usePc}
              style={styles.action}
              accessibilityRole="button"
              accessibilityLabel="Use the text from the PC"
            >
              <Text style={styles.actionText}>Use PC text</Text>
            </Pressable>
            <Pressable
              onPress={() => void draftSync.keepMine()}
              style={styles.action}
              accessibilityRole="button"
              accessibilityLabel="Keep my text and replace the PC text"
            >
              <Text style={styles.actionText}>Keep mine</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {composerId ? (
        <ChatComposer
          client={client}
          composerId={composerId}
          running={running}
          busy={sending}
          bottomInset={keyboardUp ? 0 : insets.bottom}
          editingText={editing?.text ?? null}
          onCancelEdit={() => setEditing(null)}
          onSubmit={submit}
          onStop={() => void stop()}
          externalText={draftSync.adopted}
          onDraftChange={onDraftChange}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  // 40dp bar instead of the 56dp system header.
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  backBtn: { width: 48, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, color: colors.text, fontSize: type.body, fontWeight: weight.semibold, paddingRight: spacing.md },
  scroll: { flex: 1 },
  content: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.lg },
  footer: { gap: spacing.sm },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dayDivider: { alignSelf: 'center', color: colors.muted, fontSize: type.meta, fontWeight: weight.semibold, marginVertical: spacing.xs },
  errorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.md,
    backgroundColor: colors.dangerSoft,
  },
  errorText: { flex: 1, color: colors.danger, fontSize: type.meta, lineHeight: lineHeight.body, paddingVertical: spacing.sm },
  cursorAlert: {
    color: colors.danger,
    backgroundColor: colors.surfaceMuted,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: type.meta,
  },
  bubble: {
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  // UI-SPEC B: wide light-gray user bubble; agent text flush on the canvas.
  user: { backgroundColor: colors.bubbleUser, marginLeft: spacing.lg },
  editingBubble: { borderWidth: 1, borderColor: colors.warn },
  failedBubble: { borderWidth: 1, borderColor: colors.danger, backgroundColor: colors.dangerSoft },
  assistant: { paddingHorizontal: spacing.xs, paddingVertical: spacing.xs, gap: spacing.xs },
  pending: { opacity: 0.75 },
  body: { color: colors.text, fontSize: type.body, lineHeight: lineHeight.body },
  muted: { color: colors.muted, fontSize: type.body, lineHeight: lineHeight.body },
  time: { color: colors.muted, fontSize: type.meta },
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  actionsRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  action: { minHeight: 48, minWidth: 48, paddingHorizontal: spacing.sm, alignItems: 'center', justifyContent: 'center' },
  actionText: { color: colors.muted, fontSize: type.meta, fontWeight: weight.semibold },
  retry: { backgroundColor: colors.danger, borderRadius: radii.pill, paddingHorizontal: spacing.md },
  retryText: { color: colors.onDark, fontSize: type.meta, fontWeight: weight.semibold },
  delivery: { color: colors.muted, fontSize: type.meta, lineHeight: lineHeight.meta },
  deliveryFailed: { color: colors.danger, fontWeight: weight.semibold },
  toolLine: { color: colors.muted, fontSize: type.meta, paddingHorizontal: spacing.sm },
  emptyBox: { gap: spacing.xs, paddingVertical: spacing.lg },
  emptyTitle: { color: colors.text, fontSize: type.body, fontWeight: weight.semibold },
  jumpWrap: { position: 'absolute', right: spacing.md, bottom: spacing.md },
  jump: {
    minHeight: 48,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  jumpText: { color: colors.onDark, fontSize: type.meta, fontWeight: weight.semibold },
  cta: {
    alignSelf: 'flex-start',
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaText: { color: colors.onDark, fontSize: type.body, fontWeight: weight.semibold },
  conflictBox: { backgroundColor: colors.warnSoft, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  conflictTitle: { color: colors.warnText, fontSize: type.meta, fontWeight: weight.semibold },
  conflictText: { color: colors.warnText, fontSize: type.meta, lineHeight: lineHeight.meta },
  notice: { color: colors.accent, fontSize: type.meta, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  waitingBox: { backgroundColor: colors.warnSoft, padding: spacing.md, gap: spacing.xs },
  waitingTitle: { color: colors.warnText, fontSize: type.body, fontWeight: weight.semibold },
  waitingText: { color: colors.warnText, fontSize: type.meta, lineHeight: lineHeight.body },
  changesBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 40,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  changesText: { color: colors.text, fontSize: type.meta },
  workingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    backgroundColor: colors.accentSoft,
  },
  workingCol: { flex: 1 },
  workingText: { color: colors.text, fontSize: type.meta, fontWeight: weight.semibold },
  workingStep: { color: colors.muted, fontSize: type.meta },
  changesLink: { color: colors.accent, fontSize: type.meta, fontWeight: weight.semibold },
  plus: { color: colors.accent },
  minus: { color: colors.danger },
});
