import React, { useLayoutEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FolderOpen, Plus, Settings } from 'lucide-react-native';
import { useBridge, type Connection } from '../bridge/BridgeProvider';
import { oneLine, relativeTime, sessionTitle, sourceLabel } from '../bridge/format';
import type { Session } from '../bridge/types';
import type { ScreenProps } from '../navigation/types';
import { colors, radii, spacing, type, weight } from '../theme';

type Filter = 'all' | 'phone' | 'working';

const CONN: Record<Connection, { label: string; color: string }> = {
  online: { label: 'Live', color: colors.healthy },
  connecting: { label: 'Connecting…', color: colors.degraded },
  offline: { label: 'Offline', color: colors.down },
  revoked: { label: 'Pair again', color: colors.down },
  unpaired: { label: 'Not paired', color: colors.muted },
};

export function SessionsScreen({ navigation }: ScreenProps<'Sessions'>) {
  const bridge = useBridge();
  const [filter, setFilter] = useState<Filter>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const conn = CONN[bridge.connection];

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <View>
          <Text style={styles.hTitle}>{bridge.pairing.pcName ?? 'Hermes'}</Text>
          <View style={styles.hSub}>
            <View style={[styles.dot, { backgroundColor: conn.color }]} />
            <Text style={styles.hSubText}>{conn.label}</Text>
          </View>
        </View>
      ),
      headerRight: () => (
        <Pressable onPress={() => navigation.navigate('Settings')} hitSlop={10} testID="open-settings">
          <Settings size={22} color={colors.text} />
        </Pressable>
      ),
    });
  }, [navigation, bridge.pairing.pcName, conn.label, conn.color]);

  const items = useMemo(() => {
    const all = bridge.mirror.sessions;
    if (filter === 'phone') return all.filter((s) => s.source === 'phone');
    if (filter === 'working') return all.filter((s) => s.status === 'working');
    return all;
  }, [bridge.mirror.sessions, filter]);
  const workingCount = useMemo(
    () => bridge.mirror.sessions.filter((s) => s.status === 'working').length,
    [bridge.mirror.sessions],
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await bridge.refreshSessions();
    setRefreshing(false);
  };

  const startChat = async () => {
    setCreating(true);
    try {
      const chatId = await bridge.newChat();
      navigation.navigate('Chat', { chatId, title: 'New chat' });
    } catch {
      /* lastError banner shows why */
    } finally {
      setCreating(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={['bottom']}>
      {bridge.connection === 'revoked' ? (
        <Pressable style={styles.banner} onPress={() => navigation.navigate('Pair')}>
          <Text style={styles.bannerText}>The PC no longer accepts this phone. Tap to pair again.</Text>
        </Pressable>
      ) : bridge.connection === 'offline' && bridge.lastError ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{bridge.lastError}</Text>
        </View>
      ) : null}

      <View style={styles.filters}>
        <Pressable onPress={() => navigation.navigate('Projects')} style={styles.chip} testID="open-projects">
          <View style={styles.chipRow}>
            <FolderOpen size={14} color={colors.muted} />
            <Text style={styles.chipText}>Projects</Text>
          </View>
        </Pressable>
        {(['all', 'phone', 'working'] as Filter[]).map((f) => (
          <Pressable
            key={f}
            onPress={() => setFilter(f)}
            style={[styles.chip, filter === f && styles.chipOn]}
            testID={`filter-${f}`}
          >
            <Text style={[styles.chipText, filter === f && styles.chipTextOn]}>
              {f === 'all' ? 'All' : f === 'phone' ? 'From phone' : `Working${workingCount ? ` · ${workingCount}` : ''}`}
            </Text>
          </Pressable>
        ))}
      </View>

      <FlatList
        data={items}
        keyExtractor={(s) => s.id}
        renderItem={({ item }) => (
          <SessionRow
            s={item}
            onPress={() => navigation.navigate('Chat', { sessionId: item.id, title: sessionTitle(item) })}
          />
        )}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (filter === 'all' && bridge.hasMoreSessions) void bridge.loadOlderSessions();
        }}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            {bridge.connection === 'connecting' ? (
              <ActivityIndicator color={colors.accent} />
            ) : (
              <Text style={styles.emptyText}>
                {filter === 'working' ? 'Nothing is running right now.' : 'No sessions yet. Start one below.'}
              </Text>
            )}
          </View>
        }
        contentContainerStyle={{ paddingBottom: 96 }}
      />

      <Pressable
        style={[styles.fab, creating && { opacity: 0.6 }]}
        onPress={() => void startChat()}
        disabled={creating || bridge.connection === 'revoked'}
        testID="new-chat"
      >
        <Plus size={20} color={colors.onDark} />
        <Text style={styles.fabText}>New chat</Text>
      </Pressable>
    </SafeAreaView>
  );
}

