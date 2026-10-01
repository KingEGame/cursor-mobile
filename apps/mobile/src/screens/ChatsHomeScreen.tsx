import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChatListRow } from '../components/ChatListRow';
import { ConnectionChip } from '../components/ConnectionChip';
import {
  buildProjectSections,
  chatsEmptyCopy,
  mergeSessionsByRecency,
  type ProjectSection,
} from '../hub/chats-home';
import { createHubClient, isLivePathDegraded } from '../hub/client';
import {
  deriveConnectionState,
} from '../hub/connection-state';
import { HISTORY_LIST_LIMIT } from '../hub/history-list';
import { canOpenSessionFromList } from '../hub/session-list-ux';
import {
  HubApiError,
  isWorkspaceBound,
  type SessionListItem,
} from '../hub/types';
import { HubWebSocket } from '../hub/ws';
import type { RootNav } from '../navigation/types';
import { useAppSession } from '../session/AppSessionContext';
import { colors, radii, spacing, type } from '../theme';

function formatSyncedAgo(at: Date | null): string | null {
  if (!at) return null;
  const sec = Math.max(0, Math.floor((Date.now() - at.getTime()) / 1000));
  if (sec < 15) return 'Synced just now';
  if (sec < 60) return `Synced ${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `Synced ${min}m ago`;
  return `Synced ${Math.floor(min / 60)}h ago`;
}

interface Props {
  navigation: RootNav;
}

type ListEntry =
  | { kind: 'header'; section: ProjectSection }
  | { kind: 'session'; item: SessionListItem };

/**
 * Chats home: PC Hub workspace / sessions only.
 * Refresh on mount, tab focus, pull-to-refresh, and Hub WS health/session events
 * so the list stays aligned with Composer chats on the chosen PC.
 */
export function ChatsHomeScreen({ navigation }: Props) {
  const session = useAppSession();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [lastApiError, setLastApiError] = useState<HubApiError | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [parityHint, setParityHint] = useState<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connectionState = deriveConnectionState({
    hubBaseUrl: session.hubBaseUrl,
    deviceToken: session.deviceToken,
    health: session.health,
    lastError: lastApiError,
  });

  const client = useMemo(() => {
    if (!session.hubBaseUrl || !session.deviceToken) return null;
    return createHubClient({
      baseUrl: session.hubBaseUrl,
      deviceToken: session.deviceToken,
    });
  }, [session.hubBaseUrl, session.deviceToken]);

  const refresh = useCallback(async () => {
    if (!client) {
      navigation.replace('Pair');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const [health, workspace] = await Promise.all([
        client.getHealth(),
        client.getWorkspace(),
      ]);
      session.setHealthAndWorkspace(health, workspace);

      if (!isWorkspaceBound(workspace)) {
        setSessions([]);
        setParityHint('Open a folder in Cursor on the PC, then refresh.');
        setLastSyncedAt(new Date());
        return;
      }

      const [live, history] = await Promise.all([
        client.listSessions(workspace.workspaceId, {
          mode: 'live',
          limit: HISTORY_LIST_LIMIT,
          tolerateMissing: true,
        }),
        client.listSessions(workspace.workspaceId, {
          mode: 'history',
          limit: HISTORY_LIST_LIMIT,
          tolerateMissing: true,
        }),
      ]);
      const merged = mergeSessionsByRecency(live.items, history.items);
      setSessions(merged);
      setLastApiError(null);
      setLastSyncedAt(new Date());

      const histMeta = history.history ?? live.history;
      if (histMeta?.extractorStale) {
        setParityHint('PC chat index may be behind — pull to refresh.');
      } else if (health.liveAdapter?.state !== 'cdp_ok') {
        setParityHint('Live Cursor degraded — showing Hub history for this PC project.');
      } else {
        setParityHint(
          `${merged.length} chat${merged.length === 1 ? '' : 's'} from this PC`,
        );
      }
    } catch (err) {
      if (err instanceof HubApiError && err.status === 401) {
        await session.clearDevice();
        navigation.replace('Pair');
        return;
      }
      if (err instanceof HubApiError) setLastApiError(err);
      setError(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setBusy(false);
    }
  }, [client, navigation, session]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      void refresh();
    }, 400);
  }, [refresh]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
      return () => {
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
      };
    }, [refresh]),
  );

  // Keep Home list in sync with Hub when health / sessions change on the PC.
  useEffect(() => {
    if (!session.hubBaseUrl || !session.deviceToken) return;
    const ws = new HubWebSocket({
      baseUrl: session.hubBaseUrl,
      deviceToken: session.deviceToken,
      subscriptions: { health: true, workspace: true, sessions: [] },
      onEvent: (event) => {
        if (
          event.type === 'health.changed' ||
          event.type === 'session.updated' ||
          event.type === 'workspace.changed'
        ) {
          scheduleRefresh();
        }
      },
    });
    ws.connect();
    return () => {
      ws.close();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [session.hubBaseUrl, session.deviceToken, scheduleRefresh]);

  const bound = !!(session.workspace && isWorkspaceBound(session.workspace));
  const sections = useMemo(
    () => buildProjectSections({ workspace: session.workspace, sessions }),
    [session.workspace, sessions],
  );

  const listData: ListEntry[] = useMemo(() => {
    const rows: ListEntry[] = [];
    for (const section of sections) {
      rows.push({ kind: 'header', section });
      for (const item of section.sessions) {
        rows.push({ kind: 'session', item });
      }
    }
    return rows;
  }, [sections]);

  const openSession = (item: SessionListItem) => {
    if (!canOpenSessionFromList(item.mode)) return;
    if (item.mode === 'live') {
      navigation.navigate('LiveChat', { sessionId: item.id, title: item.title });
      return;
    }
    if (item.mode === 'history') {
      navigation.navigate('HistoryRead', {
        sessionId: item.id,
        title: item.title,
      });
    }
  };

  const empty = chatsEmptyCopy(bound);
  const degraded = isLivePathDegraded(session.health);
  const syncedLabel = formatSyncedAgo(lastSyncedAt);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <Text style={styles.title}>Chats</Text>
        <ConnectionChip
          state={connectionState}
          onPress={() => navigation.navigate('Health')}
        />
      </View>

      {syncedLabel || parityHint ? (
        <Pressable
          onPress={() => void refresh()}
          accessibilityRole="button"
          accessibilityLabel="Refresh chats from PC"
          style={styles.syncRow}
          testID="chats-sync-status"
        >
          {syncedLabel ? <Text style={styles.syncMeta}>{syncedLabel}</Text> : null}
          {parityHint ? <Text style={styles.syncHint}>{parityHint}</Text> : null}
        </Pressable>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <FlatList
        data={listData}
        keyExtractor={(row, i) =>
          row.kind === 'header' ? `h-${row.section.workspaceId}` : `s-${row.item.id}-${i}`
        }
        refreshControl={
          <RefreshControl refreshing={busy} onRefresh={refresh} tintColor={colors.accent} />
        }
        contentContainerStyle={
          listData.length === 0 ? styles.emptyContainer : styles.listContent
        }
        ListEmptyComponent={
          busy ? (
            <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.xl }} />
          ) : (
            <View style={styles.empty} testID="chats-empty">
              <Text style={styles.emptyTitle}>{empty.title}</Text>
              <Text style={styles.emptyBody}>{empty.body}</Text>
              <Pressable
                style={styles.primaryBtn}
                onPress={() => {
                  if (!bound) {
                    navigation.navigate('Health');
                    return;
                  }
                  navigation.navigate('NewSession');
                }}
                accessibilityRole="button"
                testID="chats-empty-cta"
              >
                <Text style={styles.primaryBtnText}>{empty.cta}</Text>
              </Pressable>
            </View>
          )
        }
        renderItem={({ item: row }) => {
          if (row.kind === 'header') {
            return (
              <View style={styles.sectionHeader} testID={`project-section-${row.section.workspaceId}`}>
                <Text style={styles.sectionTitle} numberOfLines={1}>
                  {row.section.name}
                </Text>
                <Text style={styles.sectionMeta} numberOfLines={1}>
                  {row.section.isOpenOnPc ? 'Open on PC' : 'From history'}
                  {row.section.pendingApprovals > 0
                    ? ` · ${row.section.pendingApprovals} approval`
                    : ''}
                </Text>
              </View>
            );
          }
          return <ChatListRow item={row.item} onPress={openSession} />;
        }}
      />

      {bound ? (
        <Pressable
          style={[
            styles.fab,
            { bottom: 16 + insets.bottom },
            degraded && styles.fabMuted,
          ]}
          onPress={() => navigation.navigate('NewSession')}
          accessibilityRole="button"
          accessibilityLabel="New chat"
          testID="chats-new-chat"
          collapsable={false}
        >
          <Text style={styles.fabText}>New chat</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    paddingTop: spacing.sm,
  },
  title: {
    color: colors.text,
    fontSize: type.title,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  error: {
    color: colors.danger,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  syncRow: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    gap: 2,
  },
  syncMeta: {
    color: colors.muted,
    fontSize: 12,
  },
  syncHint: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 16,
  },
  listContent: { paddingBottom: 96 },
  emptyContainer: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },
  empty: { alignItems: 'center', gap: spacing.md },
  emptyTitle: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center',
  },
  emptyBody: {
    color: colors.muted,
    fontSize: type.body,
    lineHeight: 22,
    textAlign: 'center',
    maxWidth: 320,
  },
  primaryBtn: {
    marginTop: spacing.sm,
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.pill,
    minHeight: 48,
    justifyContent: 'center',
  },
  primaryBtnText: {
    color: colors.accentText,
    fontWeight: '600',
    fontSize: type.body,
  },
  sectionHeader: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
    backgroundColor: colors.bg,
  },
  sectionTitle: {
    color: colors.muted,
    fontSize: type.section,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  sectionMeta: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 2,
  },
  fab: {
    position: 'absolute',
    right: spacing.md,
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.pill,
    minHeight: 52,
    justifyContent: 'center',
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  fabMuted: { opacity: 0.85 },
  fabText: {
    color: colors.accentText,
    fontWeight: '700',
    fontSize: type.body,
  },
});
