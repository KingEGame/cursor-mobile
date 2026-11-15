import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { normalizeBaseUrl } from './client';

const KEYS = {
  baseUrl: 'hub_base_url',
  token: 'device_token',
  deviceId: 'device_id',
  pcName: 'hub_display_name',
  hubId: 'hub_id',
} as const;

export interface Pairing {
  baseUrl: string;
  token: string | null;
  deviceId: string | null;
  pcName: string | null;
  hubId: string | null;
}

/** Build-time default from EXPO_PUBLIC_HUB_URL / app.json extra.hubUrl (prefills the Pair screen). */
export function defaultBaseUrl(): string {
  const extra = Constants.expoConfig?.extra as { hubUrl?: string } | undefined;
  const v = extra?.hubUrl?.trim();
  return v && !v.includes('${') ? normalizeBaseUrl(v) : '';
}

/** Cursor Hub (≤ 0.1.x) paired against :8787 — that token means nothing to the Hermes bridge. */
export function isLegacyHubUrl(url: string | null | undefined): boolean {
  return /:8787\/?$/.test((url ?? '').trim());
}

export async function loadPairing(): Promise<Pairing> {
  const [storedUrl, storedToken, storedDeviceId, pcName, hubId] = await Promise.all([
    SecureStore.getItemAsync(KEYS.baseUrl),
    SecureStore.getItemAsync(KEYS.token),
    SecureStore.getItemAsync(KEYS.deviceId),
    SecureStore.getItemAsync(KEYS.pcName),
    SecureStore.getItemAsync(KEYS.hubId),
  ]);
  let baseUrl = storedUrl;
  let token = storedToken;
  let deviceId = storedDeviceId;
  if (isLegacyHubUrl(baseUrl)) {
    // One-time migration from the Cursor Hub app: keep nothing that points at the old server.
    await Promise.all(Object.values(KEYS).map((k) => SecureStore.deleteItemAsync(k)));
    baseUrl = token = deviceId = null;
  }
  return {
    baseUrl: normalizeBaseUrl(baseUrl || defaultBaseUrl()),
    token: token || null,
    deviceId: deviceId || null,
    pcName: token ? pcName || null : null,
    hubId: token ? hubId || null : null,
  };
}

export async function savePairing(p: Pairing): Promise<void> {
  const set = (k: string, v: string | null) => (v ? SecureStore.setItemAsync(k, v) : SecureStore.deleteItemAsync(k));
  await Promise.all([
    set(KEYS.baseUrl, normalizeBaseUrl(p.baseUrl)),
    set(KEYS.token, p.token),
    set(KEYS.deviceId, p.deviceId),
    set(KEYS.pcName, p.pcName),
    set(KEYS.hubId, p.hubId),
  ]);
}

/** Forget the token but keep the address so re-pairing is one code away. */
export async function clearPairingToken(): Promise<void> {
  await Promise.all([SecureStore.deleteItemAsync(KEYS.token), SecureStore.deleteItemAsync(KEYS.deviceId)]);
}
