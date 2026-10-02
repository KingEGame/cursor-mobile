import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatRelativeTime } from '../hub/format';
import { sessionModeBadgeLabel } from '../hub/session-list-ux';
import type { SessionListItem } from '../hub/types';
import { colors, spacing } from '../theme';

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
  title: { flex: 1, color: colors.text, fontSize: 16, fontWeight: '600' },
  badge: {
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  live: { backgroundColor: colors.accent },
  hist: { backgroundColor: colors.border },
  badgeText: { color: colors.accentText, fontSize: 11, fontWeight: '700' },
  preview: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  metaText: { color: colors.muted, fontSize: 12 },
  pending: { color: colors.warn, fontSize: 12, fontWeight: '600' },
});
