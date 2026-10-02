import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  attachmentPathForItem,
  debounce,
  formatPickerRowLabel,
  joinRelative,
  matchRootLabel,
  pathBreadcrumbs,
  rootDisplayName,
  rootQueryForHub,
  toggleAttachment,
  FILE_SEARCH_DEBOUNCE_MS,
} from './helpers';
import type { WorkspaceFileItem, WorkspaceRoot } from '../hub/types';

describe('pathBreadcrumbs', () => {
  it('returns workspace hop for empty path', () => {
    assert.deepEqual(pathBreadcrumbs(''), [{ label: 'Workspace', path: '' }]);
    assert.deepEqual(pathBreadcrumbs('/'), [{ label: 'Workspace', path: '' }]);
  });

  it('builds cumulative segments', () => {
    const crumbs = pathBreadcrumbs('docs/architecture/AGENT-CONTEXT.md', 'cursor_mobile');
    assert.deepEqual(crumbs, [
      { label: 'cursor_mobile', path: '' },
      { label: 'docs', path: 'docs' },
      { label: 'architecture', path: 'docs/architecture' },
      { label: 'AGENT-CONTEXT.md', path: 'docs/architecture/AGENT-CONTEXT.md' },
    ]);
  });

  it('normalizes leading slashes', () => {
    const crumbs = pathBreadcrumbs('/apps/mobile/App.tsx');
    assert.equal(crumbs[crumbs.length - 1]?.path, 'apps/mobile/App.tsx');
  });
});

describe('root helpers', () => {
  const roots: WorkspaceRoot[] = [
    { name: 'cursor_mobile', path: '/data/projects/cursor_mobile' },
    { name: 'packages', path: '/data/projects/cursor_mobile/packages' },
  ];

  it('rootDisplayName prefers name', () => {
    assert.equal(rootDisplayName(roots[0]!), 'cursor_mobile');
    assert.equal(
      rootDisplayName({ name: '', path: '/tmp/foo/bar' }),
      'bar',
    );
  });

  it('rootQueryForHub omits filter for primary workspace path', () => {
    assert.equal(
      rootQueryForHub(roots[0]!, '/data/projects/cursor_mobile'),
      undefined,
    );
  });

  it('rootQueryForHub returns relative subpath for nested root', () => {
    assert.equal(
      rootQueryForHub(roots[1]!, '/data/projects/cursor_mobile'),
      'packages',
    );
  });

  it('rootQueryForHub uses name for sibling roots outside primary', () => {
    const sibling: WorkspaceRoot = {
      name: 'shared_docs',
      path: '/data/shared/docs',
    };
    assert.equal(
      rootQueryForHub(sibling, '/data/projects/cursor_mobile'),
      'shared_docs',
    );
  });

  it('attachmentPathForItem prefixes sibling root name', () => {
    const siblingRoots: WorkspaceRoot[] = [
      { name: 'cursor_mobile', path: '/data/projects/cursor_mobile' },
      { name: 'shared_docs', path: '/data/shared/docs' },
    ];
    const item: WorkspaceFileItem = {
      path: 'readme.md',
      rootPath: '/data/shared/docs',
      kind: 'file',
    };
    assert.equal(
      attachmentPathForItem(item, siblingRoots, '/data/projects/cursor_mobile'),
      'shared_docs:readme.md',
    );
    assert.equal(
      attachmentPathForItem(
        { path: 'package.json', rootPath: '/data/projects/cursor_mobile' },
        siblingRoots,
        '/data/projects/cursor_mobile',
      ),
      'package.json',
    );
  });

  it('matchRootLabel only when multi-root', () => {
    const item: WorkspaceFileItem = {
      path: 'hub/package.json',
      rootPath: '/data/projects/cursor_mobile/packages',
      kind: 'file',
    };
    assert.equal(matchRootLabel(item, [roots[0]!]), null);
    assert.equal(matchRootLabel(item, roots), 'packages');
  });

  it('formatPickerRowLabel includes root subtitle when multi-root', () => {
    const item: WorkspaceFileItem = {
      path: 'hub/package.json',
      rootPath: '/data/projects/cursor_mobile/packages',
      kind: 'file',
    };
    const multi = formatPickerRowLabel(item, roots);
    assert.equal(multi.title, 'hub/package.json');
    assert.equal(multi.subtitle, 'Root: packages');
    const single = formatPickerRowLabel(item, [roots[0]!]);
    assert.equal(single.subtitle, null);
  });
});

describe('toggleAttachment / joinRelative', () => {
  it('toggles paths immutably', () => {
    const a = toggleAttachment([], 'a.ts');
    assert.deepEqual(a, ['a.ts']);
    const b = toggleAttachment(a, 'b.ts');
    assert.deepEqual(b, ['a.ts', 'b.ts']);
    const c = toggleAttachment(b, 'a.ts');
    assert.deepEqual(c, ['b.ts']);
    assert.deepEqual(a, ['a.ts']);
  });

  it('joins relative segments', () => {
    assert.equal(joinRelative('', 'docs'), 'docs');
    assert.equal(joinRelative('docs', 'architecture'), 'docs/architecture');
    assert.equal(joinRelative('/docs/', '/x.md'), 'docs/x.md');
  });
});

describe('debounce', () => {
  it('defaults wait to FILE_SEARCH_DEBOUNCE_MS', () => {
    assert.equal(FILE_SEARCH_DEBOUNCE_MS, 300);
  });

  it('fires once after wait and cancel prevents call', async () => {
    let count = 0;
    const d = debounce(() => {
      count += 1;
    }, 40);
    d();
    d();
    d();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(count, 1);

    d();
    d.cancel();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(count, 1);
  });
});
