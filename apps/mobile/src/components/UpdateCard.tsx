import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { UpdateStatus } from '../hub/app-update';
import { colors, radii, spacing, type, weight, lineHeight } from '../theme';

interface Props {
  status: UpdateStatus;
  installedLabel: string;
  onOpen: () => void;
}

/**
 * Account → App. Prominent only when the PC Hub offers a newer build;
 * otherwise a quiet version row.
 */
export function UpdateCard({ status, installedLabel, onOpen }: Props) {
  if (status.kind === 'available') {
    const { release } = status;
    return (
      <View style={styles.hero} testID="account-update-available">
        <Text style={styles.heroTitle}>Update ready · {release.versionName}</Text>
        <Text style={styles.heroMeta}>
          {release.testsPassed != null
            ? `Passed the release gate on your PC · ${release.testsPassed} tests`
            : 'Built and published from your PC'}
        </Text>
        <Pressable
          style={({ pressed }) => [styles.heroBtn, pressed && styles.pressed]}
          onPress={onOpen}
          accessibilityRole="button"
          testID="account-update-open"
        >
          <Text style={styles.heroBtnText}>See what's new</Text>
        </Pressable>
      </View>
    );
  }

  const meta =
    status.kind === 'up-to-date'
      ? 'Up to date'
      : status.kind === 'none-published'
        ? status.message
        : 'Checking the PC for updates…';

  return (
    <View style={styles.card} testID="account-app-version">
      <Text style={styles.cardLabel}>App</Text>
      <Text style={styles.cardValue}>{installedLabel}</Text>
      <Text style={styles.cardMeta}>{meta}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  heroTitle: { color: colors.accentText, fontSize: type.body, fontWeight: weight.semibold },
  heroMeta: { color: colors.accentBorder, fontSize: type.meta, lineHeight: lineHeight.meta },
  heroBtn: {
    marginTop: spacing.sm,
    minHeight: 46,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroBtnText: { color: colors.accent, fontSize: type.body, fontWeight: weight.semibold },
  pressed: { opacity: 0.85 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xxs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  cardLabel: {
    color: colors.muted,
    fontSize: type.meta,
    fontWeight: weight.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  cardValue: { color: colors.text, fontSize: type.body, fontWeight: weight.semibold },
  cardMeta: { color: colors.muted, fontSize: type.meta, lineHeight: lineHeight.meta },
});
