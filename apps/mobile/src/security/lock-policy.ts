/**
 * App-lock decisions (pure — no native calls, so it is unit-testable).
 *
 * lockSend is paused (always off): operators disliked fingerprint/PIN on every
 * send. lockOpen remains optional via Account → Security.
 */

export interface LockSettings {
  /** Fingerprint / PIN before a message is sent to the PC (paused — always off). */
  lockSend: boolean;
  /** Fingerprint / PIN when the app is opened or comes back from background (default off). */
  lockOpen: boolean;
}

/** lockSend stayed true historically; keep the field but default / force off for now. */
export const DEFAULT_LOCK_SETTINGS: LockSettings = { lockSend: false, lockOpen: false };

/** Feature pause: unlock-to-send is disabled until re-enabled deliberately. */
export const LOCK_SEND_ENABLED = false;

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
      // Ignore stored lockSend while the feature is paused.
      lockSend: LOCK_SEND_ENABLED
        ? typeof v.lockSend === 'boolean'
          ? v.lockSend
          : DEFAULT_LOCK_SETTINGS.lockSend
        : false,
      lockOpen: typeof v.lockOpen === 'boolean' ? v.lockOpen : DEFAULT_LOCK_SETTINGS.lockOpen,
    };
  } catch {
    return { ...DEFAULT_LOCK_SETTINGS };
  }
}
