/**
 * Workspace models — DESIGNED Phase 1 stub.
 * Source is env (`CURSOR_MODELS`), not live CDP model-picker scrape.
 */

export interface WorkspaceModel {
  id: string;
  label: string;
  family: string;
  available: boolean;
  default: boolean;
}

/** Built-in defaults so New Session Create is usable without CDP scrape. */
export const DEFAULT_MODELS: WorkspaceModel[] = [
  {
    id: "composer",
    label: "Composer",
    family: "composer",
    available: true,
    default: true,
  },
  {
    id: "auto",
    label: "Auto",
    family: "auto",
    available: true,
    default: false,
  },
];

/**
 * Sentinel for UAT / operator: force an empty catalog (AC-050-03).
 * When CDP scrape is unavailable, Hub returns `models: []` instead of defaults.
 */
export const EMPTY_MODELS_SENTINEL = "__empty__";

/**
 * Parse `CURSOR_MODELS` as comma-separated entries.
 * Each entry: `id`, `id:label`, or `id:label:family`.
 * First entry is default unless one is marked `*` suffix on id (`composer*:Composer`).
 * Special: `__empty__` / `__none__` → empty list (no built-in defaults).
 */
export function parseModelsEnv(raw: string | null | undefined): WorkspaceModel[] {
  if (!raw || !raw.trim()) {
    return DEFAULT_MODELS.map((m) => ({ ...m }));
  }

  const trimmed = raw.trim();
  if (
    trimmed === EMPTY_MODELS_SENTINEL ||
    trimmed.toLowerCase() === "__none__"
  ) {
    return [];
  }

  const parts = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return DEFAULT_MODELS.map((m) => ({ ...m }));
  }

  const models: WorkspaceModel[] = [];
  let defaultIndex = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const segments = part.split(":").map((s) => s.trim());
    let id = segments[0] || `model_${i}`;
    let isDefault = false;
    if (id.endsWith("*")) {
      isDefault = true;
      id = id.slice(0, -1);
      defaultIndex = i;
    }
    const label = segments[1] || id;
    const family = segments[2] || guessFamily(id);
    models.push({
      id,
      label,
      family,
      available: true,
      default: false,
    });
    if (isDefault) defaultIndex = i;
  }

  if (models.length > 0) {
    models[defaultIndex]!.default = true;
  }
  return models;
}

function guessFamily(id: string): string {
  const lower = id.toLowerCase();
  if (lower.includes("composer")) return "composer";
  if (lower.includes("claude")) return "claude";
  if (lower.includes("gpt") || lower.includes("o1") || lower.includes("o3"))
    return "openai";
  if (lower === "auto") return "auto";
  return "other";
}

export function findModel(
  models: WorkspaceModel[],
  modelId: string,
): WorkspaceModel | undefined {
  return models.find((m) => m.id === modelId);
}
