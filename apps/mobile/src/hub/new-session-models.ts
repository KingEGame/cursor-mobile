/**
 * New-session model catalog helpers (AC-050-03 / AC-050-04).
 */

export const EMPTY_MODELS_ERROR =
  'No models from Hub catalog — set CURSOR_MODELS on the PC or refresh later.';

export const EMPTY_MODELS_BODY = 'No models loaded.';

export const MODELS_DISAPPEARED_ERROR =
  'Model list emptied since last load — refresh from PC or cancel Create.';

export interface ModelChoice {
  id: string;
  label?: string;
  available?: boolean;
  default?: boolean;
}

/** Pick default model id, or null when catalog is empty / all unavailable. */
export function pickDefaultModelId(models: ModelChoice[]): string | null {
  if (!models.length) return null;
  const def =
    models.find((m) => m.default && m.available !== false) ??
    models.find((m) => m.available !== false);
  return def?.id ?? null;
}

/**
 * After a refresh: previous catalog had models, new one is empty → mid-flow clear error.
 */
export function modelsDisappearedMessage(
  previousCount: number,
  nextCount: number,
): string | null {
  if (previousCount > 0 && nextCount === 0) {
    return MODELS_DISAPPEARED_ERROR;
  }
  if (nextCount === 0) {
    return EMPTY_MODELS_ERROR;
  }
  return null;
}
