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
import {
  ChevronDown,
  ChevronRight,
  Folder,
  Plus,
  Search,
  Settings,
  SquarePen,
} from 'lucide-react-native';
import { ConnectionChip } from '../components/ConnectionChip';
import {
  agentRowMeta,
  agentsSyncHint,
  countWaiting,
  cursorProblem,
  filterAgents,
} from '../hub/agents-list';
import { createHubClient } from '../hub/client';
import { deriveConnectionState } from '../hub/connection-state';
import {
  HubApiError,
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
  /** Profile footer gear → Account tab (same destination as the tab bar). */
  onOpenAccount?: () => void;
}

type ListEntry =
  | { kind: 'header'; project: AgentsProjectRow }
  | { kind: 'chat'; chat: AgentsChatRow; projectId: string };

/**
 * Chats home: the Cursor Agents-window list from the PC Hub (projects → chats),
 * refreshed on focus, on pull, on Hub WS events, and quietly every 15 s.
 */
export function ChatsHomeScreen({ navigation, onOpenAccount }: Props) {
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
  /** Phone-side collapse toggles; untouched projects follow the PC sidebar. */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
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
    const searching = query.trim() !== '';
    for (const project of visible?.projects ?? []) {
      rows.push({ kind: 'header', project });
      // Searching always shows matches; otherwise phone toggle, else the PC's state.
      const isCollapsed = !searching && (collapsed[project.projectId] ?? project.expanded === false);
      if (isCollapsed) continue;
      for (const chat of project.chats) {
        rows.push({ kind: 'chat', chat, projectId: project.projectId });
      }
    }
    return rows;
  }, [visible, collapsed, query]);

  const isCollapsed = (project: AgentsProjectRow) =>
    query.trim() === '' && (collapsed[project.projectId] ?? project.expanded === false);
  const toggleProject = (project: AgentsProjectRow) =>
    setCollapsed((prev) => ({ ...prev, [project.projectId]: !isCollapsed(project) }));

  const waiting = countWaiting(agents);
  const hubName = session.hubDisplayName || 'Desk PC';

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

      <Pressable
        style={({ pressed }) => [styles.newChat, pressed && styles.rowPressed]}
        onPress={() => navigation.navigate('NewAgentChat')}
        accessibilityRole="button"
        accessibilityLabel="New Chat"
        testID="chats-new-chat"
      >
        <SquarePen size={20} color={colors.text} strokeWidth={1.75} />
        <Text style={styles.newChatText}>New Chat</Text>
      </Pressable>

      <View style={styles.searchWrap}>
        <Search size={18} color={colors.muted} strokeWidth={1.75} style={styles.searchIcon} />
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

      {cursorProblem(agents) ? (
        <Text style={styles.cursorAlert} testID="chats-cursor-alert">
          {cursorProblem(agents)}
        </Text>
      ) : null}

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
            const closed = isCollapsed(row.project);
            const Chevron = closed ? ChevronRight : ChevronDown;
            return (
              <View style={styles.sectionHeader} testID={`project-${row.project.projectId}`}>
                <Pressable
                  style={styles.sectionToggle}
                  onPress={() => toggleProject(row.project)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: !closed }}
                  accessibilityLabel={`${row.project.name}, ${row.project.chats.length} chats`}
                >
                  <Chevron size={16} color={colors.muted} strokeWidth={2} />
                  <Folder size={16} color={colors.muted} strokeWidth={1.75} />
                  <Text style={styles.sectionTitle} numberOfLines={1}>
                    {row.project.name}
                  </Text>
                  {closed ? (
                    <Text style={styles.sectionMeta}>{row.project.chats.length}</Text>
                  ) : row.project.hasMore ? (
                    <Text style={styles.sectionMeta}>More on PC</Text>
                  ) : null}
                </Pressable>
                <Pressable
                  style={styles.sectionAdd}
                  hitSlop={8}
                  onPress={() =>
                    navigation.navigate('NewAgentChat', { projectId: row.project.projectId })
                  }
                  accessibilityRole="button"
                  accessibilityLabel={`New chat in ${row.project.name}`}
                >
                  <Plus size={18} color={colors.muted} strokeWidth={1.75} />
                </Pressable>
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

      <Pressable
        style={({ pressed }) => [styles.profile, pressed && styles.rowPressed]}
        onPress={onOpenAccount}
        accessibilityRole="button"
        accessibilityLabel="Account and settings"
        testID="chats-profile"
      >
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{hubName.slice(0, 1).toUpperCase()}</Text>
        </View>
        <Text style={styles.profileName} numberOfLines={1}>
          {hubName}
        </Text>
        <Settings size={20} color={colors.muted} strokeWidth={1.75} />
      </Pressable>
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
  newChat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 48,
    marginHorizontal: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
  },
  newChatText: { color: colors.text, fontSize: 16, fontWeight: '600' },
  searchWrap: { paddingHorizontal: spacing.md, paddingBottom: spacing.sm, justifyContent: 'center' },
  searchIcon: { position: 'absolute', left: spacing.md + spacing.sm, zIndex: 1 },
  search: {
    paddingLeft: spacing.xl + spacing.xs,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    minHeight: 44,
    color: colors.text,
    fontSize: type.body,
  },
  cursorAlert: {
    color: colors.danger,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radii.sm,
    marginHorizontal: spacing.md,
    marginBottom: spacing.xs,
    padding: spacing.sm,
    fontSize: 13,
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
  listContent: { paddingBottom: spacing.lg },
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
    alignItems: 'center',
    paddingLeft: spacing.sm,
    paddingRight: spacing.md,
    paddingTop: spacing.sm,
    backgroundColor: colors.bg,
  },
  sectionToggle: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 44,
    paddingHorizontal: spacing.sm,
  },
  sectionAdd: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  sectionTitle: {
    flexShrink: 1,
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
  profile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 52,
    paddingHorizontal: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.accentText, fontWeight: '700' },
  profileName: { flex: 1, color: colors.text, fontSize: 15 },
});
