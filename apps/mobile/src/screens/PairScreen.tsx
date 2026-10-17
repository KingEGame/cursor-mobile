import { ChevronDown, ChevronUp, QrCode } from 'lucide-react-native';
import { QrScanner } from '../components/QrScanner';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Constants from 'expo-constants';
import { useRoute, type RouteProp } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
import { CalmEnter } from '../motion/calmEnter';
import { colors, radii, spacing, type, weight, lineHeight } from '../theme';
import {
  isPairTokenInject,
  parsePairDeepLink,
  type PairDeepLinkParams,
} from '../navigation/pair-deep-link';
import type { RootNav, RootStackParamList } from '../navigation/types';
import { useAppSession } from '../session/AppSessionContext';

/** Loopback pair page — open on the PC browser only. */
const PC_PAIR_URL = 'http://127.0.0.1:8787/pair';

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
    // QR must advertise Tailscale host — loopback is useless on the phone.
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
  const insets = useSafeAreaInsets();
  const route = useRoute<RouteProp<RootStackParamList, 'Pair'>>();
  const params = route.params;
  const [hubUrl, setHubUrl] = useState(() => hubUrlFromPairParams(params, session.hubBaseUrl));
  const [code, setCode] = useState(() => params?.code?.trim() ?? '');
  const [pairId, setPairId] = useState(() => params?.pairId?.trim() ?? '');
  const [deviceName, setDeviceName] = useState('Android phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [showTailscale, setShowTailscale] = useState(false);
  const autoStarted = useRef(false);
  const hubUrlRef = useRef(hubUrl);
  hubUrlRef.current = hubUrl;

  useEffect(() => {
    if (session.hubBaseUrl && !hubUrl.trim()) {
      setHubUrl(session.hubBaseUrl);
    }
  }, [session.hubBaseUrl, hubUrl]);

  const pairWith = useCallback(
    async (input: { hubUrl: string; code: string; pairId?: string; deviceName?: string }) => {
      setError(null);
      const base = normalizeHubBaseUrl(input.hubUrl);
      const pairCode = input.code.trim();
      if (!base) {
        setError(
          `QR did not include a reachable Hub address. On the PC open ${PC_PAIR_URL} (Hub must advertise Tailscale, not 127.0.0.1).`,
        );
        setShowManual(true);
        return false;
      }
      if (!pairCode) {
        setError('No pair code — scan the QR on the PC pair page.');
        return false;
      }

      setBusy(true);
      try {
        const client = createHubClient({ baseUrl: base });
        const appVersion = Constants.expoConfig?.version ?? '0.1.0';
        const result = await client.pairComplete({
          code: pairCode,
          pairId: input.pairId?.trim() || undefined,
          deviceName: (input.deviceName ?? deviceName).trim() || 'Android phone',
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
        return true;
      } catch (err) {
        if (err instanceof HubApiError) {
          setError(`${err.code}: ${err.message}`);
        } else {
          setError(err instanceof Error ? err.message : 'Pairing failed');
        }
        setShowManual(true);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [deviceName, navigation, refreshFromStorage],
  );

  const applyPairParams = useCallback(
    (incoming: PairDeepLinkParams | null | undefined) => {
      if (!incoming) return { hub: '', code: '', pairId: '' };
      let nextCode = '';
      let nextPairId = '';
      if (incoming.code?.trim()) {
        nextCode = incoming.code.trim();
        setCode(nextCode);
        setError(null);
        autoStarted.current = false;
      }
      if (incoming.pairId?.trim()) {
        nextPairId = incoming.pairId.trim();
        setPairId(nextPairId);
      }
      const resolvedHub = hubUrlFromPairParams(incoming, session.hubBaseUrl);
      if (resolvedHub) setHubUrl(resolvedHub);

      // PC already completed pair — save token and leave Pair (no form).
      if (isPairTokenInject(incoming) && !autoStarted.current) {
        const token = incoming.deviceToken!.trim();
        const deviceId = incoming.deviceId!.trim();
        const base =
          resolvedHub ||
          normalizeHubBaseUrl(incoming.hubUrl || '') ||
          normalizeHubBaseUrl(hubUrlRef.current);
        if (base) {
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
        }
      }

      return {
        hub: resolvedHub,
        code: nextCode || incoming.code?.trim() || '',
        pairId: nextPairId || incoming.pairId?.trim() || '',
      };
    },
    [session.hubBaseUrl, refreshFromStorage, navigation],
  );

  // Deep-link / QR params after mount + Linking events.
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
    await pairWith({ hubUrl, code, pairId, deviceName });
  }, [pairWith, hubUrl, code, pairId, deviceName]);

  // Token-inject deep link (PC already completed pair) or QR with code → auto pair.
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
    // Only auto-start when params brought a code (QR / deep link), not idle form.
    if (!params?.code?.trim()) return;
    autoStarted.current = true;
    void pairWith({ hubUrl, code: pairCode, pairId, deviceName }).then((ok) => {
      if (!ok) autoStarted.current = false;
    });
  }, [params, code, hubUrl, pairId, deviceName, pairWith, navigation, refreshFromStorage]);

  const onScanQr = useCallback(
    (data: string) => {
      setScanning(false);
      const parsed = parsePairDeepLink(data);
      if (!parsed?.code) {
        setError(
          `That QR is not a Cursor Mobile pairing code. On the PC open ${PC_PAIR_URL}.`,
        );
        return;
      }
      const filled = applyPairParams(parsed);
      autoStarted.current = true;
      void pairWith({
        hubUrl: filled.hub || hubUrlFromPairParams(parsed, session.hubBaseUrl),
        code: filled.code || parsed.code,
        pairId: filled.pairId || parsed.pairId,
        deviceName,
      }).then((ok) => {
        if (!ok) autoStarted.current = false;
      });
    },
    [applyPairParams, deviceName, pairWith, session.hubBaseUrl],
  );

  const onCheckHealth = useCallback(async () => {
    setError(null);
    const base = normalizeHubBaseUrl(hubUrl);
    if (!base) {
      setError(
        `Need a Hub URL from the QR (or enter one in Manual). Example: ${HUB_URL_HINTS.ipv4}`,
      );
      setShowManual(true);
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

  const guideDefault = shouldShowTailscaleGuide({ beforePair: true });

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior="padding"
      keyboardVerticalOffset={insets.top}
    >
      <ScrollView
        style={styles.root}
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + spacing.md,
            paddingBottom: insets.bottom + spacing.xl,
          },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator
        testID="pair-scroll"
      >
        <CalmEnter>
          <Text style={styles.title}>Pair with Hub</Text>
          <Text style={styles.body}>
            On the PC open {PC_PAIR_URL}, then scan that QR here. Hub URL and code come from the QR — you do not type them.
          </Text>

          <Pressable
            style={({ pressed }) => [styles.scanBtn, pressed && styles.pressed, busy && styles.buttonDisabled]}
            onPress={() => setScanning(true)}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Scan QR"
            testID="pair-scan-qr"
          >
            {busy ? (
              <ActivityIndicator color={colors.accentText} />
            ) : (
              <>
                <QrCode size={22} color={colors.accentText} strokeWidth={2} />
                <Text style={styles.scanText}>Scan QR</Text>
              </>
            )}
          </Pressable>

          {busy ? (
            <Text style={styles.status} accessibilityLiveRegion="polite">
              Pairing with PC…
            </Text>
          ) : null}

          {error ? (
            <Text style={styles.error} testID="pair-error">
              {error}
            </Text>
          ) : null}

          <QrScanner visible={scanning} onClose={() => setScanning(false)} onScan={onScanQr} />

          <Pressable
            style={({ pressed }) => [styles.disclosure, pressed && styles.pressed]}
            onPress={() => setShowTailscale((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ expanded: showTailscale || guideDefault }}
            accessibilityLabel="Tailscale setup"
          >
            <Text style={styles.disclosureText}>{TAILSCALE_SETUP_TITLE}</Text>
            {showTailscale || guideDefault ? (
              <ChevronUp size={18} color={colors.muted} />
            ) : (
              <ChevronDown size={18} color={colors.muted} />
            )}
          </Pressable>
          {showTailscale || guideDefault ? (
            <View style={styles.guideBox} accessibilityLabel="Tailscale setup steps">
              <Text style={styles.bodyTight}>{TAILSCALE_SETUP_INTRO}</Text>
              <Text style={styles.guideSteps}>{formatTailscaleSetupSteps()}</Text>
            </View>
          ) : null}

          <Pressable
            style={({ pressed }) => [styles.disclosure, pressed && styles.pressed]}
            onPress={() => setShowManual((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ expanded: showManual }}
            accessibilityLabel="Enter code manually"
            testID="pair-manual-toggle"
          >
            <Text style={styles.disclosureText}>
              {showManual ? 'Hide manual entry' : 'Enter code manually'}
            </Text>
            {showManual ? (
              <ChevronUp size={18} color={colors.muted} />
            ) : (
              <ChevronDown size={18} color={colors.muted} />
            )}
          </Pressable>

          {showManual ? (
            <View style={styles.manualBox} testID="pair-manual-form">
              <Text style={styles.hint}>
                Only if the camera cannot read the QR. Prefer Scan QR — it fills Hub address + code.
              </Text>
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
                Example: {HUB_URL_HINTS.ipv4} · {HUB_URL_HINTS.magicDns}
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

              <Pressable
                style={({ pressed }) => [
                  styles.button,
                  busy && styles.buttonDisabled,
                  pressed && !busy && styles.pressed,
                ]}
                onPress={onPair}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Pair with Hub"
                testID="pair-submit"
              >
                {busy ? (
                  <ActivityIndicator color={colors.accentText} />
                ) : (
                  <Text style={styles.buttonText}>Pair with Hub</Text>
                )}
              </Pressable>

              <Pressable
                onPress={onCheckHealth}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Check Hub health without pairing"
                style={({ pressed }) => [pressed && styles.pressed]}
              >
                <Text style={styles.link}>Check Hub health without pairing</Text>
              </Pressable>
            </View>
          ) : null}
        </CalmEnter>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  scanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    minHeight: 56,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    marginTop: spacing.sm,
  },
  scanText: { color: colors.accentText, fontSize: type.body, fontWeight: weight.semibold },
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
    flexGrow: 1,
  },
  title: {
    color: colors.text,
    fontSize: type.title,
    fontWeight: weight.semibold,
    marginBottom: spacing.xs,
  },
  body: {
    color: colors.muted,
    fontSize: type.body,
    lineHeight: lineHeight.sub,
    marginBottom: spacing.sm,
  },
  bodyTight: {
    color: colors.muted,
    fontSize: type.meta,
    lineHeight: lineHeight.body,
  },
  status: {
    color: colors.accent,
    fontSize: type.meta,
    textAlign: 'center',
    marginTop: spacing.xs,
  },
  disclosure: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    marginTop: spacing.sm,
    paddingVertical: spacing.xs,
  },
  disclosureText: {
    color: colors.text,
    fontSize: type.body,
    fontWeight: weight.semibold,
  },
  manualBox: {
    gap: spacing.sm,
    paddingBottom: spacing.md,
  },
  guideBox: {
    padding: spacing.md,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: spacing.xs,
  },
  guideSteps: {
    color: colors.text,
    fontSize: type.meta,
    lineHeight: lineHeight.body,
  },
  label: {
    color: colors.muted,
    fontSize: type.meta,
    marginTop: spacing.xs,
  },
  hint: {
    color: colors.muted,
    fontSize: type.meta,
    lineHeight: lineHeight.meta,
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: type.body,
    minHeight: 44,
  },
  button: {
    marginTop: spacing.md,
    backgroundColor: colors.accent,
    borderRadius: radii.sm,
    paddingVertical: spacing.md,
    alignItems: 'center',
    minHeight: 48,
    justifyContent: 'center',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: colors.accentText,
    fontWeight: weight.semibold,
    fontSize: type.body,
  },
  link: {
    color: colors.muted,
    textAlign: 'center',
    marginTop: spacing.sm,
    textDecorationLine: 'underline',
    fontSize: type.meta,
    minHeight: 44,
    paddingVertical: spacing.sm,
  },
  error: {
    color: colors.danger,
    marginTop: spacing.sm,
    fontSize: type.meta,
    lineHeight: lineHeight.body,
  },
  pressed: {
    opacity: 0.85,
  },
});
