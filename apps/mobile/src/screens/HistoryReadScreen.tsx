import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Markdown } from '../components/Markdown';
import { loadLockSettings, unlock } from '../security/app-lock';
import { createHubClient } from '../hub/client';
import { HubApiError, type ChatMessage } from '../hub/types';
import type { RootStackParamList } from '../navigation/types';
import { useAppSession } from '../session/AppSessionContext';
import { colors, radii, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'HistoryRead'>;

/** Re-read the chat from the PC while it is open, so agent replies show up. */
const POLL_MS = 4_000;

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
  const scrollRef = useRef<ScrollView>(null);
  const atBottom = useRef(true);
  const { sessionId, title } = route.params;
  const composerId = composerIdFromSession(sessionId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  /** Sent from the phone but not yet in the PC transcript. */
  const [pending, setPending] = useState<string[]>([]);
  /** Live run state of this chat on the PC (from the Agents sidebar). */
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
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
      setMessages(packed.messages);
      if (agents && composerId) {
        const chat = agents.projects.flatMap((p) => p.chats).find((c) => c.composerId === composerId);
        setRunning(chat?.status === 'working');
      }
      // Drop optimistic bubbles once the PC transcript contains them.
      setPending((prev) =>
        prev.filter(
          (text) => !packed.messages.some((m) => m.role === 'user' && m.content.trim() === text),
        ),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof HubApiError ? `${err.code}: ${err.message}` : 'Could not load chat');
    } finally {
      setLoading(false);
    }
  }, [client, sessionId, composerId, navigation]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

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

  const send = async () => {
    const text = draft.trim();
    if (!text || !client || !composerId || sending) return;
    setSending(true);
    setError(null);
    try {
      // Sending makes an agent act on the PC — gate it behind fingerprint / PIN (Account → Security).
      const { lockSend } = await loadLockSettings();
      if (!(await unlock(lockSend, 'Unlock to send to your PC'))) {
        setError('Not sent — unlock was cancelled');
        return;
      }
      await client.sendToAgentChat(composerId, text);
      setDraft('');
      setPending((prev) => [...prev, text]);
      atBottom.current = true;
      setTimeout(() => void load(), 1_500);
    } catch (err) {
      setError(
        err instanceof HubApiError ? `Not sent — ${err.message}` : 'Not sent — check the connection',
      );
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (!client || !composerId || stopping) return;
    setStopping(true);
    setError(null);
    try {
      await client.stopAgentChat(composerId);
      setRunning(false);
      setTimeout(() => void load(), 1_500);
    } catch (err) {
      setError(err instanceof HubApiError ? `Not stopped — ${err.message}` : 'Not stopped — check the connection');
    } finally {
      setStopping(false);
    }
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    atBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 48;
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.content}
        onScroll={onScroll}
        scrollEventThrottle={100}
        // Follow new messages only when the reader is already at the bottom.
        onContentSizeChange={() => {
          if (atBottom.current) {
            // Android drops a scroll issued during a layout pass; wait one frame.
            requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
          }
        }}
      >
        <Text style={styles.title}>{title || 'Chat'}</Text>

        {loading ? <ActivityIndicator color={colors.accent} /> : null}

        {messages.map((m) =>
          // Tool steps ("Used read_file, grep (3 steps)") are context, not conversation.
          m.role === 'system' ? (
            <Text key={m.id} style={styles.toolLine} numberOfLines={2}>
              {m.content}
            </Text>
          ) : (
            <View
              key={m.id}
              style={[styles.bubble, m.role === 'user' ? styles.user : styles.assistant]}
            >
              <Text style={styles.role}>{m.role === 'user' ? 'You' : 'Agent'}</Text>
              {m.role === 'user' ? (
                <Text style={styles.body} selectable>
                  {m.content}
                </Text>
              ) : (
                <Markdown source={m.content} />
              )}
            </View>
          ),
        )}

        {pending.map((text, i) => (
          <View key={`pending-${i}`} style={[styles.bubble, styles.user, styles.pending]}>
            <Text style={styles.role}>You · sent to PC</Text>
            <Text style={styles.body}>{text}</Text>
          </View>
        ))}

        {!loading && messages.length === 0 && pending.length === 0 ? (
          <Text style={styles.muted}>No messages in this chat yet.</Text>
        ) : null}
      </ScrollView>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {running ? (
        <View style={styles.workingBar} testID="chat-working">
          <ActivityIndicator color={colors.accent} size="small" />
          <Text style={styles.workingText}>Agent working on your PC…</Text>
          <Pressable
            onPress={() => void stop()}
            disabled={stopping}
            style={styles.stopBtn}
            accessibilityRole="button"
            accessibilityLabel="Stop the agent"
            testID="chat-stop"
          >
            <Text style={styles.stopText}>{stopping ? 'Stopping…' : 'Stop'}</Text>
          </Pressable>
        </View>
      ) : null}

      {changes && composerId ? (
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

      {composerId ? (
        <View style={[styles.composer, { paddingBottom: spacing.sm + insets.bottom }]}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Message the agent on your PC"
            placeholderTextColor={colors.muted}
            style={styles.input}
            multiline
            accessibilityLabel="Message"
            testID="chat-input"
          />
          <Pressable
            onPress={() => void send()}
            disabled={!draft.trim() || sending}
            style={[styles.send, (!draft.trim() || sending) && styles.sendDisabled]}
            accessibilityRole="button"
            accessibilityLabel="Send message"
            testID="chat-send"
          >
            {sending ? (
              <ActivityIndicator color={colors.accentText} />
            ) : (
              <Text style={styles.sendText}>Send</Text>
            )}
          </Pressable>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { flex: 1 },
  content: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.lg },
  title: { color: colors.text, fontSize: 20, fontWeight: '700', marginBottom: spacing.xs },
  error: { color: colors.danger, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  bubble: {
    borderRadius: 8,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xs,
  },
  user: { backgroundColor: colors.surface },
  assistant: { backgroundColor: colors.bg },
  pending: { opacity: 0.7 },
  role: { color: colors.muted, fontSize: 11, fontWeight: '700' },
  body: { color: colors.text, fontSize: 14, lineHeight: 20 },
  muted: { color: colors.muted, fontSize: 14 },
  toolLine: { color: colors.muted, fontSize: 12, paddingHorizontal: spacing.sm },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceMuted,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 16,
  },
  send: {
    minHeight: 44,
    minWidth: 72,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  sendDisabled: { backgroundColor: colors.border },
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
  changesText: { color: colors.text, fontSize: 13 },
  workingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.accentSoft,
  },
  workingText: { flex: 1, color: colors.text, fontSize: 13 },
  stopBtn: {
    minHeight: 32,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.danger,
    justifyContent: 'center',
  },
  stopText: { color: colors.danger, fontWeight: '700', fontSize: 13 },
  changesLink: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  plus: { color: colors.accent },
  minus: { color: colors.danger },
  sendText: { color: colors.accentText, fontWeight: '700', fontSize: 16 },
});
