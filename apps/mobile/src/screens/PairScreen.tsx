import { QrCode } from 'lucide-react-native';
import { QrScanner } from '../components/QrScanner';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Constants from 'expo-constants';
import { useRoute, type RouteProp } from '@react-navigation/native';
import { HubApiError } from '../hub/types';
import { createHubClient } from '../hub/client';
import {
  TAILSCALE_SETUP_INTRO,
  TAILSCALE_SETUP_TITLE,
  formatTailscaleSetupSteps,
  shouldShowTailscaleGuide,
} from '../hub/tailscale-guide';
import { HUB_URL_HINTS, normalizeHubBaseUrl, resolvePairedHubBaseUrl } from '../storage/hub-url';
import {
  getDefaultHubUrl,
  saveHubBaseUrl,
  savePairingSuccess,
} from '../storage/pairing';
import { colors, spacing } from '../theme';
import {
  isPairTokenInject,
  parsePairDeepLink,
  type PairDeepLinkParams,
} from '../navigation/pair-deep-link';
import type { RootNav, RootStackParamList } from '../navigation/types';
import { useAppSession } from '../session/AppSessionContext';

interface Props {
  navigation: RootNav;
}

function hubUrlFromPairParams(
  params: PairDeepLinkParams | RootStackParamList['Pair'] | undefined,
  sessionUrl: string,
): string {
  if (params?.hubUrl?.trim()) {
    return normalizeHubBaseUrl(params.hubUrl);
  }
  if (params?.host?.trim()) {
    const host = params.host.trim();
    const port = (params.port || '8787').trim();
    // QR may advertise loopback — prefer session/default mesh URL instead.
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
      return sessionUrl || getDefaultHubUrl() || '';
    }
    return normalizeHubBaseUrl(`http://${host}:${port}`);
  }
  return sessionUrl || getDefaultHubUrl() || '';
}

