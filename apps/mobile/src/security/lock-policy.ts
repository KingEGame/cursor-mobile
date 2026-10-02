/**
 * App-lock decisions (pure — no native calls, so it is unit-testable).
 * The phone can make an agent act on the PC, so sending is gated by default.
 */

export interface LockSettings {
  /** Fingerprint / PIN before a message is sent to the PC (default on). */
  lockSend: boolean;
  /** Fingerprint / PIN when the app is opened or comes back from background (default off). */
  lockOpen: boolean;
}

export const DEFAULT_LOCK_SETTINGS: LockSettings = { lockSend: true, lockOpen: false };

export interface DeviceAuth {
  hasHardware: boolean;
  enrolled: boolean;
}

export type LockDecision = 'skip' | 'prompt' | 'unavailable';

/**
 * `unavailable`: the setting is on but the phone has no biometrics / screen lock set up.
 * We do not block the operator then (they could not unlock either) — Account says why.
 */
export function decideLock(enabled: boolean, device: DeviceAuth): LockDecision {
  if (!enabled) return 'skip';
  if (!device.hasHardware && !device.enrolled) return 'unavailable';
  if (!device.enrolled) return 'unavailable';
  return 'prompt';
}

/** Re-lock on open only after the app was in the background this long. */
export const RELOCK_AFTER_MS = 5 * 60_000;

export function shouldRelock(backgroundedAt: number | null, now: number): boolean {
  return backgroundedAt !== null && now - backgroundedAt >= RELOCK_AFTER_MS;
}

export function parseLockSettings(raw: string | null): LockSettings {
  if (!raw) return { ...DEFAULT_LOCK_SETTINGS };
  try {
    const v = JSON.parse(raw) as Partial<LockSettings>;
    return {
      lockSend: typeof v.lockSend === 'boolean' ? v.lockSend : DEFAULT_LOCK_SETTINGS.lockSend,
      lockOpen: typeof v.lockOpen === 'boolean' ? v.lockOpen : DEFAULT_LOCK_SETTINGS.lockOpen,
    };
  } catch {
    return { ...DEFAULT_LOCK_SETTINGS };
  }
}
