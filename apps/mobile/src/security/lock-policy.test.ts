import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideLock, parseLockSettings, RELOCK_AFTER_MS, shouldRelock } from './lock-policy';

describe('decideLock', () => {
  it('prompts only when enabled and the phone can authenticate', () => {
    assert.equal(decideLock(false, { hasHardware: true, enrolled: true }), 'skip');
    assert.equal(decideLock(true, { hasHardware: true, enrolled: true }), 'prompt');
    assert.equal(decideLock(true, { hasHardware: true, enrolled: false }), 'unavailable');
    assert.equal(decideLock(true, { hasHardware: false, enrolled: false }), 'unavailable');
  });
});

describe('shouldRelock', () => {
  it('re-locks after five minutes in the background', () => {
    assert.equal(shouldRelock(null, 10), false);
    assert.equal(shouldRelock(0, RELOCK_AFTER_MS - 1), false);
    assert.equal(shouldRelock(0, RELOCK_AFTER_MS), true);
  });
});

describe('parseLockSettings', () => {
  it('defaults lockSend off (feature paused) and survives bad stored data', () => {
    assert.deepEqual(parseLockSettings(null), { lockSend: false, lockOpen: false });
    assert.deepEqual(parseLockSettings('{"lockOpen":true}'), { lockSend: false, lockOpen: true });
    assert.deepEqual(parseLockSettings('{"lockSend":true}'), { lockSend: false, lockOpen: false });
    assert.deepEqual(parseLockSettings('nope'), { lockSend: false, lockOpen: false });
  });
});
