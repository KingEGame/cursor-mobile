import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { FolderOpen } from 'lucide-react-native';
import { useBridge } from '../bridge/BridgeProvider';
import { describeError } from '../bridge/errors';
import { relativeTime } from '../bridge/format';
import type { Project } from '../bridge/types';
import type { ScreenProps } from '../navigation/types';
import { colors, radii, spacing, type, weight } from '../theme';

/** Hermes projects (same list as the desktop sidebar / `hermes project ls`). */
export function ProjectsScreen({ navigation }: ScreenProps<'Projects'>) {
  const bridge = useBridge();
  const [items, setItems] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems((await bridge.client.projects()).items);
      setError(null);
    } catch (err) {
      setError(describeError(err, bridge.pairing.pcName));
    }
  }, [bridge.client, bridge.pairing.pcName]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  // Keep "working" counts fresh while the screen is open.
  useEffect(() => {
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <SafeAreaView style={styles.root} edges={['bottom']}>
      {error ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{error}</Text>
        </View>
      ) : null}
      <FlatList
        data={items ?? []}
        keyExtractor={(p) => p.slug}
        renderItem={({ item }) => (
          <Pressable
            testID={`project-${item.slug}`}
            onPress={() => navigation.navigate('Project', { slug: item.slug, name: item.name })}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceMuted }]}
          >
            <View style={[styles.icon, item.color ? { backgroundColor: item.color } : null]}>
              {item.icon ? <Text style={styles.iconText}>{item.icon}</Text> : <FolderOpen size={18} color={colors.text} />}
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <View style={styles.rowTop}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.meta}>{item.updatedAt ? relativeTime(item.updatedAt) : ''}</Text>
              </View>
              <Text style={styles.path} numberOfLines={1}>
                {item.path ?? '—'}
              </Text>
              <Text style={styles.meta}>
                {item.sessionCount === 1 ? '1 session' : `${item.sessionCount} sessions`}
                {item.workingCount ? ` · ${item.workingCount} working` : ''}
              </Text>
            </View>
          </Pressable>
        )}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            {items === null && !error ? (
              <ActivityIndicator color={colors.accent} />
            ) : (
              <Text style={styles.emptyText}>
                No projects on the PC yet. Create one in the desktop app or with `hermes project create`.
              </Text>
            )}
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  banner: { backgroundColor: colors.warnSoft, padding: spacing.sm, paddingHorizontal: spacing.md },
  bannerText: { color: colors.warnText, fontSize: type.meta, lineHeight: 18 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
  },
  icon: {
    width: 36,
    height: 36,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceMuted,
  },
  iconText: { fontSize: 18 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { flex: 1, fontSize: type.body, fontWeight: weight.semibold, color: colors.text },
  path: { fontSize: type.meta, color: colors.muted },
  meta: { fontSize: type.meta, color: colors.muted },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  empty: { padding: spacing.xl, alignItems: 'center' },
  emptyText: { color: colors.muted, fontSize: type.body, textAlign: 'center', lineHeight: 22 },
});
