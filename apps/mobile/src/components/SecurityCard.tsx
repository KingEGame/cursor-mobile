import React, { useEffect, useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { loadLockSettings, readDeviceAuth, saveLockSettings, unlock } from '../security/app-lock';
import { DEFAULT_LOCK_SETTINGS, type LockSettings } from '../security/lock-policy';
import { colors, radii, spacing, type, weight, lineHeight } from '../theme';

/** Settings → Security: fingerprint / PIN before the app opens. */
export function SecurityCard() {
  const [settings, setSettings] = useState<LockSettings>(DEFAULT_LOCK_SETTINGS);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    void loadLockSettings().then(setSettings);
    void readDeviceAuth().then((d) => setAvailable(d.enrolled));
  }, []);

  const change = async (key: keyof LockSettings, value: boolean) => {
    // Turning a lock *off* needs the current owner to unlock first.
    if (!value && !(await unlock(true, 'Unlock to change security settings'))) return;
    const next = { ...settings, [key]: value };
    setSettings(next);
    await saveLockSettings(next);
  };

  return (
    <View style={styles.card} testID="account-security">
      {/* Hermes has no phone-side tool approvals, so the old "unlock to approve" switch is gone. */}
      <Row
        title="Lock app on open"
        meta="Ask again after 5 minutes in the background"
        value={settings.lockOpen}
        onChange={(v) => void change('lockOpen', v)}
      />
      {!available ? (
        <Text style={styles.warn}>
          No fingerprint or screen lock is set up on this phone, so these locks cannot ask for
          anything yet. Set one up in Android settings.
        </Text>
      ) : null}
    </View>
  );
}

function Row(props: { title: string; meta: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowBody}>
        <Text style={styles.title}>{props.title}</Text>
        <Text style={styles.meta}>{props.meta}</Text>
      </View>
      <Switch
        value={props.value}
        onValueChange={props.onChange}
        trackColor={{ true: colors.accent, false: colors.border }}
        accessibilityLabel={props.title}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  label: { color: colors.muted, fontSize: type.meta, fontWeight: weight.semibold, textTransform: 'uppercase' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 48 },
  rowBody: { flex: 1 },
  title: { color: colors.text, fontSize: type.body },
  meta: { color: colors.muted, fontSize: type.meta, marginTop: spacing.xxs },
  warn: { color: colors.warn, fontSize: type.meta, lineHeight: lineHeight.meta },
});
