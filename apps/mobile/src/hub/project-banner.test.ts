import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BANNER_PATH_NUMBER_OF_LINES,
  LONG_PATH_UAT_MIN_CHARS,
  bannerPathDisplay,
} from './project-banner';

describe('project banner path (AC-011-03)', () => {
  it('keeps full Hub path (no client truncation of payload)', () => {
    const long =
      '/data/projects/' +
      'very_long_segment_'.repeat(12) +
      'cursor_mobile_nested';
    assert.ok(long.length >= LONG_PATH_UAT_MIN_CHARS);
    assert.equal(bannerPathDisplay(long), long);
  });

  it('UI clamps path to two lines (wrap/truncate)', () => {
    assert.equal(BANNER_PATH_NUMBER_OF_LINES, 2);
  });
});
