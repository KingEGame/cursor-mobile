/**
 * Human text for bridge failures. Pure — unit-tested.
 */
import { isBridgeError } from './client';

export function describeError(err: unknown, pcName?: string | null): string {
  const pc = pcName?.trim() || 'the PC';
  if (isBridgeError(err)) {
    switch (err.code) {
      case 'UNREACHABLE':
      case 'TIMEOUT':
        return `Can't reach ${pc}. Check that Tailscale is connected on this phone and on ${pc}, and that the Hermes Gateway is running.`;
      case 'NO_ADDRESS':
        return 'Enter the PC address first (for example http://100.x.y.z:8097).';
      case 'NOT_A_BRIDGE':
      case 'NOT_FOUND':
        return `${pc} answered, but not as a Hermes phone bridge. Check the port (default 8097) and that PHONE_BRIDGE_ENABLED=true.`;
      case 'PAIR_CODE_INVALID':
        return `${pc} did not accept this code — it is wrong, already used, or older than 5 minutes. Open http://127.0.0.1:8097/pair on ${pc} for a new one.`;
      case 'RATE_LIMITED':
        return 'Too many wrong codes. Wait a minute, then try a fresh code.';
      case 'UNAUTHORIZED':
      case 'NOT_PAIRED':
        return `${pc} no longer accepts this phone. Pair again.`;
      case 'SESSION_BUSY':
        return `Hermes is still working in this session on ${pc}. Send again when it finishes.`;
      case 'BIND_FAILED':
        return `${pc} could not attach the phone to this session: ${err.message}`;
      case 'SESSION_READ_ONLY':
        return 'This is an internal session and cannot be continued.';
      case 'SESSION_NOT_FOUND':
        return 'This session no longer exists on the PC.';
      default:
        return err.message ? `${err.message} (${err.code})` : err.code;
    }
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Parse what the PC pair page encodes: `hermes-phone://pair?hubUrl=…&code=…&pairId=…&name=…`. */
export function parsePairPayload(raw: string): { hubUrl?: string; code?: string; pairId?: string; name?: string } | null {
  const t = raw.trim();
  const q = t.indexOf('?');
  if (!/^hermes-phone:\/\/\/?pair/i.test(t) || q < 0) {
    // Bare 8-digit code typed or scanned.
    const digits = t.replace(/\s+/g, '');
    return /^\d{8}$/.test(digits) ? { code: digits } : null;
  }
  const sp = new URLSearchParams(t.slice(q + 1));
  const pick = (k: string) => sp.get(k)?.trim() || undefined;
  const code = pick('code')?.replace(/\s+/g, '');
  return { hubUrl: pick('hubUrl'), code, pairId: pick('pairId'), name: pick('name') };
}
