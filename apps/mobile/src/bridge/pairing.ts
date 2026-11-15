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

export async function loadPairing(): Promise<Pairing> {
  const [baseUrl, token, deviceId, pcName, hubId] = await Promise.all([
    SecureStore.getItemAsync(KEYS.baseUrl),
    SecureStore.getItemAsync(KEYS.token),
    SecureStore.getItemAsync(KEYS.deviceId),
    SecureStore.getItemAsync(KEYS.pcName),
    SecureStore.getItemAsync(KEYS.hubId),
  ]);
  return {
    baseUrl: normalizeBaseUrl(baseUrl || defaultBaseUrl()),
    token: token || null,
    deviceId: deviceId || null,
    pcName: pcName || null,
    hubId: hubId || null,
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
