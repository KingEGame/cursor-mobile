/**
 * What the operator sees when pairing fails. Pure (no Expo deps) so it is unit-tested.
 * The Hub's own message is used for PAIR_CODE_INVALID because it already says which PC
 * answered and why (restart, other PC, typo).
 */
import { HubApiError } from './types';

/** Loopback pair page URL — only ever opened on the PC. */
export const PC_PAIR_URL = 'http://127.0.0.1:8787/pair';

export function pairErrorText(err: unknown, pcName?: string | null): string {
  const pc = pcName?.trim() || 'the PC';
  if (err instanceof HubApiError) {
    switch (err.code) {
      case 'PAIR_CODE_INVALID':
        return err.message || `${pc} did not recognise this code. Reload the PC pair page and scan again.`;
      case 'PAIR_CODE_EXPIRED':
        return `This code expired. On ${pc}, click New code on the pair page and scan again.`;
      case 'PAIR_CODE_USED':
        return `This code was already used. On ${pc}, click New code on the pair page and scan again.`;
      case 'RATE_LIMITED':
      case 'PAIR_RATE_LIMITED':
        return err.message || 'Too many wrong codes. Wait a minute, then get a new code on the PC.';
      case 'NETWORK_ERROR':
      case 'TIMEOUT':
        return `Cannot reach ${pc}. Check Tailscale is on and connected on this phone and on ${pc}, then try again.`;
      case 'ROUTE_NOT_AVAILABLE':
        return `${pc} answered, but not as a Cursor Mobile Hub. Check the address, or update the Hub on ${pc}.`;
      default:
        return err.status === 0
          ? `Cannot reach ${pc}. Check Tailscale on both devices, then try again.`
          : `${err.code}: ${err.message}`;
    }
  }
  const msg = err instanceof Error ? err.message : '';
  if (/network request failed|failed to fetch|timeout|aborted/i.test(msg)) {
    return `Cannot reach ${pc}. Check Tailscale is on and connected on this phone and on ${pc}, then try again.`;
  }
  return msg || 'Pairing failed';
}

/** True when the QR points at an address only the PC itself can reach. */
export function isLoopbackHost(host: string | undefined | null): boolean {
  const h = (host ?? '').trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

export function loopbackQrText(pcName?: string | null): string {
  const pc = pcName?.trim() || 'the PC';
  return `The QR on ${pc} points at 127.0.0.1, which only ${pc} can reach — its Hub found no Tailscale address. On ${pc}, make sure Tailscale is connected, then click New code on the pair page and scan again.`;
}
