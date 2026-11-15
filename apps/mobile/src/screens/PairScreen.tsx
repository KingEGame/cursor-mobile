import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Monitor, QrCode, RefreshCw } from 'lucide-react-native';
import { scanLan, type FoundPc } from '../bridge/discovery';
import { QrScanner } from '../components/QrScanner';
import { appVersion, useBridge } from '../bridge/BridgeProvider';
import { BridgeClient, normalizeBaseUrl } from '../bridge/client';
import { describeError, parsePairPayload } from '../bridge/errors';
import { DEFAULT_BRIDGE_PORT } from '../bridge/types';
import type { ScreenProps } from '../navigation/types';
import { colors, radii, spacing, type, weight } from '../theme';

function deviceName(): string {
  const c = Platform.constants as { Model?: string; Brand?: string };
  const model = c.Model?.trim();
  return model ? model : Platform.OS === 'android' ? 'Android phone' : 'iPhone';
}

type Scan = 'idle' | 'scanning' | 'done' | 'nowifi';

export function PairScreen({ navigation, route }: ScreenProps<'Pair'>) {
  const bridge = useBridge();
  const [url, setUrl] = useState(route.params?.hubUrl ?? bridge.pairing.baseUrl);
  const [code, setCode] = useState(route.params?.code ?? '');
  const [pairId, setPairId] = useState<string | undefined>(route.params?.pairId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<Scan>('idle');
  const [found, setFound] = useState<FoundPc[]>([]);
  const [asking, setAsking] = useState<{ pc: FoundPc; confirm: string } | null>(null);
  const cancelAsk = useRef(false);

  const findPcs = async () => {
    setScan('scanning');
    setFound([]);
    setError(null);
    const { phoneIp, found: all } = await scanLan({
      onFound: (pc) => setFound((cur) => (cur.some((x) => x.hubId === pc.hubId) ? cur : [...cur, pc])),
    });
    setFound(all);
    setScan(phoneIp ? 'done' : 'nowifi');
  };

  // One tap: the phone asks, the owner taps Allow on the PC; no codes to type.
  const askPc = async (pc: FoundPc) => {
    setError(null);
    cancelAsk.current = false;
    try {
      const c0 = new BridgeClient({ baseUrl: pc.url });
      const req = await c0.pairRequest({ deviceName: deviceName(), platform: Platform.OS, appVersion: appVersion() });
      setAsking({ pc, confirm: req.confirm });
      const deadline = Date.parse(req.expiresAt) || Date.now() + 120_000;
      while (!cancelAsk.current && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1200));
        const st = await c0.pairRequestStatus(req.requestId).catch(() => null);
        if (!st || st.status === 'pending') continue;
        if (st.status === 'approved') {
          await bridge.completePairing(pc.url, st);
          navigation.reset({ index: 0, routes: [{ name: 'Sessions' }] });
          return;
        }
        setError(st.status === 'denied' ? `${pc.name} declined this phone.` : 'The request expired — try again.');
        break;
      }
      if (!cancelAsk.current && Date.now() >= deadline) setError('No answer on the PC in 2 minutes — try again.');
    } catch (err) {
      setError(describeError(err, pc.name));
    } finally {
      setAsking(null);
    }
  };

  useEffect(() => {
    void findPcs(); // even when opened from a (possibly stale) pairing link
    return () => {
      cancelAsk.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (u = url, c = code, pid = pairId) => {
    const baseUrl = normalizeBaseUrl(u);
    const digits = c.replace(/\D/g, '');
    if (!baseUrl) return setError(`Enter the PC address, e.g. http://100.x.y.z:${DEFAULT_BRIDGE_PORT}`);
    if (digits.length !== 8) return setError('The code has 8 digits — it is shown on the PC pair page.');
    setBusy(true);
    setError(null);
    try {
      const c0 = new BridgeClient({ baseUrl });
      await c0.health(); // proves it's a Hermes bridge before spending the code
      const res = await c0.pairComplete({
        code: digits,
        pairId: pid,
        deviceName: deviceName(),
        platform: Platform.OS,
        appVersion: appVersion(),
      });
      await bridge.completePairing(baseUrl, res);
      navigation.reset({ index: 0, routes: [{ name: 'Sessions' }] });
    } catch (err) {
      setError(describeError(err, route.params?.name));
    } finally {
      setBusy(false);
    }
  };

  // QR / deep link with everything filled → pair straight away.
  useEffect(() => {
    const p = route.params;
    if (p?.hubUrl && p.code) {
      setUrl(p.hubUrl);
      setCode(p.code);
      setPairId(p.pairId);
      void submit(p.hubUrl, p.code, p.pairId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.params?.code]);

  const onScan = (data: string) => {
    setScanning(false);
    const p = parsePairPayload(data);
    if (!p) return setError('That QR code is not a Hermes pairing code.');
    const u = p.hubUrl ?? url;
    if (p.hubUrl) setUrl(p.hubUrl);
    if (p.code) setCode(p.code);
    setPairId(p.pairId);
    if (u && p.code) void submit(u, p.code, p.pairId);
  };

  return (
    <SafeAreaView style={styles.root}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>Connect to Hermes</Text>
          <Text style={styles.lead}>
            The phone talks to the Hermes Gateway on your PC. Every chat lives in the PC's history, so you can
            continue it from the terminal or the desktop app and see it here.
          </Text>

          {asking ? (
            <View style={styles.askCard}>
              <Text style={styles.askTitle}>Allow this phone on {asking.pc.name}</Text>
              <Text style={styles.stepText}>
                A request popped up on the PC (or open http://127.0.0.1:{DEFAULT_BRIDGE_PORT}/pair there). Check that it
                shows the same code and tap Allow:
              </Text>
              <Text style={styles.confirm} testID="pair-confirm">
                {asking.confirm}
              </Text>
              <ActivityIndicator color={colors.accent} />
              <Pressable style={styles.secondary} onPress={() => (cancelAsk.current = true)}>
                <Text style={styles.secondaryText}>Cancel</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.findCard}>
              <View style={styles.findHead}>
                <Text style={styles.askTitle}>On this Wi-Fi</Text>
                <Pressable onPress={() => void findPcs()} disabled={scan === 'scanning'} hitSlop={10} testID="pair-scan">
                  {scan === 'scanning' ? (
                    <ActivityIndicator color={colors.accent} />
                  ) : (
                    <RefreshCw size={18} color={colors.accent} />
                  )}
                </Pressable>
              </View>
              {found.map((pc) => (
                <Pressable key={pc.hubId} style={styles.pcRow} onPress={() => void askPc(pc)} testID={`pair-pc-${pc.hubId}`}>
                  <Monitor size={20} color={colors.text} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.pcName}>{pc.name}</Text>
                    <Text style={styles.pcUrl}>{pc.url}</Text>
                  </View>
                  <Text style={styles.secondaryText}>Connect</Text>
                </Pressable>
              ))}
              <Text style={styles.hint}>
                {scan === 'scanning' || scan === 'idle'
                  ? 'Looking for Hermes on your network…'
                  : scan === 'nowifi'
                    ? 'Not on Wi-Fi. Use the code below (works over Tailscale too).'
                    : found.length
                      ? 'Tap your PC, then Allow on the PC.'
                      : 'No PC found. Is the Gateway running with the phone bridge? Or use the code below.'}
              </Text>
            </View>
          )}

          <Text style={styles.divider}>or with a code</Text>

          <View style={styles.step}>
            <Text style={styles.stepNo}>1</Text>
            <Text style={styles.stepText}>
              On the PC open <Text style={styles.mono}>http://127.0.0.1:{DEFAULT_BRIDGE_PORT}/pair</Text>
            </Text>
          </View>
          <View style={styles.step}>
            <Text style={styles.stepNo}>2</Text>
            <Text style={styles.stepText}>Enter the address and the 8-digit code shown there.</Text>
          </View>

          <Text style={styles.label}>PC address</Text>
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            placeholder={`http://100.x.y.z:${DEFAULT_BRIDGE_PORT}`}
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            testID="pair-url"
          />

          <Text style={styles.label}>Code</Text>
          <TextInput
            style={[styles.input, styles.code]}
            value={code}
            onChangeText={(t) => setCode(t.replace(/[^\d ]/g, ''))}
            placeholder="1234 5678"
            placeholderTextColor={colors.muted}
            keyboardType="number-pad"
            maxLength={9}
            testID="pair-code"
          />

          {error ? (
            <Text style={styles.error} testID="pair-error">
              {error}
            </Text>
          ) : null}

          <Pressable
            style={[styles.primary, busy && { opacity: 0.6 }]}
            onPress={() => void submit()}
            disabled={busy}
            testID="pair-submit"
          >
            {busy ? <ActivityIndicator color={colors.onDark} /> : <Text style={styles.primaryText}>Pair</Text>}
          </Pressable>

          <Pressable style={styles.secondary} onPress={() => setScanning(true)}>
            <QrCode size={18} color={colors.accent} />
            <Text style={styles.secondaryText}>Scan QR instead</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
      <QrScanner visible={scanning} onScan={onScan} onClose={() => setScanning(false)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { padding: spacing.lg, gap: spacing.sm },
  title: { fontSize: type.title, fontWeight: weight.semibold, color: colors.text, marginTop: spacing.lg },
  lead: { fontSize: type.body, color: colors.muted, lineHeight: 22, marginBottom: spacing.md },
  step: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  stepNo: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
    textAlign: 'center',
    lineHeight: 22,
    fontWeight: weight.semibold,
    fontSize: type.meta,
  },
  findCard: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md, gap: spacing.sm },
  findHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  askCard: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.accentBorder,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
    alignItems: 'center',
  },
  askTitle: { fontSize: type.sub, fontWeight: weight.semibold, color: colors.text },
  confirm: { fontSize: 40, fontWeight: weight.semibold, letterSpacing: 8, color: colors.accent },
  pcRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceMuted,
  },
  pcName: { fontSize: type.body, fontWeight: weight.semibold, color: colors.text },
  pcUrl: { fontSize: type.meta, color: colors.muted },
  hint: { fontSize: type.meta, color: colors.muted, lineHeight: 18 },
  divider: { textAlign: 'center', color: colors.muted, fontSize: type.meta, marginVertical: spacing.md },
  stepText: { flex: 1, fontSize: type.body, color: colors.text, lineHeight: 22 },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: type.meta },
  label: { fontSize: type.meta, color: colors.muted, marginTop: spacing.md, fontWeight: weight.semibold },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: type.body,
    color: colors.text,
  },
  code: { fontSize: type.sub, letterSpacing: 4 },
  error: {
    color: colors.dangerText,
    backgroundColor: colors.dangerSoft,
    padding: spacing.sm,
    borderRadius: radii.sm,
    fontSize: type.meta,
    lineHeight: 18,
    marginTop: spacing.sm,
  },
  primary: {
    marginTop: spacing.lg,
    backgroundColor: colors.accent,
    borderRadius: radii.pill,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { color: colors.onDark, fontSize: type.body, fontWeight: weight.semibold },
  secondary: {
    flexDirection: 'row',
    gap: spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  secondaryText: { color: colors.accent, fontSize: type.body, fontWeight: weight.semibold },
});
