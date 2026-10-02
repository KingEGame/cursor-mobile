import type { RootStackParamList } from './types';

export type PairDeepLinkParams = NonNullable<RootStackParamList['Pair']>;

const PAIR_KEYS = [
  'code',
  'pairId',
  'host',
  'port',
  'hubUrl',
  'auto',
  'deviceToken',
  'deviceId',
  'hubDisplayName',
] as const satisfies ReadonlyArray<keyof PairDeepLinkParams>;

/** Soft decode — URLSearchParams already decodes; avoid throwing on `%`. */
export function softDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parse `cursor-companion://pair?...` (or path `pair?...`) into stack params.
 * Returns null when the URL is not a pair deep link.
 */
export function parsePairDeepLink(
  url: string | null | undefined,
): PairDeepLinkParams | null {
  if (!url) return null;
  const trimmed = url.trim();
  const full =
    /^cursor-companion:\/\/\/?pair\/?(?:\?(.*))?$/i.exec(trimmed) ||
    /^cursor-companion:\/\/\/?pair\?(.*)$/i.exec(trimmed);
  const pathOnly = !full
    ? /^pair\/?\?(.*)$/i.exec(trimmed) || /^pair\/?(?:\?(.*))?$/i.exec(trimmed)
    : null;
  const match = full || pathOnly;
  if (!match) return null;
  // Bare `pair` / `pair/` with no query still means Pair screen.
  if (!match[1] && !/[?&]/.test(trimmed)) {
    return {};
  }
  const qs = match[1] || '';
  if (!qs && !trimmed.includes('?')) {
    return {};
  }
  const sp = new URLSearchParams(qs);
  const params: PairDeepLinkParams = {};
  for (const key of PAIR_KEYS) {
    const raw = sp.get(key);
    if (raw != null && raw !== '') {
      // URLSearchParams already percent-decodes; softDecode is idempotent for
      // plain tokens and safe if a caller double-encoded.
      params[key] = softDecode(raw);
    }
  }
  return params;
}

/** True when deep link carries a PC-completed pair token inject. */
export function isPairTokenInject(params: PairDeepLinkParams | null | undefined): boolean {
  if (!params) return false;
  return Boolean(params.deviceToken?.trim() && params.deviceId?.trim());
}

/**
 * Build an adb-safe pair token-inject deep link.
 * Prefer host+port over hubUrl — nested `http://` inside the query is often
 * truncated when Android re-parses Intent data (deviceToken/deviceId lost).
 */
export function buildPairTokenInjectDeepLink(input: {
  host: string;
  port?: string;
  deviceToken: string;
  deviceId: string;
  hubDisplayName?: string;
  auto?: string;
}): string {
  const qs = new URLSearchParams();
  qs.set('host', input.host.trim());
  qs.set('port', (input.port || '8787').trim());
  qs.set('deviceToken', input.deviceToken.trim());
  qs.set('deviceId', input.deviceId.trim());
  if (input.hubDisplayName?.trim()) {
    qs.set('hubDisplayName', input.hubDisplayName.trim());
  }
  qs.set('auto', (input.auto ?? '1').trim() || '1');
  return `cursor-companion://pair?${qs.toString()}`;
}
