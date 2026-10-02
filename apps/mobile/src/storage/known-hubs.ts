import * as SecureStore from 'expo-secure-store';
import { parseKnownHubs, upsertKnownHub, type KnownHub } from './known-hubs-core';

export { removeKnownHub, upsertKnownHub, type KnownHub } from './known-hubs-core';

const KEY = 'cursor_mobile_known_hubs';

export async function loadKnownHubs(): Promise<KnownHub[]> {
  return parseKnownHubs(await SecureStore.getItemAsync(KEY));
}

export async function saveKnownHubs(list: KnownHub[]): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(list));
}

export async function rememberHub(entry: Omit<KnownHub, 'lastUsedAt'>): Promise<void> {
  await saveKnownHubs(upsertKnownHub(await loadKnownHubs(), { ...entry, lastUsedAt: new Date().toISOString() }));
}
