import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { CommonActions } from '@react-navigation/native';
import Constants from 'expo-constants';
import { HubApiError } from '../hub/types';
import { createHubClient } from '../hub/client';
import { appVersionLabel } from '../hub/app-version';
import {
  connectionStateLabel,
  deriveConnectionState,
} from '../hub/connection-state';
import {
  TAILSCALE_SETUP_INTRO,
  TAILSCALE_SETUP_TITLE,
  formatTailscaleSetupSteps,
  shouldShowTailscaleGuide,
} from '../hub/tailscale-guide';
import { colors, spacing } from '../theme';
import type { RootNav } from '../navigation/types';
import { deriveHealthLevel, useAppSession } from '../session/AppSessionContext';
import { HealthDot } from '../components/HealthDot';

interface Props {
  navigation: RootNav;
}

function resolveAppVersionLabel(): string {
  const version =
    Constants.expoConfig?.version ??
    Constants.nativeAppVersion ??
    null;
  const build =
    Constants.nativeBuildVersion ??
    (Constants.expoConfig?.android as { versionCode?: number } | undefined)
      ?.versionCode ??
    null;
  return appVersionLabel({ version, build });
}

function row(label: string, value: string, ok?: boolean) {
  return (
    <View style={styles.row} key={label}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, ok === false && styles.bad, ok === true && styles.good]}>
        {value}
      </Text>
    </View>
  );
}

