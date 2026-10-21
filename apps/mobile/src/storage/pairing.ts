import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { rememberHub } from './known-hubs';
import { normalizeHubBaseUrl } from './hub-url';

export { HUB_URL_HINTS, normalizeHubBaseUrl } from './hub-url';

const KEYS = {
  hubBaseUrl: 'hub_base_url',
  deviceToken: 'device_token',
  deviceId: 'device_id',
  hubDisplayName: 'hub_display_name',
  hubId: 'hub_id',
} as const;

export interface PairingState {
  hubBaseUrl: string;
  deviceToken: string | null;
  deviceId: string | null;
  hubDisplayName: string | null;
  /** Stable id of the active PC's Hub (Hub ≥ 0.1.8); null for older pairings. */
  hubId: string | null;
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
  const [storedUrl, deviceToken, deviceId, hubDisplayName, hubId] = await Promise.all([
    SecureStore.getItemAsync(KEYS.hubBaseUrl),
    SecureStore.getItemAsync(KEYS.deviceToken),
    SecureStore.getItemAsync(KEYS.deviceId),
    SecureStore.getItemAsync(KEYS.hubDisplayName),
    SecureStore.getItemAsync(KEYS.hubId),
  ]);

  return {
    hubBaseUrl: normalizeHubBaseUrl(storedUrl?.trim() || getDefaultHubUrl()),
    deviceToken,
    deviceId,
    hubDisplayName,
    hubId: hubId?.trim() || null,
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
  hubId?: string | null;
}): Promise<void> {
  const hubBaseUrl = normalizeHubBaseUrl(input.hubBaseUrl);
  if (!hubBaseUrl) {
    throw new Error('Hub base URL is required');
  }
  const hubId = input.hubId?.trim() || null;
  await Promise.all([
    SecureStore.setItemAsync(KEYS.hubBaseUrl, hubBaseUrl),
    SecureStore.setItemAsync(KEYS.deviceToken, input.deviceToken),
    SecureStore.setItemAsync(KEYS.deviceId, input.deviceId),
    SecureStore.setItemAsync(KEYS.hubDisplayName, input.hubDisplayName),
    hubId ? SecureStore.setItemAsync(KEYS.hubId, hubId) : SecureStore.deleteItemAsync(KEYS.hubId),
  ]);
  // Remember this PC so Account → Computer can switch back to it later.
  await rememberHub({
    hubBaseUrl,
    deviceToken: input.deviceToken,
    deviceId: input.deviceId,
    hubDisplayName: input.hubDisplayName,
    hubId,
  });
}

export async function clearPairing(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(KEYS.deviceToken),
    SecureStore.deleteItemAsync(KEYS.deviceId),
    SecureStore.deleteItemAsync(KEYS.hubDisplayName),
    SecureStore.deleteItemAsync(KEYS.hubId),
  ]);
}
