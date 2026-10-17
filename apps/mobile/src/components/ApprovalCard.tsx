import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  approvalCardShowsActions,
  normalizeApprovalForCard,
} from '../hub/approval-fallback';
import type { PendingApproval } from '../hub/types';
import { colors, spacing, type, weight, lineHeight } from '../theme';

interface Props {
  approval: PendingApproval;
  busy?: boolean;
  onApprove: (approvalId: string) => void;
  onDeny: (approvalId: string) => void;
}

/** How long "Tool denied · Undo" stays before the deny is sent to the PC. */
export const DENY_UNDO_MS = 3_000;

export function ApprovalCard({ approval, busy, onApprove, onDeny }: Props) {
  const [denying, setDenying] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useRef<(() => void) | null>(null);

  const startDeny = useCallback(
    (id: string) => {
      setDenying(true);
      const send = () => {
        timer.current = null;
        flush.current = null;
        onDeny(id);
      };
      flush.current = send;
      timer.current = setTimeout(send, DENY_UNDO_MS);
    },
    [onDeny],
  );
  const undoDeny = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    flush.current = null;
    setDenying(false);
  };
  // Leaving the screen inside the undo window must not drop the operator's decision.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      flush.current?.();
    },
    [],
  );
  const normalized = normalizeApprovalForCard(approval) ?? approval;
  const pending = approvalCardShowsActions(normalized);
  const argsText =
    normalized.argsPreview == null
      ? null
      : typeof normalized.argsPreview === 'string'
        ? normalized.argsPreview
        : JSON.stringify(normalized.argsPreview, null, 0);

  return (
    <View
      style={styles.card}
      accessibilityRole="summary"
      accessibilityLabel={`Approval ${normalized.tool.name}`}
      testID={`approval-card-${normalized.approvalId}`}
      collapsable={false}
    >
      <Text style={styles.badge} testID="approval-card-badge">
        {normalized.synthetic ? 'UAT synthetic (no live DOM)' : 'PC tool approval'}
      </Text>
      <Text style={styles.tool}>{normalized.tool.name}</Text>
      {normalized.tool.server ? (
        <Text style={styles.server}>{normalized.tool.server}</Text>
      ) : null}
      <Text style={styles.summary}>{normalized.summary}</Text>
      {argsText ? (
        <Text style={styles.args} numberOfLines={4}>
          {argsText}
        </Text>
      ) : null}
      <Text style={styles.status}>Status: {normalized.status}</Text>
      {pending && denying ? (
        <View style={styles.undoRow} accessibilityLiveRegion="polite">
          <Text style={styles.undoText}>Tool denied</Text>
          <Pressable
            onPress={undoDeny}
            style={styles.undoBtn}
            accessibilityRole="button"
            accessibilityLabel="Undo deny"
            testID="approval-undo"
          >
            <Text style={styles.undoBtnText}>Undo</Text>
          </Pressable>
        </View>
      ) : pending ? (
        <View style={styles.actions}>
          <Pressable
            style={[styles.btn, styles.deny]}
            disabled={busy}
            onPress={() => startDeny(normalized.approvalId)}
            accessibilityRole="button"
            accessibilityLabel="Deny tool"
            testID="approval-deny"
            collapsable={false}
          >
            {busy ? (
              <ActivityIndicator color={colors.text} />
            ) : (
              <Text style={styles.denyText}>Deny tool</Text>
            )}
          </Pressable>
          <Pressable
            style={[styles.btn, styles.approve]}
            disabled={busy}
            onPress={() => onApprove(normalized.approvalId)}
            accessibilityRole="button"
            accessibilityLabel="Approve tool"
            testID="approval-approve"
            collapsable={false}
          >
            {busy ? (
              <ActivityIndicator color={colors.accentText} />
            ) : (
              <Text style={styles.approveText}>Approve tool</Text>
            )}
          </Pressable>
        </View>
      ) : null}
      <Text style={styles.hint}>Runs on the PC inside Cursor — phone only approves.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.warn,
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing.md,
    gap: spacing.xs,
    marginVertical: spacing.sm,
  },
  badge: {
    color: colors.warn,
    fontSize: type.meta,
    fontWeight: weight.semibold,
    textTransform: 'uppercase',
  },
  tool: { color: colors.text, fontSize: type.body, fontWeight: weight.semibold },
  server: { color: colors.muted, fontSize: type.meta },
  summary: { color: colors.text, fontSize: type.meta, lineHeight: lineHeight.body },
  args: {
    color: colors.muted,
    fontSize: type.meta,
    fontFamily: 'monospace',
    backgroundColor: colors.bg,
    padding: spacing.sm,
    borderRadius: 4,
  },
  status: { color: colors.muted, fontSize: type.meta },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  btn: {
    flex: 1,
    minHeight: 48,
    justifyContent: 'center',
    borderRadius: 8,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  approve: { backgroundColor: colors.accent },
  deny: { backgroundColor: colors.border },
  approveText: { color: colors.accentText, fontWeight: weight.semibold },
  denyText: { color: colors.text, fontWeight: weight.semibold },
  undoRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48, marginTop: spacing.sm },
  undoText: { color: colors.text, fontSize: type.body, fontWeight: weight.semibold },
  undoBtn: { minHeight: 48, minWidth: 48, paddingHorizontal: spacing.md, alignItems: 'center', justifyContent: 'center' },
  undoBtnText: { color: colors.accent, fontSize: type.body, fontWeight: weight.semibold },
  hint: { color: colors.muted, fontSize: type.meta, marginTop: spacing.xs },
});
