import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  INSTALL_STEPS,
  decideUpdate,
  formatMegabytes,
  stepState,
  type InstallPhase,
  type UpdateStatus,
} from '../hub/app-update';
import { createHubClient } from '../hub/client';
import type { RootNav } from '../navigation/types';
import { useAppSession } from '../session/AppSessionContext';
import { colors, radii, spacing, type, weight, lineHeight } from '../theme';
import { installedVersionCode } from '../update/installed-version';
import {
  openInstallPermissionSettings,
  openInstaller,
  startDownload,
  verifyApk,
  type DownloadHandle,
} from '../update/installer';

interface Props {
  navigation: RootNav;
}

/**
 * Self-update from the PC Hub: what's new + checks → download → verify →
 * Android installer. Android always asks for the final Install tap.
 */
export function UpdateScreen({ navigation }: Props) {
  const session = useAppSession();
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<UpdateStatus>({ kind: 'unknown' });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phase, setPhase] = useState<InstallPhase>({ step: 'idle' });
  const download = useRef<DownloadHandle | null>(null);
  const apkUri = useRef<string | null>(null);

  const client = useMemo(() => {
    if (!session.hubBaseUrl || !session.deviceToken) return null;
    return createHubClient({ baseUrl: session.hubBaseUrl, deviceToken: session.deviceToken });
  }, [session.hubBaseUrl, session.deviceToken]);

  useEffect(() => {
    if (!client) return;
    let alive = true;
    client
      .getAppLatest()
      .then((latest) => alive && setStatus(decideUpdate(installedVersionCode(), latest)))
      .catch((err) => alive && setLoadError(err instanceof Error ? err.message : 'Cannot reach the PC'));
    return () => {
      alive = false;
    };
  }, [client]);

  // Leaving mid-download cancels it and removes the partial file.
  useEffect(() => () => void download.current?.cancel(), []);

  const install = useCallback(async () => {
    if (status.kind !== 'available' || !client) return;
    const token = client.getDeviceToken();
    if (!token) return;
    const { release } = status;
    try {
      setPhase({ step: 'downloading', percent: 0 });
      const handle = startDownload({
        url: client.appDownloadUrl(release.downloadPath),
        deviceToken: token,
        release,
        onProgress: (percent) => setPhase({ step: 'downloading', percent }),
      });
      download.current = handle;
      const uri = await handle.done;
      download.current = null;
      setPhase({ step: 'verifying' });
      await verifyApk(uri, release);
      apkUri.current = uri;
      setPhase({ step: 'installer' });
      await openInstaller(uri);
    } catch (err) {
      download.current = null;
      const message = err instanceof Error ? err.message : 'Update failed';
      if (message !== 'Cancelled') setPhase({ step: 'failed', message });
    }
  }, [client, status]);

  const cancel = async () => {
    await download.current?.cancel();
    download.current = null;
    setPhase({ step: 'idle' });
  };

  if (loadError) {
    return (
      <View style={[styles.center, { paddingBottom: insets.bottom }]}>
        <Text style={styles.error}>{loadError}</Text>
        <Pressable style={styles.secondaryBtn} onPress={() => navigation.goBack()} accessibilityRole="button">
          <Text style={styles.secondaryText}>Back</Text>
        </Pressable>
      </View>
    );
  }

  if (status.kind !== 'available') {
    return (
      <View style={[styles.center, { paddingBottom: insets.bottom }]}>
        {status.kind === 'unknown' ? (
          <ActivityIndicator color={colors.accent} />
        ) : (
          <Text style={styles.lead}>
            {status.kind === 'up-to-date' ? 'You have the newest build.' : status.message}
          </Text>
        )}
      </View>
    );
  }

  const { release } = status;
  const busy = phase.step === 'downloading' || phase.step === 'verifying';

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.lg }]}
    >
      <View style={styles.header}>
        <Text style={styles.title}>{release.versionName} is ready</Text>
        <Text style={styles.lead}>
          {formatMegabytes(release.sizeBytes)} · from the Hub on {session.hubDisplayName || 'your PC'}
        </Text>
      </View>

      {phase.step === 'idle' ? (
        <>
          <Text style={styles.section}>Checks this build passed</Text>
          <View style={styles.group}>
            {release.testsPassed != null ? (
              <CheckRow label="Release gate on PC" meta={`${release.testsPassed} tests`} />
            ) : null}
            {release.ciRunUrl ? (
              <CheckRow
                label="GitHub CI"
                meta="Open run"
                onPress={() => void Linking.openURL(release.ciRunUrl as string)}
              />
            ) : null}
            <CheckRow label="Same signing key" meta="Android enforces it" last />
          </View>

          {release.notes.length > 0 ? (
            <>
              <Text style={styles.section}>What's new</Text>
              <View style={styles.notes}>
                {release.notes.map((n, i) => (
                  <Text key={`${i}-${n}`} style={styles.note}>
                    •  {n}
                  </Text>
                ))}
              </View>
            </>
          ) : null}

          <Text style={styles.hint}>
            Your pairing and chats stay. Android will ask you to tap Install once.
          </Text>
          <Pressable
            style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
            onPress={() => void install()}
            accessibilityRole="button"
            testID="update-install"
          >
            <Text style={styles.primaryText}>Download and install</Text>
          </Pressable>
          <Pressable style={styles.secondaryBtn} onPress={() => navigation.goBack()} accessibilityRole="button">
            <Text style={styles.secondaryText}>Later</Text>
          </Pressable>
        </>
      ) : (
        <>
          <View style={styles.group}>
            {INSTALL_STEPS.map((s, i) => {
              const state = stepState(phase, s.key);
              return (
                <View key={s.key} style={[styles.stepRow, i < INSTALL_STEPS.length - 1 && styles.rowDivider]}>
                  <View
                    style={[
                      styles.dot,
                      state === 'done' && styles.dotDone,
                      state === 'active' && styles.dotActive,
                    ]}
                  />
                  <View style={styles.stepBody}>
                    <Text style={[styles.stepLabel, state === 'todo' && styles.muted]}>{s.label}</Text>
                    {s.key === 'downloading' && phase.step === 'downloading' ? (
                      <>
                        <View style={styles.track}>
                          <View style={[styles.fill, { width: `${phase.percent}%` }]} />
                        </View>
                        <Text style={styles.meta}>{phase.percent}% · over Tailscale</Text>
                      </>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </View>

          {phase.step === 'failed' ? (
            <View style={styles.failBox}>
              <Text style={styles.error}>{phase.message}</Text>
            </View>
          ) : null}

          {phase.step === 'installer' || phase.step === 'failed' ? (
            <View style={styles.warnBox}>
              <Text style={styles.warnText}>
                First time only: Android asks to allow installs from Cursor Mobile. Turn it on once, then come back.
              </Text>
              <Pressable
                style={styles.linkBtn}
                onPress={() => void openInstallPermissionSettings()}
                accessibilityRole="button"
              >
                <Text style={styles.linkText}>Open that setting</Text>
              </Pressable>
            </View>
          ) : null}

          {phase.step === 'installer' && apkUri.current ? (
            <Pressable
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
              onPress={() => void openInstaller(apkUri.current as string)}
              accessibilityRole="button"
            >
              <Text style={styles.primaryText}>Open installer again</Text>
            </Pressable>
          ) : null}
          {phase.step === 'failed' ? (
            <Pressable
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
              onPress={() => void install()}
              accessibilityRole="button"
            >
              <Text style={styles.primaryText}>Try again</Text>
            </Pressable>
          ) : null}
          {busy ? (
            <>
              <Text style={styles.hint}>If the check fails the file is deleted and nothing is installed.</Text>
              <Pressable style={styles.secondaryBtn} onPress={() => void cancel()} accessibilityRole="button">
                <Text style={styles.secondaryText}>Cancel</Text>
              </Pressable>
            </>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

function CheckRow({
  label,
  meta,
  onPress,
  last,
}: {
  label: string;
  meta: string;
  onPress?: () => void;
  last?: boolean;
}) {
  const body = (
    <>
      <Text style={styles.check}>✓</Text>
      <Text style={styles.checkLabel}>{label}</Text>
      <Text style={[styles.meta, onPress && styles.linkText]}>{meta}</Text>
    </>
  );
  return onPress ? (
    <Pressable style={[styles.checkRow, !last && styles.rowDivider]} onPress={onPress} accessibilityRole="link">
      {body}
    </Pressable>
  ) : (
    <View style={[styles.checkRow, !last && styles.rowDivider]}>{body}</View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.sm },
  center: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    gap: spacing.md,
  },
  header: { gap: spacing.xxs, marginBottom: spacing.sm },
  title: { color: colors.text, fontSize: type.title, fontWeight: weight.semibold },
  lead: { color: colors.muted, fontSize: type.meta, lineHeight: lineHeight.body, textAlign: 'left' },
  section: { color: colors.muted, fontSize: type.meta, fontWeight: weight.semibold, marginTop: spacing.sm },
  group: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    minHeight: 48,
  },
  check: { color: colors.accent, fontSize: type.body, fontWeight: weight.semibold },
  checkLabel: { flex: 1, color: colors.text, fontSize: type.body },
  notes: { gap: spacing.xs, paddingHorizontal: spacing.xxs },
  note: { color: colors.text, fontSize: type.body, lineHeight: lineHeight.body },
  hint: { color: colors.muted, fontSize: type.meta, lineHeight: lineHeight.meta, marginTop: spacing.sm },
  primaryBtn: {
    marginTop: spacing.sm,
    minHeight: 52,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { color: colors.accentText, fontSize: type.body, fontWeight: weight.semibold },
  secondaryBtn: { minHeight: 48, alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' },
  secondaryText: { color: colors.text, fontSize: type.body, fontWeight: weight.semibold },
  pressed: { opacity: 0.85 },
  stepRow: { flexDirection: 'row', gap: spacing.md, padding: spacing.md },
  stepBody: { flex: 1, gap: spacing.xs },
  stepLabel: { color: colors.text, fontSize: type.body, fontWeight: weight.semibold },
  muted: { color: colors.muted, fontWeight: weight.regular },
  dot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: colors.borderStrong,
  },
  dotActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  dotDone: { borderColor: colors.accent, backgroundColor: colors.accent },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.accentSoft, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3, backgroundColor: colors.accent },
  meta: { color: colors.muted, fontSize: type.meta },
  failBox: { backgroundColor: colors.dangerSoft, borderRadius: radii.sm, padding: spacing.md },
  error: { color: colors.danger, fontSize: type.meta, lineHeight: lineHeight.body },
  warnBox: { backgroundColor: colors.warnSoft, borderRadius: radii.sm, padding: spacing.md, gap: spacing.xs },
  warnText: { color: colors.warnText, fontSize: type.meta, lineHeight: lineHeight.body },
  linkBtn: { minHeight: 44, justifyContent: 'center' },
  linkText: { color: colors.accent, fontWeight: weight.semibold },
});
