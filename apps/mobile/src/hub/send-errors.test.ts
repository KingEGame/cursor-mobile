import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SEND_FAILURES, describeSendFailure, sendFailureText } from './send-errors';

describe('send failure catalog', () => {
  it('covers every code the Hub send routes can return', () => {
    for (const code of [
      'CHAT_NOT_IN_SIDEBAR', 'CHAT_SWITCH_FAILED', 'MODE_NOT_APPLIED', 'MODEL_NOT_APPLIED', 'SEND_NOT_CONFIRMED',
      'MENTION_NOT_APPLIED', 'IMAGE_NOT_APPLIED'.replace('APPLIED', 'ATTACHED'), 'COMPOSER_NOT_EMPTY',
      'CURSOR_WINDOW_HIDDEN', 'CURSOR_NEEDS_RELOAD', 'CDP_UNAVAILABLE', 'CDP_INPUT_FAILED', 'EXTRACTOR_STALE', 'NETWORK_ERROR', 'NOT_PAIRED',
    ]) {
      assert.ok(SEND_FAILURES[code], code);
    }
  });
  it('only queues failures that are certainly unsent and transient', () => {
    for (const [code, info] of Object.entries(SEND_FAILURES)) {
      if (info.queueable) assert.ok(code === 'NETWORK_ERROR' || info.definitelyNotSent, code);
    }
    assert.equal(describeSendFailure('SEND_NOT_CONFIRMED').queueable, false);
  });
  it('falls back by HTTP status and keeps Hub detail for unknown codes', () => {
    assert.match(describeSendFailure('???', 401).message, /pair/i);
    assert.match(sendFailureText('WEIRD', 418, 'teapot'), /teapot/);
  });
});
