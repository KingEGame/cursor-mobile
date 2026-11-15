import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
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
import { ArrowUp, Camera, FileText, ImageIcon, Paperclip, RotateCw, Wrench, X } from 'lucide-react-native';
import { humanSize, MAX_ATTACHMENT_BYTES, pickFiles, pickPhotos, takePhoto, totalBytes } from '../bridge/attachments';
import type { Attachment } from '../bridge/types';
import { Markdown } from '../components/Markdown';
import { useBridge } from '../bridge/BridgeProvider';
import { buildTranscript, resumeCommand, sessionTitle, sourceLabel, toolsLabel, type ChatItem } from '../bridge/format';
import { findSessionByChat, liveFor, outboxFor, type LiveItem, type OutboxItem } from '../bridge/mirror';
import type { ScreenProps } from '../navigation/types';
import { formatMessageTime } from '../chat/format';
import { colors, radii, spacing, type, weight } from '../theme';

type Row =
  | ChatItem
  | { kind: 'pending'; key: string; item: OutboxItem }
  | { kind: 'live'; key: string; live: LiveItem };

export function ChatScreen({ navigation, route }: ScreenProps<'Chat'>) {
  const bridge = useBridge();
  const { mirror } = bridge;
  const [sessionId, setSessionId] = useState<string | undefined>(
    route.params.sessionId ?? (route.params.chatId ? findSessionByChat(mirror, route.params.chatId)?.id : undefined),
  );
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);

  const addFrom = async (pick: () => Promise<Attachment[]>) => {
    setAttachOpen(false);
    setAttachError(null);
    try {
      const got = await pick();
      const next = [...files, ...got].slice(0, 10);
      if (totalBytes(next) > MAX_ATTACHMENT_BYTES) {
        setAttachError('Files are over 25 MB together — send fewer at a time.');
        return;
      }
      setFiles(next);
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : String(err));
    }
  };
  const [resolving, setResolving] = useState(false);

  const session = sessionId ? mirror.sessions.find((s) => s.id === sessionId) : undefined;
  const chatId = session?.chatId ?? route.params.chatId ?? null;
  const canSend = session ? session.canSend : Boolean(route.params.chatId);
  const messages = sessionId ? mirror.messages[sessionId] : undefined;
  const pending = outboxFor(mirror, sessionId ? null : chatId, sessionId);
  const live = liveFor(mirror, chatId, sessionId);

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
          <Text style={styles.hSub} numberOfLines={1}>
            {[session ? sourceLabel(session.source) : 'Phone', session?.project?.name ?? route.params.project]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>
      ),
    });
  }, [navigation, session, route.params.title, route.params.project]);

  const rows: Row[] = useMemo(() => {
    const base: Row[] = buildTranscript(messages ?? []);
    for (const item of pending) base.push({ kind: 'pending', key: `p${item.clientMessageId}`, item });
    for (const l of live) if (l.text.trim()) base.push({ kind: 'live', key: `l${l.liveId}`, live: l });
    return base.reverse(); // inverted list: newest first
  }, [messages, pending, live]);

  const streaming = live.some((l) => l.duringTurn && !l.final && l.text.trim());
  const working =
    !streaming && (session?.status === 'working' || (!session && pending.some((p) => p.state === 'sent')));

  const onSend = async () => {
    const text = draft.trim();
    if ((!text && !files.length) || (!sessionId && !chatId)) return;
    const toSend = files;
    setDraft('');
    setFiles([]);
    await bridge.send(sessionId ? { sessionId } : { chatId }, text, toSend);
    if (!sessionId && chatId && !resolving) {
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

        {canSend && session && session.source !== 'phone' ? (
          <Text style={styles.origin} numberOfLines={1}>
            Continuing a {sourceLabel(session.source)} session · also on PC: {resumeCommand(session.id)}
          </Text>
        ) : null}
        {canSend && (files.length || attachError) ? (
          <View style={styles.attachBar}>
            {files.map((f, i) => (
              <View key={`${f.uri}${i}`} style={styles.attachChip}>
                {f.mime.startsWith('image/') ? (
                  <Image source={{ uri: f.uri }} style={styles.thumb} />
                ) : (
                  <FileText size={16} color={colors.muted} />
                )}
                <Text style={styles.attachName} numberOfLines={1}>
                  {f.name}
                  {f.size ? ` · ${humanSize(f.size)}` : ''}
                </Text>
                <Pressable onPress={() => setFiles(files.filter((_, j) => j !== i))} hitSlop={8} accessibilityLabel="Remove">
                  <X size={14} color={colors.muted} />
                </Pressable>
              </View>
            ))}
            {attachError ? <Text style={styles.failText}>{attachError}</Text> : null}
          </View>
        ) : null}
        {canSend && attachOpen ? (
          <View style={styles.attachMenu}>
            <Pressable style={styles.attachOpt} onPress={() => void addFrom(pickPhotos)} testID="attach-photos">
              <ImageIcon size={20} color={colors.text} />
              <Text style={styles.attachOptText}>Photos</Text>
            </Pressable>
            <Pressable style={styles.attachOpt} onPress={() => void addFrom(takePhoto)} testID="attach-camera">
              <Camera size={20} color={colors.text} />
              <Text style={styles.attachOptText}>Camera</Text>
            </Pressable>
            <Pressable style={styles.attachOpt} onPress={() => void addFrom(pickFiles)} testID="attach-files">
              <FileText size={20} color={colors.text} />
              <Text style={styles.attachOptText}>File</Text>
            </Pressable>
          </View>
        ) : null}
        {canSend ? (
          <View style={styles.composer}>
            <Pressable
              style={styles.clip}
              onPress={() => setAttachOpen((v) => !v)}
              testID="chat-attach"
              accessibilityLabel="Attach"
              hitSlop={6}
            >
              <Paperclip size={20} color={attachOpen ? colors.accent : colors.muted} />
            </Pressable>
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
              style={[styles.send, !draft.trim() && !files.length && { opacity: 0.4 }]}
              disabled={!draft.trim() && !files.length}
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
              Internal {sourceLabel(session.source)} session — read-only. Inspect on the PC with
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
  if (row.kind === 'live') {
    const l = row.live;
    if (!l.duringTurn) {
      return (
        <View style={styles.notice}>
          <Markdown source={l.text} />
        </View>
      );
    }
    return (
      <View style={styles.assistant}>
        <Markdown source={l.text} />
        <Text style={styles.meta}>{l.final ? 'Saving…' : 'Typing…'}</Text>
      </View>
    );
  }
  if (row.kind === 'pending') {
    const { item } = row;
    return (
      <View style={styles.userWrap}>
        <View style={[styles.userBubble, item.state === 'failed' && styles.failedBubble]}>
          {item.text ? <Text style={styles.userText}>{item.text}</Text> : null}
          {item.attachments?.length ? (
            <Text style={styles.attachLine}>
              📎 {item.attachments.map((a) => a.name).join(', ')}
            </Text>
          ) : null}
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
  notice: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radii.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    marginRight: spacing.lg,
  },
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
  attachBar: { paddingHorizontal: spacing.sm, paddingTop: spacing.xs, gap: 6 },
  attachChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.xs,
    paddingVertical: 4,
  },
  thumb: { width: 32, height: 32, borderRadius: 6 },
  attachName: { flex: 1, fontSize: type.meta, color: colors.text },
  attachMenu: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xs,
  },
  attachOpt: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
    paddingVertical: spacing.xs,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  attachOptText: { fontSize: type.meta, color: colors.text },
  attachLine: { fontSize: type.meta, color: colors.muted, marginTop: 2 },
  clip: { justifyContent: 'center', paddingHorizontal: 4 },
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
  origin: {
    fontSize: 11,
    color: colors.muted,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
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
