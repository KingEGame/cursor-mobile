import { NotificationsCard } from '../components/NotificationsCard';
import { SecurityCard } from '../components/SecurityCard';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check, ChevronRight, Monitor, RefreshCw } from 'lucide-react-native';
import { loadKnownHubs, rememberHub, type KnownHub } from '../storage/known-hubs';
import { savePairingSuccess } from '../storage/pairing';
import { ConnectionChip } from '../components/ConnectionChip';
import { UpdateCard } from '../components/UpdateCard';
import { decideUpdate, type UpdateStatus } from '../hub/app-update';
import { installedVersionCode, installedVersionLabel } from '../update/installed-version';
import { createHubClient } from '../hub/client';
import {
  connectionStateLabel,
  deriveConnectionState,
} from '../hub/connection-state';
import { HubApiError, isWorkspaceBound } from '../hub/types';
import type { RootNav } from '../navigation/types';
import { useAppSession } from '../session/AppSessionContext';
import { colors, radii, spacing, type } from '../theme';

interface Props {
  navigation: RootNav;
}

/**
 * Account / settings tab — Hub identity, health, pair, advanced tools.
 * Approvals stay in-chat; optional pending count here as a quiet link.
 */
export function AccountScreen({ navigation }: Props) {
  const session = useAppSession();
  // Stable callbacks only — depending on `session` itself re-creates loaders on every
  // setHealthAndWorkspace and causes an endless refresh / WS reconnect loop.
  const { setHealthAndWorkspace, clearDevice } = session;
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [lastApiError, setLastApiError] = useState<HubApiError | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ kind: 'unknown' });
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [knownHubs, setKnownHubs] = useState<KnownHub[]>([]);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const { refreshFromStorage } = session;

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
    if (!client) return;
    setBusy(true);
    setError(null);
    try {
      const [health, workspace] = await Promise.all([
        client.getHealth(),
        client.getWorkspace(),
      ]);
      setHealthAndWorkspace(health, workspace);
      setLastApiError(null);
      setLastSynced(new Date());

      // Self-update check — an older Hub without /v1/app/* just means "no feed".
      client
        .getAppLatest()
        .then((latest) => setUpdateStatus(decideUpdate(installedVersionCode(), latest)))
        .catch(() =>
          setUpdateStatus({ kind: 'none-published', message: 'This PC Hub does not offer app updates yet.' }),
        );

      if (isWorkspaceBound(workspace)) {
        const live = await client.listSessions(workspace.workspaceId, {
          mode: 'live',
          limit: 50,
          tolerateMissing: true,
        });
        setPendingApprovals(
          live.items.reduce((n, s) => n + (s.pendingApprovals || 0), 0),
        );
      } else {
        setPendingApprovals(0);
      }
    } catch (err) {
      if (err instanceof HubApiError && err.status === 401) {
        // Keep the token: a 401 can come from a Hub restarted with another data dir.
        // Pair overwrites it on success; Account → Clear pairing still wipes it.
        navigation.replace('Pair');
        return;
      }
      if (err instanceof HubApiError) setLastApiError(err);
      setError(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setBusy(false);
    }
  }, [client, navigation, setHealthAndWorkspace, clearDevice]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Saved PCs; seed the list with the current pairing for phones paired before it existed.
  useEffect(() => {
    void (async () => {
      let list = await loadKnownHubs();
      if (session.deviceToken && session.deviceId && session.hubBaseUrl && list.length === 0) {
        await rememberHub({
          hubBaseUrl: session.hubBaseUrl,
          deviceToken: session.deviceToken,
          deviceId: session.deviceId,
          hubDisplayName: session.hubDisplayName,
        });
        list = await loadKnownHubs();
      }
      setKnownHubs(list);
    })();
  }, [session.deviceToken, session.deviceId, session.hubBaseUrl, session.hubDisplayName]);

  /** Switch the phone to another saved PC; stay on the current one if it cannot be reached. */
  const switchTo = async (hub: KnownHub) => {
    setSwitchError(null);
    try {
      await createHubClient({ baseUrl: hub.hubBaseUrl, deviceToken: hub.deviceToken }).getHealth();
    } catch {
      setSwitchError(`${hub.hubDisplayName || hub.hubBaseUrl} is not reachable — staying on this PC`);
      return;
    }
    await savePairingSuccess({
      hubBaseUrl: hub.hubBaseUrl,
      deviceToken: hub.deviceToken,
      deviceId: hub.deviceId,
      hubDisplayName: hub.hubDisplayName || 'PC',
    });
    await refreshFromStorage();
  };

  const unpair = async () => {
    await clearDevice();
    navigation.replace('Pair');
  };

  const projectName =
    session.workspace && isWorkspaceBound(session.workspace)
      ? session.workspace.name
      : 'No project open';

  return (
    <ScrollView
      style={[styles.root, { paddingTop: insets.top }]}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={busy} onRefresh={refresh} tintColor={colors.accent} />
      }
    >
      <View style={styles.topBar}>
        <Text style={styles.title}>Settings</Text>
        <ConnectionChip
          state={connectionState}
          onPress={() => navigation.navigate('Health')}
        />
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Text style={styles.section}>Connection</Text>
      <View style={styles.card}>
        <Row title="Status" meta={connectionStateLabel(connectionState)} />
        <Row
          title="How it works"
          meta="On the PC open 127.0.0.1:8787/pair to show a QR; on this phone tap Pair a PC → Scan QR. Cursor stays on the PC — the phone is a remote over Tailscale."
        />
        <ActionRow label="Pair a PC" onPress={() => navigation.navigate('Pair')} testID="account-repair" />
      </View>

      <Text style={styles.section}>Computer</Text>
      <View style={styles.card}>
        <Text style={styles.cardMeta}>Chats and projects come from this PC's Hub.</Text>
        {(knownHubs.length ? knownHubs : []).map((hub) => {
          const active = hub.hubBaseUrl === session.hubBaseUrl;
          return (
            <Pressable
              key={hub.hubBaseUrl}
              style={({ pressed }) => [styles.pcRow, pressed && !active && styles.pressed]}
              onPress={() => (active ? undefined : void switchTo(hub))}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel="Choose computer"
            >
              <Monitor size={20} color={active ? colors.accent : colors.muted} strokeWidth={1.75} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.rowTitle, active && { color: colors.accent }]}>
                  {hub.hubDisplayName || 'PC'}
                </Text>
                <Text style={styles.cardMeta}>{hub.hubBaseUrl}</Text>
              </View>
              {active ? <Check size={18} color={colors.accent} /> : null}
            </Pressable>
          );
        })}
        {knownHubs.length === 0 ? <Text style={styles.cardMeta}>No computers saved — pair with a Hub first.</Text> : null}
        {switchError ? <Text style={styles.error}>{switchError}</Text> : null}
        <Row title="Project bound on PC" meta={`${projectName}${session.workspace && isWorkspaceBound(session.workspace) ? ' · ' + session.workspace.path : ''}`} />
      </View>

      <Text style={styles.section}>Sync</Text>
      <View style={styles.card}>
        <Row
          title="Refresh now"
          meta={`Reload projects and chats from the selected computer.${lastSynced ? ` Last synced ${lastSynced.toLocaleTimeString()}.` : ''}`}
        />
        <Pressable
          style={[styles.primary, busy && { opacity: 0.6 }]}
          onPress={() => void refresh()}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Refresh from computer"
          testID="account-refresh-now"
        >
          <RefreshCw size={18} color={colors.accentText} />
          <Text style={styles.primaryText}>{busy ? 'Syncing…' : 'Refresh now'}</Text>
        </Pressable>
      </View>

      <UpdateCard
        status={updateStatus}
        installedLabel={installedVersionLabel()}
        onOpen={() => navigation.navigate('Update')}
      />

      <NotificationsCard />

      <SecurityCard />

      <Text style={styles.section}>Advanced</Text>
      <View style={styles.card}>
        <ActionRow label="Health details" onPress={() => navigation.navigate('Health')} testID="account-health" />
        <ActionRow label="Browse PC files" meta="Workspace roots only" onPress={() => navigation.navigate('Editor')} testID="account-editor" />
        <ActionRow label="Clear pairing" danger onPress={() => void unpair()} testID="account-unpair" />
      </View>
    </ScrollView>
  );
}

