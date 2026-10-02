import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { WorkspaceResponse } from '../hub/types';
import { isWorkspaceBound } from '../hub/types';
import {
  BANNER_NAME_NUMBER_OF_LINES,
  BANNER_PATH_NUMBER_OF_LINES,
  bannerPathDisplay,
} from '../hub/project-banner';
import { colors, spacing } from '../theme';
import { HealthDot, type HealthDotLevel } from './HealthDot';

interface Props {
  workspace: WorkspaceResponse | null;
  healthLevel: HealthDotLevel;
  hubName?: string | null;
  onHealthPress?: () => void;
}

export function ProjectBanner({ workspace, healthLevel, hubName, onHealthPress }: Props) {
  if (!workspace || !isWorkspaceBound(workspace)) {
    return (
      <View style={[styles.banner, styles.empty]} accessibilityRole="summary">
        <Text style={styles.emptyTitle}>No project open on PC</Text>
        <Text style={styles.emptyBody}>
          Open a folder in Cursor on the PC. This app remotes that workspace only — it does not
          browse cloud projects or arbitrary paths.
        </Text>
        <HealthDot level={healthLevel} onPress={onHealthPress} label="Health" />
      </View>
    );
  }

  return (
    <View style={styles.banner} accessibilityRole="summary">
      <View style={styles.topRow}>
        <Text style={styles.name} numberOfLines={BANNER_NAME_NUMBER_OF_LINES}>
          {workspace.name}
        </Text>
        <HealthDot level={healthLevel} onPress={onHealthPress} label="Health" />
      </View>
      <Text style={styles.path} numberOfLines={BANNER_PATH_NUMBER_OF_LINES}>
        {bannerPathDisplay(workspace.path)}
      </Text>
      {hubName ? (
        <Text style={styles.hub} numberOfLines={1}>
          Hub: {hubName}
        </Text>
      ) : null}
      {workspace.roots.length > 1 ? (
        <Text style={styles.meta}>{workspace.roots.length} workspace roots</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing.md,
    gap: spacing.xs,
  },
  empty: {
    borderStyle: 'dashed',
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  name: {
    flex: 1,
    color: colors.text,
    fontSize: 18,
    fontWeight: '600',
  },
  path: {
    color: colors.muted,
    fontSize: 13,
    fontFamily: 'monospace',
  },
  hub: {
    color: colors.muted,
    fontSize: 12,
  },
  meta: {
    color: colors.muted,
    fontSize: 12,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  emptyBody: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: spacing.sm,
  },
});
