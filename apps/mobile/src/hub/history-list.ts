/**
 * Pure helpers for Home History / Live session list UX.
 * Keeps mode=history wiring testable without React Native.
 */

import type { SessionListItem, SessionListResponse, SessionMode } from './types';

export const HISTORY_LIST_LIMIT = 100;

export function sessionsListQueryOpts(tab: Exclude<SessionMode, 'editor'>): {
  mode: SessionMode;
  limit: number;
  tolerateMissing: boolean;
} {
  return {
    mode: tab,
    limit: HISTORY_LIST_LIMIT,
    tolerateMissing: true,
  };
}

/** Keep only rows matching the active Home tab (Hub may return mixed on mode=all). */
export function filterSessionsForTab(
  items: SessionListItem[],
  tab: SessionMode,
): SessionListItem[] {
  return items.filter((i) => i.mode === tab);
}

export function historyTabNote(
  list: SessionListResponse,
  filteredCount: number,
): string | null {
  const meta = list.history;
  if (!meta) {
    return filteredCount === 0
      ? 'No local history for this project yet (or storage paths not found on the PC).'
      : null;
  }
  if (!meta.ok) {
    return 'History Index unavailable on the PC — check Hub / Cursor storage paths.';
  }
  if (meta.extractorStale) {
    return 'History extractor stale — local storage missing or unreadable on the PC.';
  }
  const total = meta.sessionCountForBind;
  if (filteredCount === 0) {
    return (
      meta.reason ??
      'No local history for this project yet (or storage paths not found on the PC).'
    );
  }
  if (typeof total === 'number' && total > filteredCount) {
    return `Showing ${filteredCount} of ${total} local history sessions — pull to refresh.`;
  }
  if (typeof total === 'number' && total > 0) {
    return `${total} local history session(s) for this project.`;
  }
  return null;
}

export function modelSourceLabel(source: string | undefined, note?: string | null): string {
  if (note && note.trim()) return note.trim();
  switch (source) {
    case 'env':
      return 'Models from CURSOR_MODELS on the PC Hub (not live CDP picker).';
    case 'env_stub_default':
      return 'Built-in Hub defaults (composer, auto). Not scraped from Cursor CDP.';
    case 'cdp_scrape':
      return 'Models scraped from Cursor Composer model picker via CDP.';
    case 'cursor_local':
      return 'Models reported from Cursor on the PC.';
    default:
      return 'Model list from Hub — verify source before assuming live Cursor picker.';
  }
}
