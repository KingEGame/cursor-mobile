import * as SecureStore from 'expo-secure-store';
import { PermissionsAndroid, Platform } from 'react-native';
import { PcWatch } from '../../modules/pc-watch';

const ENABLED_KEY = 'cursor_mobile_notify_enabled';

/** Notifications default on; the operator can turn them off in Account. */
export async function loadNotifyEnabled(): Promise<boolean> {
  return (await SecureStore.getItemAsync(ENABLED_KEY)) !== 'off';
}

export async function saveNotifyEnabled(enabled: boolean): Promise<void> {
  await SecureStore.setItemAsync(ENABLED_KEY, enabled ? 'on' : 'off');
}

async function notificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || Platform.Version < 33) return true;
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

/**
 * Start (or stop) the background watcher for the paired PC. The native service polls
 * GET /v1/agents every 10 s over Tailscale and posts local notifications — no cloud push.
 */
export async function syncPcWatch(opts: {
  hubBaseUrl: string;
  deviceToken: string | null;
  hubName: string | null;
}): Promise<'running' | 'off' | 'no-permission' | 'unsupported'> {
  if (!PcWatch) return 'unsupported';
  if (!opts.deviceToken || !opts.hubBaseUrl || !(await loadNotifyEnabled())) {
    if (PcWatch.isRunning()) PcWatch.stop();
    return 'off';
  }
  if (!(await notificationPermission())) return 'no-permission';
  PcWatch.start(opts.hubBaseUrl, opts.deviceToken, opts.hubName || 'your PC');
  return 'running';
}
