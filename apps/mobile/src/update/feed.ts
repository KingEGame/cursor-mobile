/**
 * Where the phone learns about a new build: GitHub's public releases repo first (fast, no PC needed),
 * the paired PC Hub as fallback. Both describe the same signed APK; the file is verified by size + md5
 * before Android's installer opens it.
 */
import {
  GITHUB_LATEST_URL,
  parseGithubLatest,
  type AppLatestResponse,
} from '../hub/app-update';
import type { HubClient } from '../hub/client';

const GITHUB_TIMEOUT_MS = 8000;

export async function fetchGithubLatest(fetchImpl: typeof fetch = fetch): Promise<AppLatestResponse | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GITHUB_TIMEOUT_MS);
  try {
    const res = await fetchImpl(GITHUB_LATEST_URL, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return parseGithubLatest(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** GitHub if it answers with a valid manifest, otherwise the PC Hub (rejects when neither works). */
export async function loadLatestRelease(client: HubClient | null): Promise<AppLatestResponse> {
  const gh = await fetchGithubLatest();
  if (gh) return gh;
  if (!client) throw new Error('Cannot reach GitHub, and this phone is not paired with a PC.');
  return client.getAppLatest();
}
