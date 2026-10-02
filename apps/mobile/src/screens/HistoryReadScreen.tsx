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
      const packed = await client.getSessionMessages(sessionId);
      setMessages(packed.messages);
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
  }, [client, sessionId, navigation]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !client || !composerId || sending) return;
    setSending(true);
    setError(null);
    try {
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
  sendText: { color: colors.accentText, fontWeight: '700', fontSize: 16 },
});
