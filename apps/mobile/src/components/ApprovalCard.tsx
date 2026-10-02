import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  approvalCardShowsActions,
  normalizeApprovalForCard,
} from '../hub/approval-fallback';
import type { PendingApproval } from '../hub/types';
import { colors, spacing } from '../theme';

interface Props {
  approval: PendingApproval;
  busy?: boolean;
  onApprove: (approvalId: string) => void;
  onDeny: (approvalId: string) => void;
}

export function ApprovalCard({ approval, busy, onApprove, onDeny }: Props) {
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
      {pending ? (
        <View style={styles.actions}>
          <Pressable
            style={[styles.btn, styles.deny]}
            disabled={busy}
            onPress={() => onDeny(normalized.approvalId)}
            accessibilityRole="button"
            accessibilityLabel="Deny tool"
            testID="approval-deny"
            collapsable={false}
          >
            {busy ? (
              <ActivityIndicator color={colors.text} />
            ) : (
              <Text style={styles.denyText}>Deny</Text>
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
              <Text style={styles.approveText}>Approve</Text>
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
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  tool: { color: colors.text, fontSize: 16, fontWeight: '700' },
  server: { color: colors.muted, fontSize: 12 },
  summary: { color: colors.text, fontSize: 14, lineHeight: 20 },
  args: {
    color: colors.muted,
    fontSize: 12,
    fontFamily: 'monospace',
    backgroundColor: colors.bg,
    padding: spacing.sm,
    borderRadius: 4,
  },
  status: { color: colors.muted, fontSize: 12 },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  btn: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  approve: { backgroundColor: colors.accent },
  deny: { backgroundColor: colors.border },
  approveText: { color: colors.accentText, fontWeight: '700' },
  denyText: { color: colors.text, fontWeight: '700' },
  hint: { color: colors.muted, fontSize: 11, marginTop: spacing.xs },
});
