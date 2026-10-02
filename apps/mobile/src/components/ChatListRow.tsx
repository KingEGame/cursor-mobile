import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { chatModeHint } from '../hub/chats-home';
import { formatRelativeTime } from '../hub/format';
import type { SessionListItem } from '../hub/types';
import { colors, spacing, type } from '../theme';

interface Props {
  item: SessionListItem;
  onPress: (item: SessionListItem) => void;
  disabled?: boolean;
}

/** Large-tap Gemini-style chat row: title + quiet meta, no badge clusters. */
export function ChatListRow({ item, onPress, disabled }: Props) {
  const mode = chatModeHint(item.mode);
  const pending = item.pendingApprovals > 0 ? item.pendingApprovals : 0;
  return (
    <Pressable
      style={[styles.row, disabled && styles.disabled]}
      onPress={() => onPress(item)}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`Chat ${item.title || 'Untitled'}`}
      testID={`chat-row-${item.mode}-${item.id}`}
      collapsable={false}
    >
      <View style={styles.main} importantForAccessibility="no">
        <Text style={styles.title} numberOfLines={1}>
          {item.title || 'Untitled chat'}
        </Text>
        {item.preview ? (
          <Text style={styles.preview} numberOfLines={1}>
            {item.preview}
          </Text>
        ) : null}
        <Text style={styles.meta} numberOfLines={1}>
          {[mode, formatRelativeTime(item.updatedAt), pending > 0 ? `${pending} approval` : null]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    minHeight: 64,
    justifyContent: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  disabled: { opacity: 0.45 },
  main: { gap: 2 },
  title: {
    color: colors.text,
    fontSize: type.body,
    fontWeight: '600',
  },
  preview: {
    color: colors.muted,
    fontSize: type.meta,
    lineHeight: 18,
  },
  meta: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 2,
  },
});
