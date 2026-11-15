import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dayLabel, formatElapsed, formatMessageTime, lastToolStep, looksLikePath, sameDay, truncateMiddle } from './format';

const now = new Date('2026-10-17T12:00:00');

describe('time formatting', () => {
  it('labels days', () => {
    assert.equal(dayLabel('2026-10-17T08:00:00', now), 'Today');
    assert.equal(dayLabel('2026-10-16T23:00:00', now), 'Yesterday');
    assert.match(dayLabel('2026-10-01T08:00:00', now), /Oct/);
    assert.equal(dayLabel('nope', now), '');
  });
  it('prefixes older messages with the day', () => {
    assert.match(formatMessageTime('2026-10-16T09:05:00', now), /^Yesterday /);
    assert.doesNotMatch(formatMessageTime('2026-10-17T09:05:00', now), /Yesterday|Oct/);
    assert.equal(formatMessageTime(null, now), '');
  });
  it('detects same day', () => {
    assert.equal(sameDay('2026-10-17T01:00:00', '2026-10-17T23:00:00'), true);
    assert.equal(sameDay('2026-10-17T01:00:00', '2026-10-18T01:00:00'), false);
  });
  it('formats elapsed time', () => {
    assert.equal(formatElapsed(42_000), '42s');
    assert.equal(formatElapsed(185_000), '3m 05s');
    assert.equal(formatElapsed(3_720_000), '1h 02m');
  });
  it('finds the latest tool step of the current turn only', () => {
    assert.equal(lastToolStep([{ role: 'user', content: 'hi' }, { role: 'system', content: 'Used grep' }]), 'Used grep');
    assert.equal(lastToolStep([{ role: 'system', content: 'Used grep' }, { role: 'user', content: 'next' }]), null);
  });
});

describe('path pills', () => {
  it('recognizes paths and file names, not commands', () => {
    assert.equal(looksLikePath('apps/mobile/App.tsx'), true);
    assert.equal(looksLikePath('theme.ts'), true);
    assert.equal(looksLikePath('C:\\Users\\a'), true);
    assert.equal(looksLikePath('npm run test'), false);
    assert.equal(looksLikePath('useState'), false);
  });
  it('truncates the middle and keeps the file name', () => {
    const p = 'apps/mobile/src/screens/very/deep/folder/HistoryReadScreen.tsx';
    const t = truncateMiddle(p, 30);
    assert.equal(t.length, 30);
    assert.match(t, /^apps\/.*….*Screen\.tsx$/);
    assert.equal(truncateMiddle('a/b.ts', 30), 'a/b.ts');
  });
});
