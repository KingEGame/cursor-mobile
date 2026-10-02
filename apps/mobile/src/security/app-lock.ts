import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { decideLock, parseLockSettings, type DeviceAuth, type LockSettings } from './lock-policy';

const SETTINGS_KEY = 'cursor_mobile_lock_settings';

export async function loadLockSettings(): Promise<LockSettings> {
  return parseLockSettings(await SecureStore.getItemAsync(SETTINGS_KEY));
}

export async function saveLockSettings(settings: LockSettings): Promise<void> {
  await SecureStore.setItemAsync(SETTINGS_KEY, JSON.stringify(settings));
}

export async function readDeviceAuth(): Promise<DeviceAuth> {
  const [hasHardware, enrolled] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
  ]);
  return { hasHardware, enrolled };
}

/**
 * Ask for fingerprint / PIN when `enabled`. Resolves true when the action may proceed.
 * On-device only (Android BiometricPrompt / device credential) — nothing leaves the phone.
 */
export async function unlock(enabled: boolean, promptMessage: string): Promise<boolean> {
  const decision = decideLock(enabled, await readDeviceAuth());
  if (decision !== 'prompt') return true;
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage,
    cancelLabel: 'Cancel',
    disableDeviceFallback: false,
  });
  return result.success;
}
