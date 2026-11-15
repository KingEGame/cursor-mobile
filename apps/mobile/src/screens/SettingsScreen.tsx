import React, { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SecurityCard } from '../components/SecurityCard';
import { appVersion, useBridge } from '../bridge/BridgeProvider';
import type { ScreenProps } from '../navigation/types';
import { colors, radii, spacing, type, weight } from '../theme';

function uptime(sec: number): string {
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h`;
  return `${Math.round(sec / 86400)} d`;
}

export function SettingsScreen({ navigation }: ScreenProps<'Settings'>) {
  const bridge = useBridge();
  const [checking, setChecking] = useState(false);
  const h = bridge.health;

  const check = async () => {
    setChecking(true);
    await bridge.reresolve();
    await bridge.refreshHealth();
    setChecking(false);
  };
  useEffect(() => {
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const unpair = () =>
    Alert.alert('Disconnect this phone?', 'You will need a new code from the PC to connect again.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: async () => {
          await bridge.unpair();
          navigation.reset({ index: 0, routes: [{ name: 'Pair' }] });
        },
      },
    ]);

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.body}>
      <Text style={styles.section}>Computer</Text>
      <View style={styles.card}>
        <Row label="Name" value={bridge.pairing.pcName ?? '—'} />
        <Row
          label="Using"
          value={bridge.activeUrl ? `${bridge.activeUrl} · ${bridge.activeKind === 'lan' ? 'Wi-Fi' : bridge.activeKind === 'tailscale' ? 'Tailscale' : 'name'}` : '—'}
          mono
        />
        <Row label="Known addresses" value={bridge.pairing.addresses.join('\n') || '—'} mono />
        <Row label="Connection" value={bridge.connection} />
        <Row label="Gateway" value={h ? `up ${uptime(h.hub.uptimeSec)} · API v${h.apiVersion}` : checking ? 'checking…' : 'unreachable'} />
        {h ? <Row label="Paired phones" value={String(h.pairing.devicesPaired)} /> : null}
        {h ? <Row label="Live clients" value={String(h.clients)} /> : null}
        {bridge.lastError ? <Text style={styles.error}>{bridge.lastError}</Text> : null}
        <Pressable style={styles.button} onPress={() => void check()}>
          <Text style={styles.buttonText}>{checking ? 'Checking…' : 'Check connection'}</Text>
        </Pressable>
      </View>

      <Text style={styles.section}>Security</Text>
      <SecurityCard />

      <Text style={styles.section}>Device</Text>
      <View style={styles.card}>
        <Row label="App version" value={appVersion()} />
        <Row label="Device id" value={bridge.pairing.deviceId ?? '—'} mono />
        <Pressable style={[styles.button, styles.danger]} onPress={unpair} testID="unpair">
          <Text style={[styles.buttonText, { color: colors.danger }]}>Disconnect from this PC</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={() => navigation.navigate('Pair')}>
          <Text style={styles.buttonText}>Pair with another PC</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text selectable style={[styles.rowValue, mono && styles.mono]} numberOfLines={4}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { padding: spacing.md, gap: spacing.xs, paddingBottom: spacing.xxl },
  section: {
    fontSize: type.section,
    color: colors.muted,
    fontWeight: weight.semibold,
    marginTop: spacing.md,
    textTransform: 'uppercase',
  },
  card: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md, gap: spacing.sm },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  rowLabel: { fontSize: type.body, color: colors.muted },
  rowValue: { flexShrink: 1, fontSize: type.body, color: colors.text, textAlign: 'right' },
  mono: { fontFamily: 'monospace', fontSize: type.meta },
  error: { color: colors.dangerText, fontSize: type.meta, lineHeight: 18 },
  button: {
    minHeight: 44,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  danger: { borderColor: colors.dangerSoft },
  buttonText: { fontSize: type.body, color: colors.accent, fontWeight: weight.semibold },
});
