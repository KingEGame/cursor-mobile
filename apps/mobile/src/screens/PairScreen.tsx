import { ArrowLeft, Check, ChevronDown, ChevronUp, Monitor, QrCode } from 'lucide-react-native';
import { QrScanner } from '../components/QrScanner';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Constants from 'expo-constants';
import { CommonActions, useFocusEffect, useRoute, type RouteProp } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createHubClient } from '../hub/client';
import { PC_PAIR_URL, isLoopbackHost, loopbackQrText, pairErrorText } from '../hub/pair-errors';
import {
  TAILSCALE_SETUP_INTRO,
  TAILSCALE_SETUP_TITLE,
  formatTailscaleSetupSteps,
} from '../hub/tailscale-guide';
import { HUB_URL_HINTS, normalizeHubBaseUrl, resolvePairedHubBaseUrl } from '../storage/hub-url';
import { switchFailureText, switchToHub } from '../storage/hub-switch';
import { loadKnownHubs, type KnownHub } from '../storage/known-hubs';
import { saveHubBaseUrl, savePairingSuccess } from '../storage/pairing';
import { CalmEnter } from '../motion/calmEnter';
import { colors, radii, spacing, type, weight, lineHeight } from '../theme';
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

interface QrTarget {
  /** Hub base URL the phone should dial; empty when the QR gave nothing usable. */
  url: string;
  /** True when the QR pointed at 127.0.0.1 (the PC found no Tailscale address). */
  loopback: boolean;
}

/**
 * Hub URL from QR / deep-link params. A loopback host is reported, never silently replaced
 * with the previously paired PC: that is how a code from one PC ended up at another Hub.
 */
function hubUrlFromPairParams(params: PairDeepLinkParams | RootStackParamList['Pair'] | undefined): QrTarget {
  if (params?.hubUrl?.trim()) {
    const url = normalizeHubBaseUrl(params.hubUrl);
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      host = '';
    }
    return isLoopbackHost(host) ? { url: '', loopback: true } : { url, loopback: false };
  }
  if (params?.host?.trim()) {
    const host = params.host.trim();
    if (isLoopbackHost(host)) return { url: '', loopback: true };
    const port = (params.port || '8787').trim();
    return { url: normalizeHubBaseUrl(`http://${host}:${port}`), loopback: false };
  }
  return { url: '', loopback: false };
}

/** Type a PC address with or without the scheme / port; the Hub always listens on 8787. */
function addressToHubUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  const withScheme = /^https?:\/\//i.test(t) ? t : `http://${t}`;
  try {
    const u = new URL(withScheme);
    if (!u.port) u.port = '8787';
    return normalizeHubBaseUrl(u.origin);
  } catch {
    return normalizeHubBaseUrl(withScheme);
  }
}

