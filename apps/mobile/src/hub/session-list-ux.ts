/**
 * Pure Home session-list UX helpers (AC-020-04 · AC-021-01 · AC-021-02).
 * Keeps mode badges / empty CTA / unknown-mode fallback testable without RN.
 */

import type { SessionMode } from './types';

/** Known Hub session modes the APK navigates. */
const KNOWN_OPENABLE: ReadonlySet<string> = new Set(['live', 'history']);

/** Badge text for a list row (AC-021-01). Unknown Hub values stay safe (AC-021-02). */
export function sessionModeBadgeLabel(mode: string | null | undefined): string {
  if (mode === 'live' || mode === 'history') return mode;
  if (mode === 'editor') return 'editor';
  return 'unknown';
}

/** True when tapping the row should open Live chat or History read. */
export function canOpenSessionFromList(mode: string | null | undefined): boolean {
  return typeof mode === 'string' && KNOWN_OPENABLE.has(mode);
}

/**
 * Normalize Hub mode strings. Unknown → 'unknown' (never crash / never invent live).
 */
export function normalizeSessionMode(raw: unknown): SessionMode | 'unknown' {
  if (raw === 'live' || raw === 'history' || raw === 'editor') return raw;
  return 'unknown';
}

/** Empty live-list copy + whether New session CTA should show (AC-020-04). */
export function liveEmptyListGuidance(opts: {
  degraded: boolean;
  note?: string | null;
}): { body: string; showNewSessionCta: boolean; ctaLabel: string } {
  return {
    body: opts.note?.trim() || 'No sessions for this project yet.',
    showNewSessionCta: true,
    ctaLabel: opts.degraded ? 'Start new session' : 'Start new session',
  };
}

/** Unbound New session empty-state guidance (AC-053-04). */
export function unboundWorkspaceCreateGuidance(): string {
  return 'Open a project in Cursor on the PC first. New sessions bind to that workspace only.';
}
