import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildNewSessionDeepLink,
  isNewSessionAutoCreate,
  normalizeAttachPaths,
  parseNewSessionDeepLink,
} from './new-session-deep-link';

describe('parseNewSessionDeepLink', () => {
  it('returns null for unrelated schemes', () => {
    assert.equal(parseNewSessionDeepLink('cursor-companion://health'), null);
    assert.equal(parseNewSessionDeepLink('cursor-companion://pair?code=1'), null);
  });

  it('accepts bare new path', () => {
    assert.deepEqual(parseNewSessionDeepLink('cursor-companion://new'), {});
    assert.deepEqual(parseNewSessionDeepLink('new'), {});
  });

  it('parses prompt + model + repeated attach + auto (adb UAT)', () => {
    const url =
      'cursor-companion://new?prompt=adb-new-session-20260930' +
      '&model=auto' +
      '&attach=%2Fdata%2Fprojects%2Fcursor_mobile%2Fpackage.json' +
      '&attach=%2Fdata%2Fprojects%2Fcursor_mobile%2FREADME.md' +
      '&auto=1';
    const params = parseNewSessionDeepLink(url);
    assert.ok(params);
    assert.equal(params.prompt, 'adb-new-session-20260930');
    assert.equal(params.model, 'auto');
    assert.deepEqual(params.attach, [
      '/data/projects/cursor_mobile/package.json',
      '/data/projects/cursor_mobile/README.md',
    ]);
    assert.equal(params.auto, '1');
    assert.equal(isNewSessionAutoCreate(params), true);
  });

  it('parses path form new?query used by getStateFromPath', () => {
    const params = parseNewSessionDeepLink(
      'new?prompt=hello%20world&model=auto&auto=1',
    );
    assert.ok(params);
    assert.equal(params.prompt, 'hello world');
    assert.equal(params.model, 'auto');
  });

  it('comma-separated attach still works', () => {
    const params = parseNewSessionDeepLink(
      'cursor-companion://new?prompt=p&attach=/a/package.json,/b/README.md&auto=1',
    );
    assert.ok(params);
    assert.deepEqual(params.attach, ['/a/package.json', '/b/README.md']);
  });
});

describe('isNewSessionAutoCreate', () => {
  it('defaults on when prompt present', () => {
    assert.equal(isNewSessionAutoCreate({ prompt: 'x' }), true);
  });

  it('respects auto=0', () => {
    assert.equal(isNewSessionAutoCreate({ prompt: 'x', auto: '0' }), false);
  });

  it('false without prompt and without auto=1', () => {
    assert.equal(isNewSessionAutoCreate({ model: 'auto' }), false);
  });
});

describe('buildNewSessionDeepLink', () => {
  it('round-trips through parse', () => {
    const url = buildNewSessionDeepLink({
      prompt: 'adb-new-session-test',
      model: 'auto',
      attach: [
        '/data/projects/cursor_mobile/package.json',
        '/data/projects/cursor_mobile/README.md',
      ],
    });
    assert.match(url, /^cursor-companion:\/\/new\?/);
    assert.equal(url.toLowerCase().includes('http'), false);
    const params = parseNewSessionDeepLink(url);
    assert.equal(params?.prompt, 'adb-new-session-test');
    assert.equal(params?.model, 'auto');
    assert.deepEqual(params?.attach, [
      '/data/projects/cursor_mobile/package.json',
      '/data/projects/cursor_mobile/README.md',
    ]);
    assert.equal(isNewSessionAutoCreate(params), true);
  });
});

describe('normalizeAttachPaths', () => {
  it('handles array and comma string', () => {
    assert.deepEqual(normalizeAttachPaths(['/a', ' /b ']), ['/a', '/b']);
    assert.deepEqual(normalizeAttachPaths('/a,/b'), ['/a', '/b']);
    assert.deepEqual(normalizeAttachPaths(null), []);
  });
});
