import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EMPTY_MODELS_BODY,
  EMPTY_MODELS_ERROR,
  MODELS_DISAPPEARED_ERROR,
  modelsDisappearedMessage,
  pickDefaultModelId,
} from './new-session-models';

describe('new-session models (AC-050-03 / AC-050-04)', () => {
  it('pickDefaultModelId returns null on empty catalog', () => {
    assert.equal(pickDefaultModelId([]), null);
  });

  it('pickDefaultModelId prefers default available model', () => {
    assert.equal(
      pickDefaultModelId([
        { id: 'a', available: true, default: false },
        { id: 'b', available: true, default: true },
      ]),
      'b',
    );
  });

  it('empty catalog surfaces no-models UX copy', () => {
    assert.match(EMPTY_MODELS_ERROR, /No models from Hub catalog/);
    assert.match(EMPTY_MODELS_BODY, /No models loaded/);
    assert.equal(modelsDisappearedMessage(0, 0), EMPTY_MODELS_ERROR);
  });

  it('models disappearing mid-flow clears with distinct error (AC-050-04)', () => {
    assert.equal(modelsDisappearedMessage(2, 0), MODELS_DISAPPEARED_ERROR);
    assert.equal(modelsDisappearedMessage(2, 1), null);
  });
});