export function SessionRow({ s, onPress, hideProject }: { s: Session; onPress: () => void; hideProject?: boolean }) {
  const working = s.status === 'working';
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceMuted }]}>
      <View style={styles.rowTop}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {sessionTitle(s)}
        </Text>
        <Text style={styles.rowTime}>{relativeTime(s.updatedAt)}</Text>
      </View>
      <View style={styles.rowBottom}>
        <View style={[styles.badge, s.source === 'phone' && styles.badgePhone]}>
          <Text style={[styles.badgeText, s.source === 'phone' && styles.badgeTextPhone]}>{sourceLabel(s.source)}</Text>
        </View>
        {s.project && !hideProject ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText} numberOfLines={1}>
              {s.project.name}
            </Text>
          </View>
        ) : null}
        {working ? (
          <View style={styles.workingWrap}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={styles.working}>Working</Text>
          </View>
        ) : (
          <Text style={styles.preview} numberOfLines={1}>
            {s.lastRole === 'user' ? 'You: ' : ''}
            {oneLine(s.preview) || `${s.messageCount} messages`}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  hTitle: { fontSize: type.body, fontWeight: weight.semibold, color: colors.text },
  hSub: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  hSubText: { fontSize: type.meta, color: colors.muted },
  dot: { width: 8, height: 8, borderRadius: 4 },
  banner: { backgroundColor: colors.warnSoft, padding: spacing.sm, paddingHorizontal: spacing.md },
  bannerText: { color: colors.warnText, fontSize: type.meta, lineHeight: 18 },
  filters: { flexDirection: 'row', gap: spacing.xs, padding: spacing.md, paddingBottom: spacing.xs },
  chip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  chipOn: { backgroundColor: colors.accentSoft, borderColor: colors.accentBorder },
  chipText: { fontSize: type.chip, color: colors.muted, fontWeight: weight.semibold },
  chipTextOn: { color: colors.accent },
  row: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, backgroundColor: colors.surface, gap: 6 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowTitle: { flex: 1, fontSize: type.body, fontWeight: weight.semibold, color: colors.text },
  rowTime: { fontSize: type.meta, color: colors.muted },
  rowBottom: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radii.pill, backgroundColor: colors.surfaceMuted },
  badgePhone: { backgroundColor: colors.accentSoft },
  badgeText: { fontSize: 12, color: colors.muted, fontWeight: weight.semibold },
  badgeTextPhone: { color: colors.accent },
  preview: { flex: 1, fontSize: type.meta, color: colors.muted },
  workingWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  working: { fontSize: type.meta, color: colors.accent, fontWeight: weight.semibold },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  empty: { padding: spacing.xl, alignItems: 'center' },
  emptyText: { color: colors.muted, fontSize: type.body },
  fab: {
    position: 'absolute',
    right: spacing.md,
    bottom: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.accent,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    minHeight: 48,
    elevation: 3,
  },
  fabText: { color: colors.onDark, fontSize: type.body, fontWeight: weight.semibold },
});
