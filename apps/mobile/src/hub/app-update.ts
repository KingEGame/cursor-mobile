/**
 * Phone self-update — pure decisions (no native calls) so node:test covers them.
 * The Hub on the PC serves GET /v1/app/latest + /v1/app/apk over Tailscale.
 */

export type AppLatestUnavailableReason =
  | 'NO_RELEASES_DIR'
  | 'NO_RELEASE'
  | 'INVALID_MANIFEST'
  | 'APK_MISSING'
  | 'APK_MISMATCH';

export interface AppLatestAvailable {
  available: true;
  versionName: string;
  versionCode: number;
  sizeBytes: number;
  sha256: string;
  md5: string;
  publishedAt: string;
  notes: string[];
  gitSha: string | null;
  ciRunUrl: string | null;
  testsPassed: number | null;
  source: 'local' | 'github';
  downloadPath: string;
  /** Absolute public URL (GitHub). When set, the APK is fetched from it with no Hub token. */
  downloadUrl?: string;
}

export interface AppLatestUnavailable {
  available: false;
  reason: AppLatestUnavailableReason | string;
  message?: string;
}

export type AppLatestResponse = AppLatestAvailable | AppLatestUnavailable;

/** Public, binaries-only repo CI mirrors every release to (the source repo is private). */
export const GITHUB_RELEASES_REPO = 'KingEGame/cursor-mobile-releases';
export const GITHUB_LATEST_URL = `https://github.com/${GITHUB_RELEASES_REPO}/releases/latest/download/latest.json`;

/**
 * latest.json published next to the APK on GitHub → the same shape the Hub serves, plus a public
 * download URL. Returns null for anything incomplete so a bad feed never offers an install.
 */
export function parseGithubLatest(raw: unknown): AppLatestAvailable | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const { versionName, apkFile, sha256, md5 } = m;
  if (typeof versionName !== 'string' || typeof apkFile !== 'string') return null;
  if (typeof sha256 !== 'string' || typeof md5 !== 'string' || !md5) return null;
  const versionCode = Number(m.versionCode);
  const sizeBytes = Number(m.sizeBytes);
  if (!Number.isInteger(versionCode) || versionCode <= 0) return null;
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return null;
  // The file name becomes part of a URL path: refuse anything that is not a plain APK name.
  if (!/^[A-Za-z0-9._-]+\.apk$/.test(apkFile)) return null;
  return {
    available: true,
    versionName,
    versionCode,
    sizeBytes,
    sha256,
    md5,
    publishedAt: typeof m.publishedAt === 'string' ? m.publishedAt : '',
    notes: Array.isArray(m.notes) ? m.notes.filter((n): n is string => typeof n === 'string') : [],
    gitSha: typeof m.gitSha === 'string' ? m.gitSha : null,
    ciRunUrl: typeof m.ciRunUrl === 'string' ? m.ciRunUrl : null,
    testsPassed: typeof m.testsPassed === 'number' ? m.testsPassed : null,
    source: 'github',
    downloadPath: '',
    downloadUrl: `https://github.com/${GITHUB_RELEASES_REPO}/releases/download/v${versionName}/${apkFile}`,
  };
}

export type UpdateStatus =
  | { kind: 'unknown' }
  | { kind: 'up-to-date'; installedCode: number }
  | { kind: 'none-published'; message: string }
  | { kind: 'available'; installedCode: number; release: AppLatestAvailable };

export function decideUpdate(
  installedCode: number | null,
  latest: AppLatestResponse | null,
): UpdateStatus {
  if (!latest) return { kind: 'unknown' };
  if (!latest.available) {
    return {
      kind: 'none-published',
      message: latest.message?.trim() || 'No app release on this PC yet.',
    };
  }
  // Unknown installed build: never offer a possible downgrade.
  if (installedCode == null || !Number.isFinite(installedCode)) return { kind: 'unknown' };
  if (latest.versionCode > installedCode) {
    return { kind: 'available', installedCode, release: latest };
  }
  return { kind: 'up-to-date', installedCode };
}

/** Constants gives versionCode as number (expoConfig) or string (native build). */
export function parseInstalledVersionCode(
  ...candidates: Array<string | number | null | undefined>
): number | null {
  for (const c of candidates) {
    if (c == null || c === '') continue;
    const n = typeof c === 'number' ? c : Number.parseInt(String(c), 10);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

export function formatMegabytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const mb = bytes / 1_000_000;
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}

export function downloadPercent(written: number, expected: number): number {
  if (!Number.isFinite(written) || !Number.isFinite(expected) || expected <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((written / expected) * 100)));
}

/** Integrity check of the downloaded file before it goes to Android's installer. */
export function verifyDownload(
  actual: { size: number | null | undefined; md5: string | null | undefined },
  release: Pick<AppLatestAvailable, 'sizeBytes' | 'md5'>,
): { ok: true } | { ok: false; message: string } {
  if (actual.size !== release.sizeBytes) {
    return {
      ok: false,
      message: `Download is ${actual.size ?? 0} bytes, expected ${release.sizeBytes}.`,
    };
  }
  if (!actual.md5 || actual.md5.toLowerCase() !== release.md5.toLowerCase()) {
    return { ok: false, message: 'Checksum does not match the published build.' };
  }
  return { ok: true };
}

export type InstallPhase =
  | { step: 'idle' }
  | { step: 'downloading'; percent: number }
  | { step: 'verifying' }
  | { step: 'installer' }
  | { step: 'failed'; message: string };

export const INSTALL_STEPS = [
  { key: 'downloading', label: 'Downloading the update' },
  { key: 'verifying', label: 'Check file size and checksum' },
  { key: 'installer', label: 'Open Android installer' },
] as const;

/** done | active | todo for each row of the install checklist. */
export function stepState(
  phase: InstallPhase,
  key: (typeof INSTALL_STEPS)[number]['key'],
): 'done' | 'active' | 'todo' | 'failed' {
  const order = INSTALL_STEPS.map((s) => s.key);
  if (phase.step === 'idle') return 'todo';
  if (phase.step === 'failed') return 'todo';
  const cur = order.indexOf(phase.step);
  const idx = order.indexOf(key);
  if (idx < cur) return 'done';
  if (idx === cur) return 'active';
  return 'todo';
}
