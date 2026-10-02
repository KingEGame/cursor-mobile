import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { normalizeHubBaseUrl } from './hub-url';

export { HUB_URL_HINTS, normalizeHubBaseUrl } from './hub-url';

const KEYS = {
  hubBaseUrl: 'hub_base_url',
  deviceToken: 'device_token',
  deviceId: 'device_id',
  hubDisplayName: 'hub_display_name',
} as const;

export interface PairingState {
  hubBaseUrl: string;
  deviceToken: string | null;
  deviceId: string | null;
  hubDisplayName: string | null;
}

/** Build-time default from EXPO_PUBLIC_HUB_URL / app.config extra. */
export function getDefaultHubUrl(): string {
  const extra = Constants.expoConfig?.extra as { hubUrl?: string } | undefined;
  const fromExtra = extra?.hubUrl?.trim();
  if (fromExtra && !fromExtra.includes('${')) {
    return normalizeHubBaseUrl(fromExtra);
  }
  return '';
}

export async function loadPairingState(): Promise<PairingState> {
  const [storedUrl, deviceToken, deviceId, hubDisplayName] = await Promise.all([
    SecureStore.getItemAsync(KEYS.hubBaseUrl),
    SecureStore.getItemAsync(KEYS.deviceToken),
    SecureStore.getItemAsync(KEYS.deviceId),
    SecureStore.getItemAsync(KEYS.hubDisplayName),
  ]);

  return {
    hubBaseUrl: normalizeHubBaseUrl(storedUrl?.trim() || getDefaultHubUrl()),
    deviceToken,
    deviceId,
    hubDisplayName,
  };
}

export async function saveHubBaseUrl(url: string): Promise<void> {
  const normalized = normalizeHubBaseUrl(url);
  if (!normalized) {
    throw new Error('Hub base URL is required');
  }
  await SecureStore.setItemAsync(KEYS.hubBaseUrl, normalized);
}

export async function savePairingSuccess(input: {
  hubBaseUrl: string;
  deviceToken: string;
  deviceId: string;
  hubDisplayName: string;
}): Promise<void> {
  const hubBaseUrl = normalizeHubBaseUrl(input.hubBaseUrl);
  if (!hubBaseUrl) {
    throw new Error('Hub base URL is required');
  }
  await Promise.all([
    SecureStore.setItemAsync(KEYS.hubBaseUrl, hubBaseUrl),
    SecureStore.setItemAsync(KEYS.deviceToken, input.deviceToken),
    SecureStore.setItemAsync(KEYS.deviceId, input.deviceId),
    SecureStore.setItemAsync(KEYS.hubDisplayName, input.hubDisplayName),
  ]);
}

export async function clearPairing(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(KEYS.deviceToken),
    SecureStore.deleteItemAsync(KEYS.deviceId),
    SecureStore.deleteItemAsync(KEYS.hubDisplayName),
  ]);
}
