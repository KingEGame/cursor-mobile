import React, { useEffect, useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { loadNotifyEnabled, saveNotifyEnabled, syncPcWatch } from '../notifications/pc-watch';
import { useAppSession } from '../session/AppSessionContext';
import { colors, radii, spacing } from '../theme';

const STATUS_COPY: Record<string, string> = {
  running: 'Watching — an ongoing notification shows while this is on.',
  off: 'Off — you will not be notified while the app is closed.',
  'no-permission': 'Notifications are blocked for this app — allow them in Android settings.',
  unsupported: 'Not available in this build.',
};

/** Account → Notifications: background watcher for agent chats on the paired PC. */
export function NotificationsCard() {
  const session = useAppSession();
  const [enabled, setEnabled] = useState(true);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    void loadNotifyEnabled().then(setEnabled);
  }, []);

  const toggle = async (value: boolean) => {
    setEnabled(value);
    await saveNotifyEnabled(value);
    setStatus(
      await syncPcWatch({
        hubBaseUrl: session.hubBaseUrl,
        deviceToken: session.deviceToken,
        hubName: session.hubDisplayName,
      }),
    );
  };

  return (
    <View style={styles.card} testID="account-notifications">
      <Text style={styles.label}>Notifications</Text>
      <View style={styles.row}>
        <View style={styles.rowBody}>
          <Text style={styles.title}>Agent finished / failed</Text>
          <Text style={styles.meta}>Checks your PC every 10 s over Tailscale — no cloud</Text>
        </View>
        <Switch
          value={enabled}
          onValueChange={(v) => void toggle(v)}
          trackColor={{ true: colors.accent, false: colors.border }}
          accessibilityLabel="Agent notifications"
        />
      </View>
      {status ? <Text style={styles.meta}>{STATUS_COPY[status] ?? status}</Text> : null}
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
  label: { color: colors.muted, fontSize: 12, fontWeight: '600', textTransform: 'uppercase' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 48 },
  rowBody: { flex: 1 },
  title: { color: colors.text, fontSize: 16 },
  meta: { color: colors.muted, fontSize: 12, marginTop: 2 },
});
