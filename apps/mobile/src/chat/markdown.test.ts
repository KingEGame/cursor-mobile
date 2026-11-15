import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseInline, parseMarkdown } from './markdown';

describe('parseInline', () => {
  it('handles bold, italic, code and links', () => {
    assert.deepEqual(parseInline('a **b** *c* `d` [e](http://x)'), [
      { text: 'a ' },
      { text: 'b', bold: true },
      { text: ' ' },
      { text: 'c', italic: true },
      { text: ' ' },
      { text: 'd', code: true },
      { text: ' ' },
      { text: 'e', link: 'http://x' },
    ]);
  });

  it('nests code inside bold and leaves stray markers alone', () => {
    assert.deepEqual(parseInline('**see `x`**'), [
      { text: 'see ', bold: true },
      { text: 'x', code: true, bold: true },
    ]);
    assert.deepEqual(parseInline('2 * 3 = 6'), [{ text: '2 * 3 = 6' }]);
  });
});

describe('parseMarkdown', () => {
  it('splits a typical agent reply into blocks', () => {
    const blocks = parseMarkdown(
      [
        '**Done.** Removed the model.',
        '',
        '### What changed',
        '- `workhorse`',
        '- `fast`',
        '  1. nested',
        '',
        '| Goal | Feasibility |',
        '|------|-------------|',
        '| Route by credits | **High** |',
        '',
        '```ts',
        'const x = 1;',
        '```',
      ].join('\n'),
    );
    assert.deepEqual(
      blocks.map((b) => b.kind),
      ['paragraph', 'heading', 'list', 'table', 'code'],
    );
    const list = blocks[2];
    assert.ok(list && list.kind === 'list');
    assert.equal(list.items.length, 3);
    assert.equal(list.items[2]!.depth, 1);
    assert.equal(list.items[2]!.ordered, true);
    const table = blocks[3];
    assert.ok(table && table.kind === 'table');
    assert.equal(table.rows.length, 1);
    assert.deepEqual(table.rows[0]![1], [{ text: 'High', bold: true }]);
    const code = blocks[4];
    assert.ok(code && code.kind === 'code');
    assert.equal(code.lang, 'ts');
    assert.equal(code.text, 'const x = 1;');
  });

  it('keeps an unterminated code fence as code instead of dropping text', () => {
    const blocks = parseMarkdown('```\nhalf written');
    assert.deepEqual(blocks, [{ kind: 'code', lang: null, text: 'half written' }]);
  });

  it('treats a lone pipe line as a paragraph, not a table', () => {
    assert.equal(parseMarkdown('| not a table |')[0]!.kind, 'paragraph');
  });
});
