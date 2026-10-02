/**
 * AC-080-05 — format the in-app version label (Expo / app.json).
 * Callers pass values from `expo-constants` at the UI boundary.
 */
const FALLBACK_VERSION = '0.1.0';

export function appVersionLabel(parts?: {
  version?: string | null;
  build?: string | number | null;
}): string {
  const ver =
    (parts?.version && String(parts.version).trim()) || FALLBACK_VERSION;
  const build = parts?.build;
  if (build != null && String(build).length > 0) {
    return `v${ver} (${build})`;
  }
  return `v${ver}`;
}
