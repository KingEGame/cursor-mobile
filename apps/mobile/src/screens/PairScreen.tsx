import React, { useEffect, useState } from 'react';
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
import { QrCode } from 'lucide-react-native';
import { QrScanner } from '../components/QrScanner';
import { appVersion, useBridge } from '../bridge/BridgeProvider';
import { BridgeClient, normalizeBaseUrl } from '../bridge/client';
import { describeError, parsePairPayload } from '../bridge/errors';
import { DEFAULT_BRIDGE_PORT } from '../bridge/types';
import type { ScreenProps } from '../navigation/types';
import { colors, radii, spacing, type, weight } from '../theme';

export function PairScreen({ navigation, route }: ScreenProps<'Pair'>) {
  const bridge = useBridge();
  const [url, setUrl] = useState(route.params?.hubUrl ?? bridge.pairing.baseUrl);
  const [code, setCode] = useState(route.params?.code ?? '');
  const [pairId, setPairId] = useState<string | undefined>(route.params?.pairId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

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
        deviceName: `${Platform.OS === 'android' ? 'Android' : 'iPhone'} phone`,
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
