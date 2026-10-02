import { normalizeHubBaseUrl } from './hub-url';

/** A PC Hub this phone has paired with (UI-SPEC C: choose one computer). */
export interface KnownHub {
  hubBaseUrl: string;
  deviceToken: string;
  deviceId: string;
  hubDisplayName: string | null;
  lastUsedAt: string;
}

const MAX_HUBS = 8;

/** Add or refresh a Hub (matched by URL), most recently used first. Pure. */
export function upsertKnownHub(list: KnownHub[], entry: KnownHub): KnownHub[] {
  const url = normalizeHubBaseUrl(entry.hubBaseUrl);
  const next = { ...entry, hubBaseUrl: url };
  return [next, ...list.filter((h) => normalizeHubBaseUrl(h.hubBaseUrl) !== url)].slice(0, MAX_HUBS);
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