export function PairScreen({ navigation }: Props) {
  const session = useAppSession();
  const { refreshFromStorage } = session;
  const insets = useSafeAreaInsets();
  const route = useRoute<RouteProp<RootStackParamList, 'Pair'>>();
  const params = route.params;
  const [hubUrl, setHubUrl] = useState(() => hubUrlFromPairParams(params).url);
  const [code, setCode] = useState(() => params?.code?.trim() ?? '');
  const [pairId, setPairId] = useState(() => params?.pairId?.trim() ?? '');
  const [pcName, setPcName] = useState(() => params?.name?.trim() ?? '');
  const [deviceName, setDeviceName] = useState('Android phone');
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('Pairing with PC…');
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [showTailscale, setShowTailscale] = useState(false);
  const [knownHubs, setKnownHubs] = useState<KnownHub[]>([]);
  const autoStarted = useRef(false);
  const hubUrlRef = useRef(hubUrl);
  hubUrlRef.current = hubUrl;
  const canGoBack = navigation.canGoBack();

  // Saved PCs: a phone sent here by a 401 from one PC can still pick another one.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void loadKnownHubs().then((list) => {
        if (!cancelled) setKnownHubs(list);
      });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const finishPaired = useCallback(() => {
    navigation.dispatch(CommonActions.reset({ index: 0, routes: [{ name: 'Health' }] }));
  }, [navigation]);

  const pairWith = useCallback(
    async (input: { hubUrl: string; code: string; pairId?: string; deviceName?: string; pcName?: string; loopback?: boolean }) => {
      setError(null);
      const base = normalizeHubBaseUrl(input.hubUrl);
      const pairCode = input.code.trim();
      const pc = input.pcName?.trim() || null;
      if (!base) {
        setError(
          input.loopback
            ? loopbackQrText(pc)
            : `The QR did not include the PC's address. On the PC open ${PC_PAIR_URL} and scan that QR, or type the PC address shown there under Enter code manually.`,
        );
        if (!input.loopback) setShowManual(true);
        return false;
      }
      if (!pairCode) {
        setError('No pair code — scan the QR on the PC pair page.');
        return false;
      }

      setBusy(true);
      setBusyLabel(`Pairing with ${pc || 'PC'}…`);
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
          hubDisplayName: result.hub.displayName || pc || 'PC',
          hubId: result.hub.hubId ?? null,
        });

        await refreshFromStorage();
        finishPaired();
        return true;
      } catch (err) {
        setError(pairErrorText(err, pc));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [deviceName, finishPaired, refreshFromStorage],
  );

  const applyPairParams = useCallback(
    (incoming: PairDeepLinkParams | null | undefined): { hub: string; code: string; pairId: string; name: string; loopback: boolean } => {
      if (!incoming) return { hub: '', code: '', pairId: '', name: '', loopback: false };
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
      const name = incoming.name?.trim() || incoming.hubDisplayName?.trim() || '';
      if (name) setPcName(name);
      const target = hubUrlFromPairParams(incoming);
      if (target.url) setHubUrl(target.url);

      // PC already completed pair (operator shortcut) — save token and leave Pair (no form).
      if (isPairTokenInject(incoming) && !autoStarted.current) {
        const token = incoming.deviceToken!.trim();
        const deviceId = incoming.deviceId!.trim();
        const base = target.url || normalizeHubBaseUrl(hubUrlRef.current);
        if (base) {
          autoStarted.current = true;
          void (async () => {
            try {
              setBusy(true);
              setBusyLabel(`Connecting to ${name || 'PC'}…`);
              await savePairingSuccess({
                hubBaseUrl: base,
                deviceToken: token,
                deviceId,
                hubDisplayName: name || 'PC',
                hubId: incoming.hub?.trim() || null,
              });
              await refreshFromStorage();
              finishPaired();
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
        hub: target.url,
        code: nextCode || incoming.code?.trim() || '',
        pairId: nextPairId || incoming.pairId?.trim() || '',
        name,
        loopback: target.loopback,
      };
    },
    [finishPaired, refreshFromStorage],
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
    await pairWith({ hubUrl: addressToHubUrl(hubUrl), code, pairId, deviceName, pcName });
  }, [pairWith, hubUrl, code, pairId, deviceName, pcName]);

  // Deep link with a code (cursor-companion://pair?host=&code=) → auto pair once.
  useEffect(() => {
    if (autoStarted.current) return;
    const autoFlag = (params?.auto ?? '1').trim().toLowerCase();
    if (autoFlag === '0' || autoFlag === 'false' || autoFlag === 'no') return;
    if (isPairTokenInject(params)) return; // handled by applyPairParams
    const pairCode = params?.code?.trim();
    if (!pairCode) return;
    const target = hubUrlFromPairParams(params);
    autoStarted.current = true;
    void pairWith({
      hubUrl: target.url,
      loopback: target.loopback,
      code: pairCode,
      pairId: params?.pairId,
      deviceName,
      pcName: params?.name,
    }).then((ok) => {
      if (!ok) autoStarted.current = false;
    });
  }, [params, deviceName, pairWith]);

  const onScanQr = useCallback(
    (data: string) => {
      setScanning(false);
      const parsed = parsePairDeepLink(data);
      if (!parsed?.code) {
        setError(`That QR is not a Cursor Mobile pairing code. On the PC open ${PC_PAIR_URL}.`);
        return;
      }
      const filled = applyPairParams(parsed);
      autoStarted.current = true;
      void pairWith({
        hubUrl: filled.hub,
        loopback: filled.loopback,
        code: filled.code || parsed.code,
        pairId: filled.pairId || parsed.pairId,
        deviceName,
        pcName: filled.name,
      }).then((ok) => {
        if (!ok) autoStarted.current = false;
      });
    },
    [applyPairParams, deviceName, pairWith],
  );

  const onUseSaved = useCallback(
    async (hub: KnownHub) => {
      setError(null);
      setBusy(true);
      setBusyLabel(`Connecting to ${hub.hubDisplayName || 'PC'}…`);
      try {
        const reach = await switchToHub(hub);
        if (reach !== 'ok') {
          setError(switchFailureText(hub, reach));
          return;
        }
        await refreshFromStorage();
        navigation.dispatch(CommonActions.reset({ index: 0, routes: [{ name: 'Main' }] }));
      } finally {
        setBusy(false);
      }
    },
    [navigation, refreshFromStorage],
  );

  const onCheckHealth = useCallback(async () => {
    setError(null);
    const base = addressToHubUrl(hubUrl);
    if (!base) {
      setError(`Type the PC address shown on the pair page first. Example: ${HUB_URL_HINTS.ipv4}`);
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

  const activeUrl = normalizeHubBaseUrl(session.hubBaseUrl);

  return (
    <KeyboardAvoidingView style={styles.root} behavior="padding" keyboardVerticalOffset={insets.top}>
      <ScrollView
        style={styles.root}
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + spacing.sm, paddingBottom: insets.bottom + spacing.xl },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator
        testID="pair-scroll"
      >
        <CalmEnter>
          <View style={styles.topBar}>
            {canGoBack ? (
              <Pressable
                onPress={() => navigation.goBack()}
                style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel="Back"
                hitSlop={8}
                testID="pair-back"
              >
                <ArrowLeft size={22} color={colors.text} strokeWidth={2} />
              </Pressable>
            ) : null}
            <Text style={styles.title}>{knownHubs.length ? 'Add a PC' : 'Pair with your PC'}</Text>
          </View>

          <View style={styles.steps} accessibilityLabel="Pairing steps">
            <Step n={1} text={`On the PC, open ${PC_PAIR_URL} in a browser. It shows a QR for that PC.`} />
            <Step n={2} text="Here, tap Scan QR and aim at the screen. The PC's address and code come from the QR — nothing to type." />
            <Step n={3} text="Chats from that PC appear here. Pair each PC once; switch between them in Settings → Computer." />
          </View>

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
              {busyLabel}
            </Text>
          ) : null}

          {error ? (
            <Text style={styles.error} accessibilityLiveRegion="assertive" testID="pair-error">
              {error}
            </Text>
          ) : null}

          <QrScanner visible={scanning} onClose={() => setScanning(false)} onScan={onScanQr} />

          {knownHubs.length ? (
            <View style={styles.card} testID="pair-saved-pcs">
              <Text style={styles.cardTitle}>Saved computers</Text>
              <Text style={styles.hint}>Already paired — tap one to use it without scanning again.</Text>
              {knownHubs.map((hub) => {
                const active = normalizeHubBaseUrl(hub.hubBaseUrl) === activeUrl && !!session.deviceToken;
                return (
                  <Pressable
                    key={hub.hubBaseUrl}
                    style={({ pressed }) => [styles.pcRow, pressed && styles.rowPressed]}
                    onPress={() => void onUseSaved(hub)}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={`Use ${hub.hubDisplayName || 'PC'}`}
                  >
                    <Monitor size={20} color={active ? colors.accent : colors.muted} strokeWidth={1.75} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.rowTitle, active && { color: colors.accent }]}>{hub.hubDisplayName || 'PC'}</Text>
                      <Text style={styles.hint}>{hub.hubBaseUrl}{active ? ' · current' : ''}</Text>
                    </View>
                    {active ? <Check size={18} color={colors.accent} /> : null}
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          <Pressable
            style={({ pressed }) => [styles.disclosure, pressed && styles.pressed]}
            onPress={() => setShowTailscale((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ expanded: showTailscale }}
            accessibilityLabel="Tailscale setup"
          >
            <Text style={styles.disclosureText}>{TAILSCALE_SETUP_TITLE}</Text>
            {showTailscale ? <ChevronUp size={18} color={colors.muted} /> : <ChevronDown size={18} color={colors.muted} />}
          </Pressable>
          {showTailscale ? (
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
            <Text style={styles.disclosureText}>{showManual ? 'Hide manual entry' : 'Enter code manually'}</Text>
            {showManual ? <ChevronUp size={18} color={colors.muted} /> : <ChevronDown size={18} color={colors.muted} />}
          </Pressable>

          {showManual ? (
            <View style={styles.manualBox} testID="pair-manual-form">
              <Text style={styles.hint}>
                Only if the camera cannot read the QR. The PC pair page shows both values under "Type it on the phone instead" — they belong to that PC only.
              </Text>
              <Text style={styles.label}>PC address (from that PC's pair page)</Text>
              <TextInput
                style={styles.input}
                value={hubUrl}
                onChangeText={setHubUrl}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="100.x.y.z:8787"
                placeholderTextColor={colors.muted}
                accessibilityLabel="PC address"
                testID="pair-hub-url"
              />
              {knownHubs.length ? (
                <View style={styles.chips}>
                  {knownHubs.map((hub) => (
                    <Pressable
                      key={`chip-${hub.hubBaseUrl}`}
                      onPress={() => {
                        setHubUrl(hub.hubBaseUrl);
                        setPcName(hub.hubDisplayName || '');
                      }}
                      style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
                      accessibilityRole="button"
                      accessibilityLabel={`Use the address of ${hub.hubDisplayName || 'PC'}`}
                    >
                      <Text style={styles.chipText}>{hub.hubDisplayName || hub.hubBaseUrl}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
              <Text style={styles.hint}>Example: {HUB_URL_HINTS.ipv4}</Text>

              <Text style={styles.label}>Code (6 digits)</Text>
              <TextInput
                style={styles.input}
                value={code}
                onChangeText={setCode}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="number-pad"
                maxLength={6}
                placeholder="482913"
                placeholderTextColor={colors.muted}
                accessibilityLabel="Pair code"
                testID="pair-code"
              />

              <Text style={styles.label}>This phone's name on the PC</Text>
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
                style={({ pressed }) => [styles.button, busy && styles.buttonDisabled, pressed && !busy && styles.pressed]}
                onPress={onPair}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Pair with this PC"
                testID="pair-submit"
              >
                {busy ? <ActivityIndicator color={colors.accentText} /> : <Text style={styles.buttonText}>Pair with this PC</Text>}
              </Pressable>

              <Pressable
                onPress={onCheckHealth}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Check the PC is reachable without pairing"
                style={({ pressed }) => [pressed && styles.pressed]}
              >
                <Text style={styles.link}>Check the PC is reachable without pairing</Text>
              </Pressable>
            </View>
          ) : null}
        </CalmEnter>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Step(props: { n: number; text: string }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepBadge}>
        <Text style={styles.stepNum}>{props.n}</Text>
      </View>
      <Text style={styles.stepText}>{props.text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: spacing.md, gap: spacing.sm, flexGrow: 1 },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: 44 },
  backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginLeft: -spacing.xs },
  title: { color: colors.text, fontSize: type.title, fontWeight: weight.semibold, letterSpacing: -0.4, flex: 1 },
  steps: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  step: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  stepBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  stepNum: { color: colors.accent, fontSize: type.meta, fontWeight: weight.semibold },
  stepText: { flex: 1, color: colors.text, fontSize: type.body, lineHeight: lineHeight.body },
  scanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    minHeight: 56,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    marginTop: spacing.xs,
  },
  scanText: { color: colors.accentText, fontSize: type.body, fontWeight: weight.semibold },
  status: { color: colors.accent, fontSize: type.meta, textAlign: 'center', marginTop: spacing.xxs },
  error: {
    color: colors.dangerText,
    backgroundColor: colors.dangerSoft,
    borderRadius: radii.sm,
    padding: spacing.sm,
    marginTop: spacing.xs,
    fontSize: type.meta,
    lineHeight: lineHeight.body,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xxs,
    marginTop: spacing.xs,
  },
  cardTitle: { color: colors.text, fontSize: type.body, fontWeight: weight.semibold },
  pcRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 52, borderRadius: radii.sm, paddingHorizontal: spacing.xxs },
  rowPressed: { backgroundColor: colors.surfaceMuted },
  rowTitle: { color: colors.text, fontSize: type.body },
  bodyTight: { color: colors.muted, fontSize: type.meta, lineHeight: lineHeight.body },
  disclosure: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    marginTop: spacing.xs,
    paddingVertical: spacing.xs,
  },
  disclosureText: { color: colors.text, fontSize: type.body, fontWeight: weight.semibold },
  manualBox: { gap: spacing.sm, paddingBottom: spacing.md },
  guideBox: {
    padding: spacing.md,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: spacing.xs,
  },
  guideSteps: { color: colors.text, fontSize: type.meta, lineHeight: lineHeight.body },
  label: { color: colors.muted, fontSize: type.meta, marginTop: spacing.xxs },
  hint: { color: colors.muted, fontSize: type.meta, lineHeight: lineHeight.meta },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: type.body,
    minHeight: 48,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: {
    paddingHorizontal: spacing.sm,
    minHeight: 36,
    justifyContent: 'center',
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceMuted,
  },
  chipText: { color: colors.text, fontSize: type.meta, fontWeight: weight.semibold },
  button: {
    marginTop: spacing.xs,
    backgroundColor: colors.accent,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    minHeight: 48,
    justifyContent: 'center',
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: colors.accentText, fontWeight: weight.semibold, fontSize: type.body },
  link: {
    color: colors.muted,
    textAlign: 'center',
    marginTop: spacing.xs,
    textDecorationLine: 'underline',
    fontSize: type.meta,
    minHeight: 44,
    paddingVertical: spacing.sm,
  },
  pressed: { opacity: 0.85 },
});
