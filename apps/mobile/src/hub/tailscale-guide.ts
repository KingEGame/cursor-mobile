/**
 * Tailscale-first setup copy for Pair / Health when Hub is unreachable
 * or the phone is not yet paired. Pure strings — no Expo deps.
 */

import type { CompanionConnectionState } from './connection-state';

/** Ordered operator steps before Hub URL / pair code matter. */
export const TAILSCALE_SETUP_STEPS: readonly string[] = [
  'Open the Tailscale app on this phone',
  'Sign in and join the same tailnet as the PC (tail246b3f)',
  'Wait until this phone shows Online on the tailnet',
  'Then enter the Hub URL below (Tailscale IP or MagicDNS) and pair',
] as const;

export const TAILSCALE_SETUP_TITLE = 'Before pairing — Tailscale first';

export const TAILSCALE_SETUP_INTRO =
  'Phone and PC must share one private Tailscale mesh. Do not use USB reverse, ngrok, or a public Hub URL.';

/** Compact multi-line block for Text components / tests. */
export function formatTailscaleSetupSteps(): string {
  return TAILSCALE_SETUP_STEPS.map((step, i) => `${i + 1}. ${step}`).join('\n');
}

export interface TailscaleGuideVisibilityInput {
  /** True when Pair / pre-pair surfaces should always show the guide. */
  beforePair?: boolean;
  /** Derived companion connection state (Health / Live). */
  connectionState?: CompanionConnectionState | null;
  /** True when the latest health refresh failed to reach Hub. */
  hubUnreachable?: boolean;
}

/**
 * Show Tailscale-first steps on Pair (always before pair) and on Health
 * when mesh/Hub looks down.
 */
export function shouldShowTailscaleGuide(
  input: TailscaleGuideVisibilityInput,
): boolean {
  if (input.beforePair === true) return true;
  if (input.hubUnreachable === true) return true;
  const state = input.connectionState;
  if (state === 'TailscaleDown' || state === 'HubDown' || state === 'Unknown') {
    return true;
  }
  return false;
}
