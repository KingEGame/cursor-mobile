import React, { memo, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Markdown } from '../components/Markdown';
import type { ChatMessage } from '../hub/types';
import { colors, radii, spacing, type, weight, lineHeight } from '../theme';
import { formatElapsed, formatMessageTime } from './format';
import { deliveryLabel, type OutgoingMessage } from './outgoing';

/** Rows of the chat list. All are memoized: a poll that changes nothing re-renders nothing. */
export type ChatRow =
  | { kind: 'day'; id: string; label: string }
  | { kind: 'tool'; id: string; text: string }
  | { kind: 'user'; id: string; msg: ChatMessage }
  | { kind: 'assistant'; id: string; msg: ChatMessage; lead: boolean };

export const DayRow = memo(function DayRow({ label }: { label: string }) {
  return (
    <Text style={styles.dayDivider} accessibilityRole="header">
      {label}
    </Text>
  );
});

export const ToolRow = memo(function ToolRow({ text }: { text: string }) {
  return (
    <Text style={styles.toolLine} numberOfLines={2}>
      {text}
    </Text>
  );
});

export const UserRow = memo(function UserRow(props: {
  msg: ChatMessage;
  editing: boolean;
  onShare: (text: string) => void;
  onEdit: (id: string, text: string) => void;
}) {
  const { msg, editing, onShare, onEdit } = props;
  const time = formatMessageTime(msg.createdAt);
  return (
    <View
      style={[styles.bubble, styles.user, editing && styles.editingBubble]}
      accessible
      accessibilityLabel={`You said: ${msg.content}${time ? `, ${time}` : ''}`}
    >
      <Text style={styles.body} selectable>
        {msg.content}
      </Text>
      <View style={styles.metaRow}>
        {time ? <Text style={styles.time}>{time}</Text> : <View />}
        <View style={styles.actionsRow}>
          <Pressable
            onPress={() => onShare(msg.content)}
            style={styles.action}
            hitSlop={{ top: 8, bottom: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Copy or share this message"
          >
            <Text style={styles.actionText}>Copy</Text>
          </Pressable>
          <Pressable
            onPress={() => onEdit(msg.id, msg.content)}
            style={styles.action}
            hitSlop={{ top: 8, bottom: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Edit this message and resend"
          >
            <Text style={styles.actionText}>Edit</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
});

export const AssistantRow = memo(function AssistantRow(props: { msg: ChatMessage; lead: boolean; onShare: (text: string) => void }) {
  const { msg, lead, onShare } = props;
  const time = formatMessageTime(msg.createdAt);
  return (
    <Pressable
      style={styles.assistant}
      onLongPress={() => onShare(msg.content)}
      delayLongPress={400}
      accessibilityHint="Long-press to copy or share this reply"
    >
      {lead ? (
        <Text style={styles.identity} accessibilityRole="header">
          Cursor agent{time ? <Text style={styles.time}>{`  ·  ${time}`}</Text> : null}
        </Text>
      ) : null}
      <Markdown source={msg.content} />
      {!lead && time ? <Text style={styles.time}>{time}</Text> : null}
    </Pressable>
  );
});

export const OutgoingRow = memo(function OutgoingRow<O>(props: {
  m: OutgoingMessage<O>;
  onRetry: (m: OutgoingMessage<O>) => void;
  onDiscard: (id: string) => void;
}) {
  const { m, onRetry, onDiscard } = props;
  const failed = m.state === 'failed';
  return (
    <View
      style={[styles.bubble, styles.user, !failed && styles.pending, failed && styles.failedBubble]}
      accessible
      accessibilityLabel={`You said: ${m.text}. ${deliveryLabel(m)}`}
    >
      <Text style={styles.body}>{m.text}</Text>
      <Text style={[styles.delivery, failed && styles.deliveryFailed]} accessibilityLiveRegion={failed ? 'assertive' : 'polite'}>
        {deliveryLabel(m)}
      </Text>
      {failed ? (
        <View style={styles.actionsRow}>
          <Pressable
            onPress={() => onRetry(m)}
            style={[styles.action, styles.retry]}
            hitSlop={{ top: 8, bottom: 8 }}
            accessibilityRole="button"
            accessibilityLabel={m.definitelyNotSent === false ? 'Send again. It may arrive twice.' : 'Retry sending'}
          >
            <Text style={styles.retryText}>{m.definitelyNotSent === false ? 'Send again' : 'Retry'}</Text>
          </Pressable>
          <Pressable
            onPress={() => onDiscard(m.id)}
            style={styles.action}
            hitSlop={{ top: 8, bottom: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Discard this message"
          >
            <Text style={styles.actionText}>Discard</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}) as <O>(props: { m: OutgoingMessage<O>; onRetry: (m: OutgoingMessage<O>) => void; onDiscard: (id: string) => void }) => React.ReactElement;

/** Owns its own 1 s clock, so the elapsed time never re-renders the transcript. */
export function WorkingBar(props: { stopping: boolean; step: string | null }) {
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(started);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  const elapsed = formatElapsed(now - started);
  return (
    <View style={styles.workingBar} testID="chat-working" accessibilityLiveRegion="polite">
      <ActivityIndicator color={colors.accent} size="small" />
      <View style={styles.workingCol}>
        <Text style={styles.workingText}>{props.stopping ? 'Stopping…' : `Agent working on your PC · ${elapsed}`}</Text>
        {props.step && !props.stopping ? (
          <Text style={styles.workingStep} numberOfLines={1}>
            {props.step}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dayDivider: { alignSelf: 'center', color: colors.muted, fontSize: type.meta, fontWeight: weight.semibold, marginVertical: spacing.xs },
  toolLine: { color: colors.muted, fontSize: type.meta, paddingHorizontal: spacing.sm },
  bubble: { borderRadius: radii.md, paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.xxs, gap: spacing.xxs },
  user: { backgroundColor: colors.bubbleUser, marginLeft: spacing.lg },
  editingBubble: { borderWidth: 1, borderColor: colors.warn },
  failedBubble: { borderWidth: 1, borderColor: colors.danger, backgroundColor: colors.dangerSoft },
  pending: { opacity: 0.75 },
  assistant: { paddingHorizontal: spacing.xs, paddingVertical: spacing.xs, gap: spacing.xs },
  identity: { color: colors.identity, fontSize: type.meta, fontWeight: weight.semibold },
  body: { color: colors.text, fontSize: type.body, lineHeight: lineHeight.body },
  time: { color: colors.muted, fontSize: type.meta },
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  actionsRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  // 32dp tall, 48dp hit area via hitSlop: keeps bubbles compact without a tiny tap target.
  action: { minHeight: 32, minWidth: 48, paddingHorizontal: spacing.sm, alignItems: 'center', justifyContent: 'center' },
  actionText: { color: colors.muted, fontSize: type.meta, fontWeight: weight.semibold },
  retry: { backgroundColor: colors.danger, borderRadius: radii.pill, paddingHorizontal: spacing.md, minHeight: 40 },
  retryText: { color: colors.onDark, fontSize: type.meta, fontWeight: weight.semibold },
  delivery: { color: colors.muted, fontSize: type.meta, lineHeight: lineHeight.meta },
  deliveryFailed: { color: colors.danger, fontWeight: weight.semibold },
  workingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 40,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xxs,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  workingCol: { flex: 1 },
  workingText: { color: colors.text, fontSize: type.meta, fontWeight: weight.semibold },
  workingStep: { color: colors.muted, fontSize: type.meta },
});