export function HealthScreen({ navigation }: Props) {
  const session = useAppSession();
  // Stable callbacks only — depending on `session` itself re-creates loaders on every
  // setHealthAndWorkspace and causes an endless refresh / WS reconnect loop.
  const { setHealthAndWorkspace, outboundQueue } = session;
  const workspaceRef = useRef(session.workspace);
  workspaceRef.current = session.workspace;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [lastApiError, setLastApiError] = useState<HubApiError | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);

  const refresh = useCallback(async () => {
    setError(null);
    setLastApiError(null);
    if (!session.hubBaseUrl) {
      setError('Set a Hub URL on the Pair screen first.');
      return;
    }
    setBusy(true);
    try {
      const client = createHubClient({
        baseUrl: session.hubBaseUrl,
        deviceToken: session.deviceToken,
      });
      const health = await client.getHealth();
      let workspace = workspaceRef.current;
      if (session.deviceToken) {
        try {
          workspace = await client.getWorkspace();
        } catch (wsErr) {
          if (wsErr instanceof HubApiError && wsErr.status === 401) {
            // Keep the token: a 401 can come from a Hub restarted with another data dir.
            // Pair overwrites it on success; Account → Clear pairing still wipes it.
            navigation.replace('Pair');
            return;
          }
          if (wsErr instanceof HubApiError) {
            setLastApiError(wsErr);
          }
          // Health still useful if workspace call fails
        }
      }
      setHealthAndWorkspace(health, workspace);
      setQueuedCount(await outboundQueue.pendingCount());
      setLastRefresh(new Date());
    } catch (err) {
      if (err instanceof HubApiError) {
        setLastApiError(err);
        setError(`${err.code}: ${err.message}`);
      } else {
        setError(err instanceof Error ? err.message : 'Health check failed');
      }
      setHealthAndWorkspace(null, null);
    } finally {
      setBusy(false);
    }
  }, [
    session.hubBaseUrl,
    session.deviceToken,
    setHealthAndWorkspace,
    
    outboundQueue,
    navigation,
  ]);

  // Check once on open; `refresh` is stable now, so this does not loop.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const [navHint, setNavHint] = useState<string | null>(null);

  const goToSessions = useCallback(() => {
    setNavHint('Opening sessions…');
    // CommonActions.reset — navigate()/Linking.openURL did not leave Health under adb
    // even though this Pressable onPress fires (proven by wiring Continue→refresh).
    navigation.dispatch(
      CommonActions.reset({
        index: 0,
        routes: [{ name: 'Main' }],
      }),
    );
  }, [navigation]);

  useEffect(() => {
    const openHomeFromUrl = (url: string) => {
      if (/cursor-companion:\/\/\/?(?:nav\/)?home\b/i.test(url)) {
        goToSessions();
      }
    };
    const sub = Linking.addEventListener('url', ({ url }) => openHomeFromUrl(url));
    void Linking.getInitialURL().then((url) => {
      if (url) openHomeFromUrl(url);
    });
    return () => sub.remove();
  }, [goToSessions]);

  const health = session.health;
  const level = deriveHealthLevel(health);
  const connectionState = deriveConnectionState({
    hubBaseUrl: session.hubBaseUrl,
    deviceToken: session.deviceToken,
    health,
    lastError: lastApiError,
    queuedCount,
  });
  const hubUnreachable = Boolean(error) && !health;
  const showTailscaleGuide = shouldShowTailscaleGuide({
    beforePair: !session.deviceToken,
    connectionState,
    hubUnreachable,
  });
  const workspaceBound = health?.workspace?.bound === true;
  const canContinue = health?.ok === true;

  // Footer CTAs sit outside ScrollView so adb / gesture nav taps are not stolen by
  // the scroll responder (Refresh mid-scroll worked; Continue/Re-pair at bottom did not).
  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={busy} onRefresh={refresh} tintColor={colors.accent} />
        }
      >
        <View style={styles.header}>
          <Text style={styles.title}>Hub health</Text>
          <HealthDot level={level} label={level} />
        </View>
        <Text
          style={styles.versionLabel}
          accessibilityLabel={`App version ${resolveAppVersionLabel()}`}
          testID="health-app-version"
        >
          {resolveAppVersionLabel()}
        </Text>
        <Text style={styles.body}>
          Prove the phone can reach the Hub on this PC. Composer remoting is optional for Pair and queued
          New-session — this screen never dials CDP (localhost-only on the PC).
        </Text>
        <Text style={styles.meta}>
          State: {connectionState}
          {queuedCount > 0 ? ` · offline queue ${queuedCount}` : ''}
        </Text>
        <Text style={styles.body}>{connectionStateLabel(connectionState)}</Text>

        {showTailscaleGuide ? (
          <View style={styles.guideBox} accessibilityLabel="Tailscale setup steps">
            <Text style={styles.guideTitle}>{TAILSCALE_SETUP_TITLE}</Text>
            <Text style={styles.body}>{TAILSCALE_SETUP_INTRO}</Text>
            <Text style={styles.guideSteps}>{formatTailscaleSetupSteps()}</Text>
          </View>
        ) : null}

        {!session.hubBaseUrl ? (
          <Text style={styles.warn}>No Hub URL configured — set it on Pair after Tailscale is Online.</Text>
        ) : (
          <Text style={styles.meta}>Hub: {session.hubBaseUrl}</Text>
        )}

        <Pressable
          style={[styles.button, busy && styles.buttonDisabled]}
          onPress={refresh}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Refresh health"
          testID="health-refresh"
          collapsable={false}
        >
          {busy ? (
            <ActivityIndicator color={colors.accentText} />
          ) : (
            <Text style={styles.buttonText} importantForAccessibility="no">
              Refresh
            </Text>
          )}
        </Pressable>

        {/* Keep Continue near Refresh (upper ScrollView) — adb taps in footer were delivered
            to a clickable Button but JS onPress never ran (Pixel gesture / RN hit-test). */}
        {canContinue && workspaceBound ? (
          <Pressable
            style={styles.button}
            onPress={goToSessions}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Continue to sessions"
            testID="health-continue-sessions"
            collapsable={false}
          >
            <Text style={styles.buttonText} importantForAccessibility="no">
              Continue to sessions
            </Text>
          </Pressable>
        ) : null}

        {navHint ? <Text style={styles.good}>{navHint}</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {lastRefresh ? (
          <Text style={styles.meta}>Last refresh: {lastRefresh.toLocaleTimeString()}</Text>
        ) : null}

        {health ? (
          <View style={styles.card}>
            {row('Hub', health.hub.status, health.ok)}
            {row(
              'CDP / adapter',
              health.cdp.status,
              health.cdp.status === 'connected',
            )}
            {row(
              'Live adapter',
              health.liveAdapter
                ? `${health.liveAdapter.state}${
                    health.liveAdapter.extractorReady ? '' : ' (mutations blocked)'
                  }`
                : 'n/a (older Hub)',
              health.liveAdapter?.state === 'cdp_ok' &&
                health.liveAdapter.extractorReady === true,
            )}
            {(health.sessionCreateQueue?.pending ?? 0) > 0
              ? row(
                  'Create queue',
                  `${health.sessionCreateQueue!.pending} pending` +
                    (health.liveAdapter?.state === 'cdp_ok'
                      ? ' · Retrying'
                      : ' · Queuing'),
                  false,
                )
              : null}
            {row(
              'Cursor',
              health.cursor.status,
              health.cursor.status === 'running',
            )}
            {row(
              'Workspace',
              workspaceBound
                ? `${health.workspace?.name ?? 'bound'} (${health.workspace?.path ?? ''})`
                : 'No project open on PC',
              workspaceBound,
            )}
            {row(
              'Pairing',
              health.pairing.required
                ? `${health.pairing.devicesPaired} device(s)`
                : 'not required',
            )}
          </View>
        ) : (
          <Text style={styles.meta}>Pull to refresh or tap Refresh.</Text>
        )}

        {canContinue && !workspaceBound ? (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyTitle}>Open a project on the PC</Text>
            <Text style={styles.body}>
              Cursor has no folder open (or Hub cannot bind it yet). Open the project in Cursor, then
              Refresh. There is no cloud project picker.
            </Text>
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.footer} collapsable={false}>
        <Pressable
          onPress={() => navigation.navigate('Pair')}
          accessibilityRole="button"
          accessibilityLabel="Re-pair device"
          testID="health-repair"
          collapsable={false}
        >
          <Text style={styles.link} importantForAccessibility="no">
            {session.deviceToken ? 'Re-pair device' : 'Go to Pair'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.md },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    // Keep above Pixel gesture inset — footer at y≈2177 was untappable via adb.
    paddingBottom: spacing.xl + 48,
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { color: colors.text, fontSize: 24, fontWeight: '700' },
  versionLabel: { color: colors.muted, fontSize: 12 },
  body: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  meta: { color: colors.muted, fontSize: 12 },
  warn: { color: colors.warn, fontSize: 14 },
  error: { color: colors.danger },
  guideBox: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: spacing.xs,
  },
  guideTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  guideSteps: { color: colors.text, fontSize: 13, lineHeight: 20 },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing.md,
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  row: { gap: 2 },
  rowLabel: { color: colors.muted, fontSize: 12 },
  rowValue: { color: colors.text, fontSize: 15 },
  good: { color: colors.healthy },
  bad: { color: colors.danger },
  button: {
    marginTop: spacing.sm,
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: colors.accentText, fontWeight: '700', fontSize: 16 },
  secondary: {
    marginTop: spacing.sm,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  secondaryText: { color: colors.text },
  emptyBox: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
    gap: spacing.sm,
  },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '600' },
  link: {
    color: colors.muted,
    textAlign: 'center',
    marginTop: spacing.lg,
    textDecorationLine: 'underline',
  },
});
