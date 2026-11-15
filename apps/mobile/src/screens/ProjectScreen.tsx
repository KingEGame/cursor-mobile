import React, { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Plus } from 'lucide-react-native';
import { useBridge } from '../bridge/BridgeProvider';
import { describeError } from '../bridge/errors';
import { sessionTitle } from '../bridge/format';
import type { Session } from '../bridge/types';
import type { ScreenProps } from '../navigation/types';
import { colors, radii, spacing, type, weight } from '../theme';
import { SessionRow } from './SessionsScreen';

/** One project: its sessions (from every client) + "New chat" that starts the agent in the project folder. */
export function ProjectScreen({ navigation, route }: ScreenProps<'Project'>) {
  const { slug } = route.params;
  const name = route.params.name ?? slug;
  const bridge = useBridge();
  const [items, setItems] = useState<Session[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);

  useLayoutEffect(() => {
    navigation.setOptions({ title: name });
  }, [navigation, name]);

  const load = useCallback(async () => {
    try {
      setItems((await bridge.client.sessions({ project: slug, limit: 100 })).items);
      setError(null);
    } catch (err) {
      setError(describeError(err, bridge.pairing.pcName));
    }
  }, [bridge.client, bridge.pairing.pcName, slug]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // Live status/preview come from the mirror (WebSocket) when the session is known there.
  const rows = useMemo(() => {
    const live = new Map(bridge.mirror.sessions.map((s) => [s.id, s]));
    return (items ?? []).map((s) => {
      const m = live.get(s.id);
      return m ? { ...s, status: m.status, preview: m.preview ?? s.preview, updatedAt: m.updatedAt ?? s.updatedAt } : s;
    });
  }, [items, bridge.mirror.sessions]);

  const startChat = async () => {
    setCreating(true);
    try {
      const chatId = await bridge.newChat(slug);
      navigation.navigate('Chat', { chatId, title: 'New chat', project: name });
    } catch (err) {
      setError(describeError(err, bridge.pairing.pcName));
    } finally {
      setCreating(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={['bottom']}>
      {error ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{error}</Text>
        </View>
      ) : null}
      <FlatList
        data={rows}
        keyExtractor={(s) => s.id}
        renderItem={({ item }) => (
          <SessionRow
            s={item}
            hideProject
            onPress={() => navigation.navigate('Chat', { sessionId: item.id, title: sessionTitle(item), project: name })}
          />
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
              <Text style={styles.emptyText}>No sessions in {name} yet. Start one below.</Text>
            )}
          </View>
        }
        contentContainerStyle={{ paddingBottom: 96 }}
      />
      <Pressable
        style={[styles.fab, creating && { opacity: 0.6 }]}
        onPress={() => void startChat()}
        disabled={creating || bridge.connection === 'revoked'}
        testID="project-new-chat"
      >
        <Plus size={20} color={colors.onDark} />
        <Text style={styles.fabText} numberOfLines={1}>
          New chat in {name}
        </Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  banner: { backgroundColor: colors.warnSoft, padding: spacing.sm, paddingHorizontal: spacing.md },
  bannerText: { color: colors.warnText, fontSize: type.meta, lineHeight: 18 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  empty: { padding: spacing.xl, alignItems: 'center' },
  emptyText: { color: colors.muted, fontSize: type.body, textAlign: 'center' },
  fab: {
    position: 'absolute',
    right: spacing.md,
    bottom: spacing.lg,
    maxWidth: '80%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.accent,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    minHeight: 48,
    elevation: 3,
  },
  fabText: { color: colors.onDark, fontSize: type.body, fontWeight: weight.semibold, flexShrink: 1 },
});
