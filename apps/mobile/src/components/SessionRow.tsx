import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatRelativeTime } from '../hub/format';
import { sessionModeBadgeLabel } from '../hub/session-list-ux';
import type { SessionListItem } from '../hub/types';
import { colors, spacing, type, weight, lineHeight } from '../theme';

interface Props {
  item: SessionListItem;
  onPress: (item: SessionListItem) => void;
  disabled?: boolean;
}

export function SessionRow({ item, onPress, disabled }: Props) {
  const badge = sessionModeBadgeLabel(item.mode);
  return (
    <Pressable
      style={[styles.row, disabled && styles.disabled]}
      onPress={() => onPress(item)}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`Session ${item.title}`}
      testID={`session-row-${badge}-${item.id}`}
      collapsable={false}
    >
      <View style={styles.top} importantForAccessibility="no">
        <Text style={styles.title} numberOfLines={1}>
          {item.title || 'Untitled session'}
        </Text>
        <View
          style={[styles.badge, badge === 'live' ? styles.live : styles.hist]}
          testID={`session-mode-badge-${badge}`}
        >
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      </View>
      {item.preview ? (
        <Text style={styles.preview} numberOfLines={2} importantForAccessibility="no">
          {item.preview}
        </Text>
      ) : null}
      <View style={styles.meta} importantForAccessibility="no">
        <Text style={styles.metaText}>{formatRelativeTime(item.updatedAt)}</Text>
        {item.model ? (
          <Text style={styles.metaText} numberOfLines={1}>
            {item.model}
          </Text>
        ) : null}
        {item.pendingApprovals > 0 ? (
          <Text style={styles.pending}>{item.pendingApprovals} pending</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing.md,
    gap: spacing.xs,
  },
  disabled: { opacity: 0.5 },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  title: { flex: 1, color: colors.text, fontSize: type.body, fontWeight: weight.semibold },
  badge: {
    borderRadius: 4,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xxs,
  },
  live: { backgroundColor: colors.accent },
  hist: { backgroundColor: colors.border },
  badgeText: { color: colors.accentText, fontSize: type.meta, fontWeight: weight.semibold },
  preview: { color: colors.muted, fontSize: type.meta, lineHeight: lineHeight.meta },
  meta: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  metaText: { color: colors.muted, fontSize: type.meta },
  pending: { color: colors.warn, fontSize: type.meta, fontWeight: weight.semibold },
});
