import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '../theme';

export type HealthDotLevel = 'healthy' | 'degraded' | 'down' | 'unknown';

interface Props {
  level: HealthDotLevel;
  onPress?: () => void;
  label?: string;
}

const DOT_COLOR: Record<HealthDotLevel, string> = {
  healthy: colors.healthy,
  degraded: colors.degraded,
  down: colors.down,
  unknown: colors.muted,
};

export function HealthDot({ level, onPress, label }: Props) {
  const content = (
    <View style={styles.row} accessibilityRole="button" accessibilityLabel={label ?? `Health ${level}`}>
      <View style={[styles.dot, { backgroundColor: DOT_COLOR[level] }]} />
      {label ? <Text style={styles.label}>{label}</Text> : null}
    </View>
  );

  if (onPress) {
    return (
      <Pressable onPress={onPress} hitSlop={8}>
        {content}
      </Pressable>
    );
  }
  return content;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  label: {
    color: colors.muted,
    fontSize: 12,
  },
});
