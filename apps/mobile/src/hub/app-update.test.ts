import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  decideUpdate,
  GITHUB_LATEST_URL,
  parseGithubLatest,
  downloadPercent,
  formatMegabytes,
  parseInstalledVersionCode,
  stepState,
  verifyDownload,
  type AppLatestAvailable,
} from './app-update';
import { createHubClient } from './client';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const release: AppLatestAvailable = {
  available: true,
  versionName: '0.1.1',
  versionCode: 101,
  sizeBytes: 18_400_000,
  sha256: 'a'.repeat(64),
  md5: 'b'.repeat(32),
  publishedAt: '2026-10-01T12:00:00.000Z',
  notes: ['Self-update'],
  gitSha: 'abc1234',
  ciRunUrl: null,
  testsPassed: 214,
  source: 'local',
  downloadPath: '/v1/app/apk',
};

describe('decideUpdate', () => {
  it('offers a strictly newer versionCode', () => {
    const s = decideUpdate(100, release);
    assert.equal(s.kind, 'available');
  });
  it('same or older build is up to date (never a downgrade)', () => {
    assert.equal(decideUpdate(101, release).kind, 'up-to-date');
    assert.equal(decideUpdate(200, release).kind, 'up-to-date');
  });
  it('unknown installed build never offers an update', () => {
    assert.equal(decideUpdate(null, release).kind, 'unknown');
  });
  it('nothing published surfaces the Hub message', () => {
    const s = decideUpdate(100, { available: false, reason: 'NO_RELEASE', message: 'none yet' });
    assert.deepEqual(s, { kind: 'none-published', message: 'none yet' });
  });
  it('no response yet is unknown', () => {
    assert.equal(decideUpdate(100, null).kind, 'unknown');
  });
});

describe('helpers', () => {
  it('parseInstalledVersionCode takes the first valid candidate', () => {
    assert.equal(parseInstalledVersionCode(null, '101', 5), 101);
    assert.equal(parseInstalledVersionCode(undefined, '', 'x', 100), 100);
    assert.equal(parseInstalledVersionCode(null, undefined), null);
  });
  it('formatMegabytes', () => {
    assert.equal(formatMegabytes(18_400_000), '18 MB');
    assert.equal(formatMegabytes(4_250_000), '4.3 MB');
    assert.equal(formatMegabytes(0), '—');
  });
  it('downloadPercent clamps', () => {
    assert.equal(downloadPercent(50, 200), 25);
    assert.equal(downloadPercent(500, 200), 100);
    assert.equal(downloadPercent(1, 0), 0);
  });
  it('verifyDownload checks size then md5 (case-insensitive)', () => {
    assert.deepEqual(verifyDownload({ size: release.sizeBytes, md5: 'B'.repeat(32) }, release), { ok: true });
    assert.equal(verifyDownload({ size: 1, md5: release.md5 }, release).ok, false);
    assert.equal(verifyDownload({ size: release.sizeBytes, md5: 'c'.repeat(32) }, release).ok, false);
    assert.equal(verifyDownload({ size: release.sizeBytes, md5: null }, release).ok, false);
  });
  it('stepState walks the checklist', () => {
    assert.equal(stepState({ step: 'downloading', percent: 10 }, 'downloading'), 'active');
    assert.equal(stepState({ step: 'verifying' }, 'downloading'), 'done');
    assert.equal(stepState({ step: 'verifying' }, 'installer'), 'todo');
    assert.equal(stepState({ step: 'installer' }, 'verifying'), 'done');
  });
});

describe('HubClient app update routes', () => {
  it('getAppLatest sends the device token to /v1/app/latest', async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const client = createHubClient({
      baseUrl: 'http://pc:8787/',
      deviceToken: 'tok',
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = { url, auth: (init.headers as Record<string, string>).Authorization ?? null };
        return new Response(JSON.stringify(release), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const got = await client.getAppLatest();
    assert.equal(got.available, true);
    assert.deepEqual(seen, { url: 'http://pc:8787/v1/app/latest', auth: 'Bearer tok' });
    assert.equal(client.appDownloadUrl(release.downloadPath), 'http://pc:8787/v1/app/apk');
  });
});

describe('wiring', () => {
  it('Account shows the update card and Update screen is registered', () => {
    const account = readFileSync(resolve(root, 'src/screens/AccountScreen.tsx'), 'utf8');
    assert.match(account, /UpdateCard/);
    const app = readFileSync(resolve(root, 'App.tsx'), 'utf8');
    assert.match(app, /name="Update"/);
  });
  it('Android may install packages (permission in app.config)', () => {
    const cfg = readFileSync(resolve(root, 'app.config.ts'), 'utf8');
    assert.match(cfg, /REQUEST_INSTALL_PACKAGES/);
  });
});

describe('parseGithubLatest', () => {
  const manifest = {
    versionName: '0.1.6',
    versionCode: 106,
    apkFile: 'cursor-mobile-0.1.6-106.apk',
    sizeBytes: 111360652,
    sha256: 'a'.repeat(64),
    md5: 'b'.repeat(32),
    publishedAt: '2026-10-19T03:04:11.302Z',
    notes: ['x'],
  };
  it('maps latest.json to a public download URL', () => {
    const r = parseGithubLatest(manifest);
    assert.equal(r?.source, 'github');
    assert.equal(
      r?.downloadUrl,
      'https://github.com/KingEGame/cursor-mobile-releases/releases/download/v0.1.6/cursor-mobile-0.1.6-106.apk',
    );
    assert.match(GITHUB_LATEST_URL, /^https:\/\/github\.com\/KingEGame\/cursor-mobile-releases\//);
  });
  it('rejects incomplete, odd or path-traversing manifests', () => {
    assert.equal(parseGithubLatest(null), null);
    assert.equal(parseGithubLatest({ ...manifest, md5: '' }), null);
    assert.equal(parseGithubLatest({ ...manifest, versionCode: 0 }), null);
    assert.equal(parseGithubLatest({ ...manifest, apkFile: '../evil.apk' }), null);
    assert.equal(parseGithubLatest({ ...manifest, apkFile: 'a.zip' }), null);
  });
  it('feeds decideUpdate like a Hub release', () => {
    assert.equal(decideUpdate(102, parseGithubLatest(manifest)).kind, 'available');
    assert.equal(decideUpdate(106, parseGithubLatest(manifest)).kind, 'up-to-date');
  });
});
