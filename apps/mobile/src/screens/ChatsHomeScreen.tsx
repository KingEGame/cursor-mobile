import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
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
  agentsSyncShort,
  countWaiting,
  countWorking,
  filterActive,
  cursorProblem,
  filterAgents,
} from '../hub/agents-list';
import { sendFailureText } from '../hub/send-errors';
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
import { colors, radii, spacing, type, weight, lineHeight } from '../theme';

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
  const [activeOnly, setActiveOnly] = useState(false);
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

  /**
   * Silent by default; only a user pull shows the spinner. `quiet` (timer ticks) re-reads
   * just the chat list: health + workspace change rarely and arrive over the WS anyway.
   */
  const refresh = useCallback(
    async (opts?: { pull?: boolean; quiet?: boolean }) => {
      if (!client) {
        navigation.replace('Pair');
        return;
      }
      if (inFlight.current) return;
      inFlight.current = true;
      if (opts?.pull) setPulling(true);
      try {
        if (opts?.quiet) {
          setAgents(await client.listAgents());
        } else {
          const [health, workspace, list] = await Promise.all([
            client.getHealth(),
            client.getWorkspace(),
            client.listAgents(),
          ]);
          setHealthAndWorkspace(health, workspace);
          setAgents(list);
        }
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
        setError(
          err instanceof HubApiError
            ? sendFailureText(err.code, err.status, err.message)
            : 'Couldn’t refresh — check your connection.',
        );
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

  // Poll only while the app is on screen; a backgrounded phone must not wake the PC Hub
  // every 15 s. Coming back to the foreground does one full refresh.
  useFocusEffect(
    useCallback(() => {
      void refresh();
      const id = setInterval(() => {
        if (AppState.currentState === 'active') void refresh({ quiet: true });
      }, POLL_MS);
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'active') void refresh();
      });
      return () => {
        clearInterval(id);
        sub.remove();
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
    () => (agents ? filterAgents(activeOnly ? filterActive(agents) : agents, query) : null),
    [agents, query, activeOnly],
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
  const working = countWorking(agents);
  const hubName = session.hubDisplayName || 'PC';

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

      <View style={styles.searchRow}>
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
        <Pressable
          style={({ pressed }) => [styles.newChatBtn, pressed && styles.rowPressed]}
          onPress={() => navigation.navigate('NewAgentChat')}
          accessibilityRole="button"
          accessibilityLabel="New Chat"
          testID="chats-new-chat"
        >
          <SquarePen size={20} color={colors.accentText} strokeWidth={1.75} />
        </Pressable>
      </View>

      {cursorProblem(agents) ? (
        <Text style={styles.cursorAlert} testID="chats-cursor-alert">
          {cursorProblem(agents)}
        </Text>
      ) : null}

      {agents ? (
        <View style={styles.statusRow}>
          <Pressable
            onPress={() => setActiveOnly((v) => !v)}
            style={[styles.statusChip, activeOnly && styles.statusChipOn]}
            hitSlop={{ top: 8, bottom: 8 }}
            accessibilityRole="button"
            accessibilityState={{ selected: activeOnly }}
            accessibilityLabel={`${working} agent${working === 1 ? '' : 's'} working. ${activeOnly ? 'Show all chats' : 'Show only active sessions'}`}
            testID="chats-working-chip"
          >
            <View style={[styles.statusDot, working > 0 && styles.statusDotLive]} />
            <Text style={[styles.statusChipText, activeOnly && styles.statusChipTextOn]}>
              {working} working
            </Text>
          </Pressable>
          {waiting > 0 ? (
            <Pressable
              onPress={waiting === 1 ? showWaiting : () => setActiveOnly(true)}
              style={styles.waitingPill}
              hitSlop={{ top: 8, bottom: 8 }}
              accessibilityRole="button"
              testID="chats-waiting-pill"
            >
              <Text style={styles.waitingText}>
                {waiting} waiting{waiting === 1 ? ' →' : ''}
              </Text>
            </Pressable>
          ) : null}
          <Text style={styles.syncHint} numberOfLines={1} testID="chats-sync-status">
            {activeOnly ? 'Active sessions only' : `${hubName} · ${agentsSyncShort(agents)}`}
          </Text>
        </View>
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
              {error && !agents ? (
                <>
                  <Text style={styles.emptyTitle}>Can’t reach your PC</Text>
                  <Text style={styles.emptyBody}>
                    Check that Tailscale is on for this phone and for the PC, then try again.
                  </Text>
                  <Pressable
                    onPress={() => void refresh({ pull: true })}
                    style={styles.emptyCta}
                    accessibilityRole="button"
                    accessibilityLabel="Try again"
                    testID="chats-retry"
                  >
                    <Text style={styles.emptyCtaText}>Try again</Text>
                  </Pressable>
                </>
              ) : null}
              {!(error && !agents) ? (
              <>
              <Text style={styles.emptyTitle}>
                {query.trim() ? 'No matching chats' : activeOnly ? 'No agents running' : 'No chats yet'}
              </Text>
              <Text style={styles.emptyBody}>
                {query.trim()
                  ? 'Try another name, or clear Search.'
                  : 'Open Cursor on the PC and start a chat in the Agents window.'}
              </Text>
              {!query.trim() && !activeOnly ? (
                <Pressable
                  onPress={() => navigation.navigate('NewAgentChat')}
                  style={styles.emptyCta}
                  accessibilityRole="button"
                  accessibilityLabel="New Chat"
                >
                  <Text style={styles.emptyCtaText}>New Chat</Text>
                </Pressable>
              ) : null}
              </>
              ) : null}
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
    paddingBottom: spacing.xxs,
    paddingTop: spacing.xxs,
  },
  title: {
    color: colors.text,
    fontSize: type.sub,
    fontWeight: weight.semibold,
  },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingBottom: spacing.xs },
  newChatBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
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
  newChatText: { color: colors.text, fontSize: type.body, fontWeight: weight.semibold },
  searchWrap: { flex: 1, justifyContent: 'center' },
  searchIcon: { position: 'absolute', left: spacing.sm, zIndex: 1 },
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
    fontSize: type.meta,
  },
  syncHint: {
    flex: 1,
    color: colors.muted,
    fontSize: type.meta,
    lineHeight: lineHeight.meta,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.xs,
  },
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 32,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  statusChipOn: { backgroundColor: colors.text, borderColor: colors.text },
  statusChipText: { color: colors.text, fontWeight: weight.semibold, fontSize: type.meta },
  statusChipTextOn: { color: colors.onDark },
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.muted },
  statusDotLive: { backgroundColor: colors.accent },
  statusHint: { color: colors.muted, fontSize: type.meta },
  waitingPill: {
    paddingHorizontal: spacing.md,
    minHeight: 40,
    justifyContent: 'center',
    borderRadius: radii.pill,
    backgroundColor: colors.warnSoft,
  },
  waitingText: { color: colors.warn, fontWeight: weight.semibold, fontSize: type.meta },
  error: {
    color: colors.danger,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  listContent: { paddingBottom: spacing.lg },
  emptyContainer: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },
  empty: { alignItems: 'center', gap: spacing.md },
  emptyCta: {
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyCtaText: { color: colors.accentText, fontSize: type.body, fontWeight: weight.semibold },
  emptyTitle: {
    color: colors.text,
    fontSize: type.sub,
    fontWeight: weight.semibold,
    textAlign: 'center',
  },
  emptyBody: {
    color: colors.muted,
    fontSize: type.body,
    lineHeight: lineHeight.body,
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
    fontWeight: weight.semibold,
  },
  sectionMeta: { color: colors.muted, fontSize: type.meta, marginLeft: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    marginHorizontal: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
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
  rowTitleUnread: { fontWeight: weight.semibold },
  rowMeta: { color: colors.muted, fontSize: type.meta, marginTop: spacing.xxs },
  rowMetaWarn: { color: colors.warn, fontWeight: weight.semibold },
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
  avatarText: { color: colors.accentText, fontWeight: weight.semibold },
  profileName: { flex: 1, color: colors.text, fontSize: type.body },
});
