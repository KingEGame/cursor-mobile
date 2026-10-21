import { normalizeHubBaseUrl } from './hub-url';

/** A PC Hub this phone has paired with (UI-SPEC C: choose one computer). */
export interface KnownHub {
  hubBaseUrl: string;
  deviceToken: string;
  deviceId: string;
  hubDisplayName: string | null;
  lastUsedAt: string;
  /** Stable id of that PC's Hub install (Hub ≥ 0.1.8); older pairings have none. */
  hubId?: string | null;
}

const MAX_HUBS = 8;
/**
 * expo-secure-store refuses values over 2048 bytes on Android. Keep the serialized list
 * under that with headroom, dropping the least recently used PCs first.
 */
export const KNOWN_HUBS_MAX_BYTES = 1900;

function sameHub(a: Pick<KnownHub, 'hubBaseUrl' | 'hubId'>, b: Pick<KnownHub, 'hubBaseUrl' | 'hubId'>): boolean {
  if (a.hubId && b.hubId) return a.hubId === b.hubId;
  return normalizeHubBaseUrl(a.hubBaseUrl) === normalizeHubBaseUrl(b.hubBaseUrl);
}

function byteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? 4 : 3;
    if (c >= 0xd800 && c <= 0xdbff) i += 1;
  }
  return n;
}

/** Drop the oldest entries until the JSON fits the secure-store value limit. Pure. */
export function fitKnownHubs(list: KnownHub[], maxBytes: number = KNOWN_HUBS_MAX_BYTES): KnownHub[] {
  let next = list.slice(0, MAX_HUBS);
  while (next.length > 1 && byteLength(JSON.stringify(next)) > maxBytes) {
    next = next.slice(0, -1);
  }
  return next;
}

/**
 * Add or refresh a Hub, most recently used first. The same PC is matched by hubId when both
 * sides know it (its Tailscale address may change), otherwise by URL. Pure.
 */
export function upsertKnownHub(list: KnownHub[], entry: KnownHub): KnownHub[] {
  const url = normalizeHubBaseUrl(entry.hubBaseUrl);
  const next: KnownHub = { ...entry, hubBaseUrl: url };
  if (!next.hubId) delete next.hubId;
  return fitKnownHubs([next, ...list.filter((h) => !sameHub(h, next))]);
}

export function removeKnownHub(list: KnownHub[], hubBaseUrl: string): KnownHub[] {
  const url = normalizeHubBaseUrl(hubBaseUrl);
  return list.filter((h) => normalizeHubBaseUrl(h.hubBaseUrl) !== url);
}

export function parseKnownHubs(raw: string | null): KnownHub[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v)
      ? v.filter(
          (h): h is KnownHub =>
            !!h && typeof h.hubBaseUrl === 'string' && typeof h.deviceToken === 'string' && typeof h.deviceId === 'string',
        )
      : [];
  } catch {
    return [];
  }
}