function Row(props: { title: string; meta: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowTitle}>{props.title}</Text>
      <Text style={styles.cardMeta}>{props.meta}</Text>
    </View>
  );
}

function ActionRow(props: { label: string; meta?: string; danger?: boolean; onPress: () => void; testID?: string }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.actionRow, pressed && styles.pressed]}
      onPress={props.onPress}
      accessibilityRole="button"
      testID={props.testID}
    >
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowTitle, props.danger && { color: colors.danger }]}>{props.label}</Text>
        {props.meta ? <Text style={styles.cardMeta}>{props.meta}</Text> : null}
      </View>
      <ChevronRight size={18} color={colors.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { color: colors.muted, fontSize: 13, fontWeight: '600', marginTop: spacing.md, marginBottom: spacing.xs },
  row: { paddingVertical: spacing.xs, gap: 2 },
  rowTitle: { color: colors.text, fontSize: 16 },
  pcRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 52, borderRadius: radii.sm, paddingHorizontal: spacing.xs },
  actionRow: { flexDirection: 'row', alignItems: 'center', minHeight: 48, borderRadius: radii.sm, paddingHorizontal: spacing.xs },
  pressed: { backgroundColor: colors.surfaceMuted },
  primary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: 48,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    marginTop: spacing.sm,
  },
  primaryText: { color: colors.accentText, fontWeight: '700', fontSize: 16 },
  root: { flex: 1, backgroundColor: colors.bg },
  content: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xl,
    gap: spacing.sm,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
  },
  title: {
    color: colors.text,
    fontSize: type.title,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  lead: {
    color: colors.muted,
    fontSize: type.meta,
    lineHeight: 18,
    marginBottom: spacing.sm,
  },
  error: { color: colors.danger, marginBottom: spacing.sm },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  cardLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  cardValue: {
    color: colors.text,
    fontSize: type.body,
    fontWeight: '600',
  },
  cardMeta: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
  },
  rowBtn: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    minHeight: 52,
    justifyContent: 'center',
  },
  rowBtnText: {
    color: colors.text,
    fontSize: type.body,
    fontWeight: '500',
  },
  rowBtnMeta: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 2,
  },
  dangerRow: { marginTop: spacing.md },
  dangerText: {
    color: colors.danger,
    fontSize: type.body,
    fontWeight: '600',
  },
});
