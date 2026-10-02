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
        <Text style={styles.title}>Account</Text>
        <ConnectionChip
          state={connectionState}
          onPress={() => navigation.navigate('Health')}
        />
      </View>

      <Text style={styles.lead}>{connectionStateLabel(connectionState)}</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Hub</Text>
        <Text style={styles.cardValue}>
          {session.hubDisplayName || 'Desk PC'}
        </Text>
        <Text style={styles.cardMeta} numberOfLines={2}>
          {session.hubBaseUrl || '—'}
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>PC project</Text>
        <Text style={styles.cardValue}>{projectName}</Text>
        {session.workspace && isWorkspaceBound(session.workspace) ? (
          <Text style={styles.cardMeta} numberOfLines={2}>
            {session.workspace.path}
          </Text>
        ) : (
          <Text style={styles.cardMeta}>Open a folder in Cursor on the PC.</Text>
        )}
      </View>

      <UpdateCard
        status={updateStatus}
        installedLabel={installedVersionLabel()}
        onOpen={() => navigation.navigate('Update')}
      />

      <NotificationsCard />

      <SecurityCard />

      {pendingApprovals > 0 ? (
        <View style={styles.card} testID="account-approvals-badge">
          <Text style={styles.cardLabel}>Approvals</Text>
          <Text style={styles.cardValue}>
            {pendingApprovals} pending in live chats
          </Text>
          <Text style={styles.cardMeta}>
            Open a live chat to Approve or Deny — tools run on the PC.
          </Text>
        </View>
      ) : null}

      <Pressable
        style={styles.rowBtn}
        onPress={() => navigation.navigate('Health')}
        accessibilityRole="button"
        testID="account-health"
      >
        <Text style={styles.rowBtnText}>Health details</Text>
      </Pressable>

      <Pressable
        style={styles.rowBtn}
        onPress={() => navigation.navigate('Editor')}
        accessibilityRole="button"
        testID="account-editor"
      >
        <Text style={styles.rowBtnText}>Browse PC files</Text>
        <Text style={styles.rowBtnMeta}>Optional · workspace roots only</Text>
      </Pressable>

      <Pressable
        style={styles.rowBtn}
        onPress={() => navigation.navigate('Pair')}
        accessibilityRole="button"
        testID="account-repair"
      >
        <Text style={styles.rowBtnText}>Re-pair device</Text>
      </Pressable>

      <Pressable
        style={[styles.rowBtn, styles.dangerRow]}
        onPress={() => void unpair()}
        accessibilityRole="button"
        testID="account-unpair"
      >
        <Text style={styles.dangerText}>Clear pairing</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
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
