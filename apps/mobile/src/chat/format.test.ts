import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dayLabel, formatElapsed, formatMessageTime, lastToolStep, looksLikePath, sameDay, truncateMiddle } from './format';
import { addOutgoing, deliveryLabel, dropOutgoing, markFailed, markSent, reconcile } from './outgoing';

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

describe('outgoing message lifecycle', () => {
  it('goes sending → failed → dropped, and sent ones reconcile with the transcript', () => {
    let list = addOutgoing([], 'hello', {}, 'a');
    assert.equal(list[0]!.state, 'sending');
    list = markFailed(list, 'a', 'Cursor is stuck', true);
    assert.match(deliveryLabel(list[0]!), /^Not sent — Cursor is stuck/);
    assert.match(deliveryLabel({ state: 'failed', reason: 'x', definitelyNotSent: false }), /^May not have sent/);
    list = markSent(list, 'a');
    assert.equal(reconcile(list, [{ role: 'user', content: 'hello' }]).length, 0);
    assert.equal(reconcile(list, [{ role: 'user', content: 'other' }]).length, 1);
    assert.equal(dropOutgoing(list, 'a').length, 0);
  });
  it('keeps a failed message when only an older identical message exists', () => {
    const list = markFailed(addOutgoing([], 'hello', {}, 'a', Date.parse('2026-10-17T10:00:00Z')), 'a', 'r', true);
    const old = [{ role: 'user', content: 'hello', createdAt: '2026-10-16T10:00:00Z' }];
    assert.equal(reconcile(list, old).length, 1);
  });
  it('drops a failed message once the transcript shows it arrived after the send', () => {
    const list = markFailed(addOutgoing([], 'hello', {}, 'a', Date.parse('2026-10-17T10:00:00Z')), 'a', 'r', false);
    const fresh = [{ role: 'user', content: 'hello', createdAt: '2026-10-17T10:00:05Z' }];
    assert.equal(reconcile(list, fresh).length, 0);
    assert.equal(reconcile(list, [{ role: 'user', content: 'hello' }]).length, 1);
  });
});

import { stabilize } from './stable';
describe('stabilize', () => {
  const m = (id: string, content = 'x') => ({ id, content, createdAt: 't' });
  it('returns the same array when nothing changed', () => {
    const prev = [m('a'), m('b')];
    assert.equal(stabilize(prev, [m('a'), m('b')]), prev);
  });
  it('reuses unchanged messages and replaces changed ones', () => {
    const prev = [m('a'), m('b')];
    const out = stabilize(prev, [m('a'), m('b', 'edited'), m('c')]);
    assert.notEqual(out, prev);
    assert.equal(out[0], prev[0]);
    assert.equal(out[1]!.content, 'edited');
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
