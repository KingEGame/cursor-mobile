import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appVersionLabel } from './app-version';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('AC-080-05 app version label', () => {
  it('formats app.json expo.version', () => {
    const appJson = JSON.parse(readFileSync(resolve(root, 'app.json'), 'utf8'));
    const expected = appJson.expo.version as string;
    // Version bumps ship releases; only require x.y.z here.
    assert.match(expected, /^\d+\.\d+\.\d+$/);
    assert.equal(appVersionLabel({ version: expected }), `v${expected}`);
    assert.equal(
      appVersionLabel({ version: expected, build: 1 }),
      `v${expected} (1)`,
    );
    assert.equal(appVersionLabel(), 'v0.1.0');
  });

  it('HealthScreen wires health-app-version from Expo Constants', () => {
    const src = readFileSync(
      resolve(root, 'src/screens/HealthScreen.tsx'),
      'utf8',
    );
    assert.match(src, /testID="health-app-version"/);
    assert.match(src, /resolveAppVersionLabel\(\)/);
    assert.match(src, /Constants\.expoConfig\?\.version/);
    assert.match(src, /from '\.\.\/hub\/app-version'/);
  });
});
