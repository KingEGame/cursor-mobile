import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ConnectionChip } from '../components/ConnectionChip';
import {
  agentRowMeta,
  agentsSyncHint,
  countWaiting,
  filterAgents,
} from '../hub/agents-list';
import { createHubClient, isLivePathDegraded } from '../hub/client';
import { deriveConnectionState } from '../hub/connection-state';
import {
  HubApiError,
  isWorkspaceBound,
  type AgentsChatRow,
  type AgentsProjectRow,
  type AgentsResponse,
} from '../hub/types';
import { HubWebSocket } from '../hub/ws';
import type { RootNav } from '../navigation/types';
import { useAppSession } from '../session/AppSessionContext';
import { colors, radii, spacing, type } from '../theme';

/** Background refresh while Chats is visible — the PC sidebar has no push events yet. */
const POLL_MS = 15_000;

interface Props {
  navigation: RootNav;
}

type ListEntry =
  | { kind: 'header'; project: AgentsProjectRow }
  | { kind: 'chat'; chat: AgentsChatRow; projectId: string };

/**
 * Chats home: the Cursor Agents-window list from the PC Hub (projects → chats),
 * refreshed on focus, on pull, on Hub WS events, and quietly every 15 s.
 */
export function ChatsHomeScreen({ navigation }: Props) {
  const session = useAppSession();
  // Stable callbacks only — depending on `session` itself re-creates loaders on every
  // setHealthAndWorkspace and causes an endless refresh / WS reconnect loop.
  const { setHealthAndWorkspace } = session;
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [pulling, setPulling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentsResponse | null>(null);
  const [lastApiError, setLastApiError] = useState<HubApiError | null>(null);
  const [query, setQuery] = useState('');
  const inFlight = useRef(false);
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

  /** Silent by default; only a user pull shows the spinner. */
  const refresh = useCallback(
    async (opts?: { pull?: boolean }) => {
      if (!client) {
        navigation.replace('Pair');
        return;
      }
      if (inFlight.current) return;
      inFlight.current = true;
      if (opts?.pull) setPulling(true);
      try {
        const [health, workspace, list] = await Promise.all([
          client.getHealth(),
          client.getWorkspace(),
          client.listAgents(),
        ]);
        setHealthAndWorkspace(health, workspace);
        setAgents(list);
        setError(null);
        setLastApiError(null);
      } catch (err) {
        if (err instanceof HubApiError && err.status === 401) {
          // Background polls must not wipe pairing: a Hub restarted with another data
          // dir answers 401 until the right one is back. Send the operator to Pair and
          // keep the token; a successful re-pair overwrites it.
          navigation.replace('Pair');
          return;
        }
        if (err instanceof HubApiError) setLastApiError(err);
        setError(err instanceof Error ? err.message : 'Refresh failed');
      } finally {
        inFlight.current = false;
        setLoading(false);
        setPulling(false);
      }
    },
    [client, navigation, setHealthAndWorkspace],
  );

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      void refresh();
    }, 400);
  }, [refresh]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
      const id = setInterval(() => void refresh(), POLL_MS);
      return () => {
        clearInterval(id);
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
      };
    }, [refresh]),
  );

  // Hub health / session events → quick re-pull (debounced).
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

  const visible = useMemo(
    () => (agents ? filterAgents(agents, query) : null),
    [agents, query],
  );

  const listData: ListEntry[] = useMemo(() => {
    const rows: ListEntry[] = [];
    for (const project of visible?.projects ?? []) {
      rows.push({ kind: 'header', project });
      for (const chat of project.chats) {
        rows.push({ kind: 'chat', chat, projectId: project.projectId });
      }
    }
    return rows;
  }, [visible]);

  const waiting = countWaiting(agents);
  const bound = !!(session.workspace && isWorkspaceBound(session.workspace));
  const degraded = isLivePathDegraded(session.health);

  const openChat = (chat: AgentsChatRow) => {
    navigation.navigate('HistoryRead', { sessionId: chat.sessionId, title: chat.title });
  };

  const showWaiting = () => {
    if (!agents) return;
    const first = agents.projects
      .flatMap((p) => p.chats)
      .find((c) => c.status === 'waiting_approval');
    if (waiting === 1 && first) openChat(first);
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <Text style={styles.title}>Chats</Text>
        <ConnectionChip
          state={connectionState}
          onPress={() => navigation.navigate('Health')}
        />
      </View>

      <View style={styles.searchWrap}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search chats"
          placeholderTextColor={colors.muted}
          style={styles.search}
          accessibilityLabel="Search chats"
          autoCorrect={false}
          returnKeyType="search"
          testID="chats-search"
        />
      </View>

      {agents ? (
        <Text style={styles.syncHint} numberOfLines={2} testID="chats-sync-status">
          {agentsSyncHint(agents)}
        </Text>
      ) : null}

      {waiting > 0 ? (
        <Pressable
          onPress={showWaiting}
          style={styles.waitingPill}
          accessibilityRole="button"
          testID="chats-waiting-pill"
        >
          <Text style={styles.waitingText}>
            {waiting} waiting for approval{waiting === 1 ? ' →' : ''}
          </Text>
        </Pressable>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <FlatList
        data={listData}
        keyExtractor={(row) =>
          row.kind === 'header'
            ? `h-${row.project.projectId}`
            : `c-${row.projectId}-${row.chat.composerId}`
        }
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={() => void refresh({ pull: true })}
            tintColor={colors.accent}
          />
        }
        contentContainerStyle={
          listData.length === 0 ? styles.emptyContainer : styles.listContent
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.xl }} />
          ) : (
            <View style={styles.empty} testID="chats-empty">
              <Text style={styles.emptyTitle}>
                {query.trim() ? 'No matching chats' : 'No chats yet'}
              </Text>
              <Text style={styles.emptyBody}>
                {query.trim()
                  ? 'Try another name, or clear Search.'
                  : 'Open Cursor on the PC and start a chat in the Agents window.'}
              </Text>
            </View>
          )
        }
        renderItem={({ item: row }) => {
          if (row.kind === 'header') {
            return (
              <View style={styles.sectionHeader} testID={`project-${row.project.projectId}`}>
                <Text style={styles.sectionTitle} numberOfLines={1}>
                  {row.project.name}
                </Text>
                {row.project.hasMore ? (
                  <Text style={styles.sectionMeta}>More on PC</Text>
                ) : null}
              </View>
            );
          }
          const { chat } = row;
          const meta = agentRowMeta(chat);
          const warn = chat.status === 'waiting_approval';
          const failed = chat.status === 'error';
          return (
            <Pressable
              onPress={() => openChat(chat)}
              style={({ pressed }) => [
                styles.row,
                chat.activeOnPc && styles.rowActive,
                pressed && styles.rowPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={`${chat.title}${meta ? `, ${meta}` : ''}`}
              testID={`chat-${chat.composerId}`}
            >
              <View
                style={[
                  styles.mark,
                  chat.status === 'working' && styles.markWorking,
                  warn && styles.markWarn,
                  failed && styles.markError,
                  chat.unread && chat.status === 'idle' && styles.markUnread,
                ]}
              />
              <View style={styles.rowBody}>
                <Text
                  style={[styles.rowTitle, chat.unread && styles.rowTitleUnread]}
                  numberOfLines={1}
                >
                  {chat.title}
                </Text>
                {meta ? (
                  <Text
                    style={[styles.rowMeta, warn && styles.rowMetaWarn, failed && styles.rowMetaError]}
                    numberOfLines={1}
                  >
                    {meta}
                  </Text>
                ) : null}
              </View>
              {chat.ageLabel ? <Text style={styles.age}>{chat.ageLabel}</Text> : null}
            </Pressable>
          );
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
  searchWrap: { paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  search: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    minHeight: 44,
    color: colors.text,
    fontSize: type.body,
  },
  syncHint: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 16,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  waitingPill: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    minHeight: 40,
    justifyContent: 'center',
    borderRadius: radii.pill,
    backgroundColor: '#fff4e0',
  },
  waitingText: { color: colors.warn, fontWeight: '600', fontSize: type.meta },
  error: {
    color: colors.danger,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
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
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: 4,
    backgroundColor: colors.bg,
  },
  sectionTitle: {
    flex: 1,
    color: colors.text,
    fontSize: type.body,
    fontWeight: '600',
  },
  sectionMeta: { color: colors.muted, fontSize: 12, marginLeft: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    marginHorizontal: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
    borderRadius: radii.sm,
  },
  rowActive: { backgroundColor: colors.surfaceMuted },
  rowPressed: { backgroundColor: colors.border },
  mark: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: spacing.sm,
    backgroundColor: colors.border,
  },
  markWorking: { backgroundColor: colors.accent },
  markWarn: { backgroundColor: colors.warn },
  markError: { backgroundColor: colors.danger },
  markUnread: { backgroundColor: colors.accent },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.text, fontSize: type.body },
  rowTitleUnread: { fontWeight: '600' },
  rowMeta: { color: colors.muted, fontSize: 12, marginTop: 2 },
  rowMetaWarn: { color: colors.warn, fontWeight: '600' },
  rowMetaError: { color: colors.danger },
  age: { color: colors.muted, fontSize: type.meta, marginLeft: spacing.sm },
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
