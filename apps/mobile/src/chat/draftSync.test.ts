import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideDraft } from './draftSync';

describe('decideDraft', () => {
  it('does nothing when the chat is not open on the PC', () => {
    assert.deepEqual(decideDraft({ local: 'abc', pc: null, base: '' }), { kind: 'none', base: '' });
  });
  it('does nothing when both sides already match, and records it as the new base', () => {
    assert.deepEqual(decideDraft({ local: 'a  b', pc: 'a b', base: '' }), { kind: 'none', base: 'a b' });
  });
  it('adopts text typed on the PC when the phone box is untouched', () => {
    assert.deepEqual(decideDraft({ local: '', pc: 'de rc', base: '' }), { kind: 'adopt', text: 'de rc' });
    assert.deepEqual(decideDraft({ local: 'hello', pc: 'hello world', base: 'hello' }), { kind: 'adopt', text: 'hello world' });
  });
  it('pushes text typed on the phone when the PC box is untouched', () => {
    assert.deepEqual(decideDraft({ local: 'from phone', pc: '', base: '' }), { kind: 'push', text: 'from phone' });
  });
  it('lets the PC clear the phone box when the PC text was sent or deleted', () => {
    assert.deepEqual(decideDraft({ local: 'hello', pc: '', base: 'hello' }), { kind: 'adopt', text: '' });
  });
  it('never overwrites when both sides changed differently', () => {
    assert.deepEqual(decideDraft({ local: 'mine', pc: 'theirs', base: 'old' }), { kind: 'conflict', pc: 'theirs', local: 'mine' });
    assert.deepEqual(decideDraft({ local: 'mine', pc: 'theirs', base: '' }), { kind: 'conflict', pc: 'theirs', local: 'mine' });
  });
});
