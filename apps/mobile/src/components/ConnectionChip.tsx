import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  connectionChipFromState,
  type ConnectionChipTone,
} from '../hub/chats-home';
import type { CompanionConnectionState } from '../hub/connection-state';
import { colors, radii, spacing, type, weight } from '../theme';

interface Props {
  state: CompanionConnectionState;
  onPress?: () => void;
  testID?: string;
}

const TONE_COLOR: Record<ConnectionChipTone, string> = {
  online: colors.healthy,
  degraded: colors.degraded,
  offline: colors.down,
  pair: colors.muted,
};

/** Tiny quiet Online / Degraded / Offline / Pair chip — not a status banner. */
export function ConnectionChip({ state, onPress, testID }: Props) {
  const view = connectionChipFromState(state);
  const color = TONE_COLOR[view.tone];
  const body = (
    <View
      style={styles.chip}
      accessibilityRole="text"
      accessibilityLabel={`Connection ${view.label}`}
      testID={testID ?? 'connection-chip'}
    >
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={styles.label}>{view.label}</Text>
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" hitSlop={8}>
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceMuted,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  label: {
    color: colors.muted,
    fontSize: type.chip,
    fontWeight: weight.semibold,
  },
});
