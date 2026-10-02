/**
 * Project banner display knobs (AC-011-03 long path).
 * RN Text numberOfLines truncates/wraps; full path stays in Hub payload.
 */

/** Path line clamp — wrap/truncate long absolute paths without crashing layout. */
export const BANNER_PATH_NUMBER_OF_LINES = 2;

/** Name line clamp. */
export const BANNER_NAME_NUMBER_OF_LINES = 1;

/** Very long path still returned verbatim from Hub (no Hub-side truncation). */
export function bannerPathDisplay(path: string): string {
  return path;
}

/** Heuristic used in tests: path longer than this needs line clamp in UI. */
export const LONG_PATH_UAT_MIN_CHARS = 120;
