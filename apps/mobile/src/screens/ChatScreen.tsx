import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowUp, RotateCw, Wrench, X } from 'lucide-react-native';
import { Markdown } from '../components/Markdown';
import { useBridge } from '../bridge/BridgeProvider';
import { buildTranscript, resumeCommand, sessionTitle, sourceLabel, toolsLabel, type ChatItem } from '../bridge/format';
import { findSessionByChat, outboxFor, type OutboxItem } from '../bridge/mirror';
import type { ScreenProps } from '../navigation/types';
import { formatMessageTime } from '../chat/format';
import { colors, radii, spacing, type, weight } from '../theme';

type Row = ChatItem | { kind: 'pending'; key: string; item: OutboxItem };

export function ChatScreen({ navigation, route }: ScreenProps<'Chat'>) {
  const bridge = useBridge();
  const { mirror } = bridge;
  const [sessionId, setSessionId] = useState<string | undefined>(
    route.params.sessionId ?? (route.params.chatId ? findSessionByChat(mirror, route.params.chatId)?.id : undefined),
  );
  const [draft, setDraft] = useState('');
  const [resolving, setResolving] = useState(false);

  const session = sessionId ? mirror.sessions.find((s) => s.id === sessionId) : undefined;
  const chatId = session?.chatId ?? route.params.chatId ?? null;
  const canSend = session ? session.canSend : Boolean(route.params.chatId);
  const messages = sessionId ? mirror.messages[sessionId] : undefined;
  const pending = outboxFor(mirror, chatId);

  // A phone chat turns into a session once the Gateway picks up the first message.
  useEffect(() => {
    if (sessionId || !chatId) return;
    const known = findSessionByChat(mirror, chatId);
    if (known) setSessionId(known.id);
  }, [mirror, chatId, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    void bridge.openSession(sessionId);
    return () => bridge.closeSession(sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <View style={{ maxWidth: 260 }}>
          <Text style={styles.hTitle} numberOfLines={1}>
            {session ? sessionTitle(session) : (route.params.title ?? 'New chat')}
          </Text>
          <Text style={styles.hSub}>{session ? sourceLabel(session.source) : 'Phone'}</Text>
        </View>
      ),
    });
  }, [navigation, session, route.params.title]);

  const rows: Row[] = useMemo(() => {
    const base: Row[] = buildTranscript(messages ?? []);
    for (const item of pending) base.push({ kind: 'pending', key: `p${item.clientMessageId}`, item });
    return base.reverse(); // inverted list: newest first
  }, [messages, pending]);

  const working = session?.status === 'working' || (!session && pending.some((p) => p.state === 'sent'));

  const onSend = async () => {
    const text = draft.trim();
    if (!text || !chatId) return;
    setDraft('');
    await bridge.send(chatId, text);
    if (!sessionId && !resolving) {
      setResolving(true);
      const s = await bridge.resolveChat(chatId);
      setResolving(false);
      if (s) setSessionId(s.id);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={['bottom']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        {bridge.connection !== 'online' ? (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>
              {bridge.connection === 'revoked'
                ? 'The PC no longer accepts this phone — pair again in Settings.'
                : 'Not connected to the PC — showing what was synced. New replies appear when it reconnects.'}
            </Text>
          </View>
        ) : null}

        {sessionId && !messages ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : (
          <FlatList
            inverted
            data={rows}
            keyExtractor={(r) => r.key}
            renderItem={({ item }) => <RowView row={item} onRetry={bridge.retry} onDiscard={bridge.discard} />}
            contentContainerStyle={styles.list}
            ListHeaderComponent={working ? <WorkingRow /> : null}
            ListEmptyComponent={
              !sessionId ? (
                <View style={[styles.center, { transform: [{ scaleY: -1 }] }]}>
                  <Text style={styles.emptyTitle}>Ask Hermes anything</Text>
                  <Text style={styles.emptyText}>
                    This chat is stored on the PC. Commands like /new, /stop, /model work here too.
                  </Text>
                </View>
              ) : null
            }
          />
        )}

        {canSend ? (
          <View style={styles.composer}>
            <TextInput
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              placeholder="Message Hermes"
              placeholderTextColor={colors.muted}
              multiline
              testID="chat-input"
            />
            <Pressable
              style={[styles.send, !draft.trim() && { opacity: 0.4 }]}
              disabled={!draft.trim()}
              onPress={() => void onSend()}
              testID="chat-send"
              accessibilityLabel="Send"
            >
              <ArrowUp size={20} color={colors.onDark} />
            </Pressable>
          </View>
        ) : session ? (
          <View style={styles.readonly}>
            <Text style={styles.readonlyText}>
              Started in {sourceLabel(session.source)} — read-only here. Continue on the PC with
            </Text>
            <Text selectable style={styles.cmd}>
              {resumeCommand(session.id)}
            </Text>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function WorkingRow() {
  return (
    <View style={styles.workingRow}>
      <ActivityIndicator size="small" color={colors.accent} />
      <Text style={styles.workingText}>Hermes is working…</Text>
    </View>
  );
}

function RowView({
  row,
  onRetry,
  onDiscard,
}: {
  row: Row;
  onRetry: (id: string) => Promise<void>;
  onDiscard: (id: string) => void;
}) {
  if (row.kind === 'tools') {
    return (
      <View style={styles.tools}>
        <Wrench size={13} color={colors.muted} />
        <Text style={styles.toolsText} numberOfLines={1}>
          {toolsLabel(row.names, row.count)}
        </Text>
      </View>
    );
  }
  if (row.kind === 'pending') {
    const { item } = row;
    return (
      <View style={styles.userWrap}>
        <View style={[styles.userBubble, item.state === 'failed' && styles.failedBubble]}>
          <Text style={styles.userText}>{item.text}</Text>
        </View>
        {item.state === 'failed' ? (
          <View style={styles.failRow}>
            <Text style={styles.failText} numberOfLines={2}>
              {item.error ?? 'Not sent'}
            </Text>
            <Pressable onPress={() => void onRetry(item.clientMessageId)} hitSlop={8} accessibilityLabel="Retry">
              <RotateCw size={16} color={colors.accent} />
            </Pressable>
            <Pressable onPress={() => onDiscard(item.clientMessageId)} hitSlop={8} accessibilityLabel="Discard">
              <X size={16} color={colors.muted} />
            </Pressable>
          </View>
        ) : (
          <Text style={styles.meta}>{item.state === 'sending' ? 'Sending…' : 'Delivered to PC'}</Text>
        )}
      </View>
    );
  }
  const m = row.message;
  if (m.role === 'user') {
    return (
      <View style={styles.userWrap}>
        <View style={styles.userBubble}>
          <Text selectable style={styles.userText}>
            {m.content}
          </Text>
        </View>
        <Text style={styles.meta}>{formatMessageTime(m.createdAt)}</Text>
      </View>
    );
  }
  return (
    <View style={styles.assistant}>
      <Markdown source={m.content} />
      <Text style={styles.meta}>{formatMessageTime(m.createdAt)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  hTitle: { fontSize: type.body, fontWeight: weight.semibold, color: colors.text },
  hSub: { fontSize: type.meta, color: colors.muted },
  banner: { backgroundColor: colors.warnSoft, padding: spacing.sm, paddingHorizontal: spacing.md },
  bannerText: { color: colors.warnText, fontSize: type.meta, lineHeight: 18 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.xs },
  list: { padding: spacing.md, gap: spacing.sm, flexGrow: 1 },
  emptyTitle: { fontSize: type.sub, fontWeight: weight.semibold, color: colors.text },
  emptyText: { fontSize: type.body, color: colors.muted, textAlign: 'center', lineHeight: 22 },
  userWrap: { alignItems: 'flex-end', gap: 2 },
  userBubble: {
    maxWidth: '85%',
    backgroundColor: colors.bubbleUser,
    borderRadius: radii.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  failedBubble: { borderWidth: 1, borderColor: colors.danger },
  userText: { fontSize: type.body, color: colors.text, lineHeight: 22 },
  assistant: { gap: 2, paddingRight: spacing.lg },
  meta: { fontSize: 11, color: colors.muted },
  failRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, maxWidth: '85%' },
  failText: { flexShrink: 1, fontSize: 12, color: colors.dangerText },
  tools: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: colors.surfaceMuted,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    maxWidth: '90%',
  },
  toolsText: { fontSize: 12, color: colors.muted },
  workingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.xs },
  workingText: { fontSize: type.meta, color: colors.accent, fontWeight: weight.semibold },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.xs,
    padding: spacing.sm,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  input: {
    flex: 1,
    maxHeight: 140,
    minHeight: 44,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radii.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 10,
    fontSize: type.body,
    color: colors.text,
  },
  send: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  readonly: {
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: 4,
  },
  readonlyText: { fontSize: type.meta, color: colors.muted },
  cmd: {
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: type.meta,
    color: colors.text,
    backgroundColor: colors.surfaceMuted,
    padding: spacing.xs,
    borderRadius: radii.sm,
  },
});
