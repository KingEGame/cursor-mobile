/**
 * Pure Hub URL helpers (no Expo deps) — build-time default vs runtime Pair field.
 * PC-local companion: Tailscale Mesh only; never embed CDP (:9222).
 */

/** Strip trailing slashes; empty string if blank. */
export function normalizeHubBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** True when URL points at phone-unreachable loopback (pair hint must not replace mesh URL). */
export function isLoopbackHubUrl(url: string): boolean {
  const normalized = normalizeHubBaseUrl(url);
  if (!normalized) return false;
  try {
    const host = new URL(normalized).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return /127\.0\.0\.1|localhost/i.test(normalized);
  }
}

/**
 * Keep the URL the phone just paired through — it is proven reachable from this phone.
 * The Hub's baseUrlHint (often a MagicDNS name) is only a fallback: Android Tailscale
 * does not always resolve `*.ts.net`, so swapping to it breaks a working pairing.
 */
export function resolvePairedHubBaseUrl(
  pairedFromUrl: string,
  baseUrlHint: string | undefined | null,
): string {
  const fromPhone = normalizeHubBaseUrl(pairedFromUrl);
  if (fromPhone && !isLoopbackHubUrl(fromPhone)) {
    return fromPhone;
  }
  const hint = normalizeHubBaseUrl(baseUrlHint ?? '');
  if (hint && !isLoopbackHubUrl(hint)) {
    return hint;
  }
  return fromPhone;
}

/**
 * Operator-facing Tailscale Hub URL hints (this PC).
 * Runtime Pair field always wins; build-time EXPO_PUBLIC_HUB_URL only prefills.
 * Note: hostname may churn (kingwarpc → kingwarpc-1); prefer live `tailscale ip -4`.
 */
export const HUB_URL_HINTS = {
  ipv4: 'http://100.108.160.99:8787',
  magicDns: 'http://kingwarpc-1.tail246b3f.ts.net:8787',
  placeholder: 'http://100.108.160.99:8787',
} as const;