export function PairScreen({ navigation }: Props) {
  const session = useAppSession();
  const { refreshFromStorage } = session;
  const route = useRoute<RouteProp<RootStackParamList, 'Pair'>>();
  const params = route.params;
  const [hubUrl, setHubUrl] = useState(() => hubUrlFromPairParams(params, session.hubBaseUrl));
  const [code, setCode] = useState(() => params?.code?.trim() ?? '');
  const [pairId, setPairId] = useState(() => params?.pairId?.trim() ?? '');
  const [deviceName, setDeviceName] = useState('Android phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const autoStarted = useRef(false);
  const hubUrlRef = useRef(hubUrl);
  hubUrlRef.current = hubUrl;

  useEffect(() => {
    if (session.hubBaseUrl && !hubUrl.trim()) {
      setHubUrl(session.hubBaseUrl);
    }
  }, [session.hubBaseUrl, hubUrl]);

  const applyPairParams = useCallback(
    (incoming: PairDeepLinkParams | null | undefined) => {
      if (!incoming) return;
      if (incoming.code?.trim()) {
        // A fresh QR / link is a new attempt: drop the stale error and re-arm auto-pair.
        setCode(incoming.code.trim());
        setError(null);
        autoStarted.current = false;
      }
      if (incoming.pairId?.trim()) setPairId(incoming.pairId.trim());
      const resolvedHub = hubUrlFromPairParams(incoming, session.hubBaseUrl);
      if (resolvedHub) setHubUrl(resolvedHub);

      if (!isPairTokenInject(incoming)) return;
      const token = incoming.deviceToken!.trim();
      const deviceId = incoming.deviceId!.trim();
      const base =
        resolvedHub ||
        normalizeHubBaseUrl(incoming.hubUrl || '') ||
        normalizeHubBaseUrl(hubUrlRef.current);
      if (!base || autoStarted.current) return;
      autoStarted.current = true;
      void (async () => {
        try {
          setBusy(true);
          await savePairingSuccess({
            hubBaseUrl: base,
            deviceToken: token,
            deviceId,
            hubDisplayName: incoming.hubDisplayName?.trim() || 'Desk PC',
          });
          await refreshFromStorage();
          navigation.replace('Health');
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Token inject failed');
          autoStarted.current = false;
        } finally {
          setBusy(false);
        }
      })();
    },
    [navigation, session],
  );

  // Apply deep-link / QR params when navigation delivers them after mount.
  // Also listen for Linking URL events — after pm clear, getInitialURL is often null
  // and the repair script re-fires the pair deep link once the app is up.
  useEffect(() => {
    let cancelled = false;

    const applyUrl = (url: string | null | undefined) => {
      if (cancelled) return;
      applyPairParams(parsePairDeepLink(url));
    };

    applyPairParams(params);

    void Linking.getInitialURL().then((url) => {
      if (!cancelled) applyUrl(url);
    });
    const sub = Linking.addEventListener('url', ({ url }) => {
      if (!cancelled) applyUrl(url);
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [params, applyPairParams]);

  const onPair = useCallback(async () => {
    setError(null);
    const base = normalizeHubBaseUrl(hubUrl);
    const pairCode = code.trim();
    if (!base) {
      setError(
        `Enter the Hub base URL (Tailscale IP or MagicDNS), e.g. ${HUB_URL_HINTS.ipv4}`,
      );
      return;
    }
    if (!pairCode) {
      setError('Enter the pair code shown on the PC Hub.');
      return;
    }

    setBusy(true);
    try {
      const client = createHubClient({ baseUrl: base });
      const appVersion = Constants.expoConfig?.version ?? '0.1.0';
      const result = await client.pairComplete({
        code: pairCode,
        pairId: pairId.trim() || undefined,
        deviceName: deviceName.trim() || 'Android phone',
        platform: 'android',
        appVersion,
        clientPublicKey: null,
      });

      const resolvedUrl = resolvePairedHubBaseUrl(base, result.hub.baseUrlHint);
      await savePairingSuccess({
        hubBaseUrl: resolvedUrl,
        deviceToken: result.deviceToken,
        deviceId: result.deviceId,
        hubDisplayName: result.hub.displayName,
      });

      await refreshFromStorage();
      navigation.replace('Health');
    } catch (err) {
      if (err instanceof HubApiError) {
        setError(`${err.code}: ${err.message}`);
      } else {
        setError(err instanceof Error ? err.message : 'Pairing failed');
      }
    } finally {
      setBusy(false);
    }
  }, [hubUrl, code, pairId, deviceName, navigation, refreshFromStorage]);

  // Deep link / QR with a code → auto pairComplete (adb UAT + operator QR).
  // Token-inject deep link (PC already called pairComplete) → save + Health.
  useEffect(() => {
    if (autoStarted.current) return;
    const autoFlag = (params?.auto ?? '1').trim().toLowerCase();
    if (autoFlag === '0' || autoFlag === 'false' || autoFlag === 'no') return;

    const token = params?.deviceToken?.trim();
    const id = params?.deviceId?.trim();
    const base = normalizeHubBaseUrl(hubUrl || params?.hubUrl || '');
    if (token && id && base) {
      autoStarted.current = true;
      void (async () => {
        try {
          setBusy(true);
          await savePairingSuccess({
            hubBaseUrl: base,
            deviceToken: token,
            deviceId: id,
            hubDisplayName: params?.hubDisplayName?.trim() || 'Desk PC',
          });
          await refreshFromStorage();
          navigation.replace('Health');
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Token inject failed');
          autoStarted.current = false;
        } finally {
          setBusy(false);
        }
      })();
      return;
    }

    const pairCode = params?.code?.trim() || code.trim();
    if (!pairCode) return;
    if (!normalizeHubBaseUrl(hubUrl)) return;
    autoStarted.current = true;
    void onPair();
  }, [params, code, hubUrl, onPair, navigation, refreshFromStorage]);

  /** Persist typed Hub URL before Health so mesh smoke works without pairing. */
  const onCheckHealth = useCallback(async () => {
    setError(null);
    const base = normalizeHubBaseUrl(hubUrl);
    if (!base) {
      setError(
        `Enter the Hub base URL first (e.g. ${HUB_URL_HINTS.ipv4}), then check health.`,
      );
      return;
    }
    setBusy(true);
    try {
      await saveHubBaseUrl(base);
      await refreshFromStorage();
      navigation.navigate('Health');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save Hub URL');
    } finally {
      setBusy(false);
    }
  }, [hubUrl, navigation, refreshFromStorage]);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.content}>
        <Text style={styles.title}>Pair with PC Hub</Text>
        <Text style={styles.body}>
          Hub must be running on the PC. No cloud login — this binds your phone to this PC only.
        </Text>

        <Pressable
          style={styles.scanBtn}
          onPress={() => setScanning(true)}
          accessibilityRole="button"
          accessibilityLabel="Scan QR"
          testID="pair-scan-qr"
        >
          <QrCode size={22} color={colors.accentText} strokeWidth={2} />
          <Text style={styles.scanText}>Scan QR</Text>
        </Pressable>
        <Text style={styles.hint}>
          On the PC open http://127.0.0.1:8787/pair — it shows the QR. Or enter the code below.
        </Text>
        <QrScanner
          visible={scanning}
          onClose={() => setScanning(false)}
          onScan={(data) => {
            setScanning(false);
            const parsed = parsePairDeepLink(data);
            if (!parsed?.code) {
              setError('That QR is not a Cursor Mobile pairing code. Open 127.0.0.1:8787/pair on the PC.');
              return;
            }
            applyPairParams(parsed);
          }}
        />

        {shouldShowTailscaleGuide({ beforePair: true }) ? (
          <View style={styles.guideBox} accessibilityLabel="Tailscale setup steps">
            <Text style={styles.guideTitle}>{TAILSCALE_SETUP_TITLE}</Text>
            <Text style={styles.body}>{TAILSCALE_SETUP_INTRO}</Text>
            <Text style={styles.guideSteps}>{formatTailscaleSetupSteps()}</Text>
          </View>
        ) : null}

        <Text style={styles.label}>Hub base URL (Tailscale)</Text>
        <TextInput
          style={styles.input}
          value={hubUrl}
          onChangeText={setHubUrl}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={HUB_URL_HINTS.placeholder}
          placeholderTextColor={colors.muted}
          accessibilityLabel="Hub base URL"
          testID="pair-hub-url"
        />
        <Text style={styles.hint}>
          This PC: {HUB_URL_HINTS.ipv4}
          {'\n'}
          MagicDNS: {HUB_URL_HINTS.magicDns}
          {'\n'}
          Editable at runtime — rebuild not required to change Hub host.
        </Text>

        <Text style={styles.label}>Pair code</Text>
        <TextInput
          style={styles.input}
          value={code}
          onChangeText={setCode}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="number-pad"
          placeholder="482913"
          placeholderTextColor={colors.muted}
          accessibilityLabel="Pair code"
          testID="pair-code"
        />

        <Text style={styles.label}>Pair ID (optional, from QR)</Text>
        <TextInput
          style={styles.input}
          value={pairId}
          onChangeText={setPairId}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="pair_…"
          placeholderTextColor={colors.muted}
          accessibilityLabel="Pair ID"
          testID="pair-id"
        />

        <Text style={styles.label}>Device name</Text>
        <TextInput
          style={styles.input}
          value={deviceName}
          onChangeText={setDeviceName}
          placeholder="Pixel"
          placeholderTextColor={colors.muted}
          accessibilityLabel="Device name"
          testID="pair-device-name"
        />

        {error ? (
          <Text style={styles.error} testID="pair-error">
            {error}
          </Text>
        ) : null}

        <Pressable
          style={[styles.button, busy && styles.buttonDisabled]}
          onPress={onPair}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Pair"
          testID="pair-submit"
        >
          {busy ? (
            <ActivityIndicator color={colors.accentText} />
          ) : (
            <Text style={styles.buttonText}>Pair</Text>
          )}
        </Pressable>

        <Pressable
          onPress={onCheckHealth}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Check Hub health without pairing"
        >
          <Text style={styles.link}>Check Hub health without pairing</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  scanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 56,
    borderRadius: 999,
    backgroundColor: colors.accent,
    marginTop: 16,
  },
  scanText: { color: colors.accentText, fontSize: 18, fontWeight: '700' },
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    flex: 1,
    padding: spacing.lg,
    gap: spacing.sm,
    justifyContent: 'center',
  },
  title: {
    color: colors.text,
    fontSize: 24,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  body: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: spacing.md,
  },
  guideBox: {
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: spacing.xs,
  },
  guideTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  guideSteps: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 20,
  },
  label: {
    color: colors.muted,
    fontSize: 12,
    marginTop: spacing.xs,
  },
  hint: {
    color: colors.muted,
    fontSize: 11,
    lineHeight: 16,
    marginBottom: spacing.xs,
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 16,
  },
  button: {
    marginTop: spacing.md,
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: colors.accentText,
    fontWeight: '700',
    fontSize: 16,
  },
  link: {
    color: colors.muted,
    textAlign: 'center',
    marginTop: spacing.md,
    textDecorationLine: 'underline',
  },
  error: {
    color: colors.danger,
    marginTop: spacing.sm,
  },
});
