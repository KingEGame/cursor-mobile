import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canSend, composerPayload, isPluginOption, mentionChipLabel, modeInfo, sameMention, usableOption } from './composer';

describe('composer helpers', () => {
  it('labels chips the way Cursor shows them', () => {
    assert.equal(mentionChipLabel({ trigger: '@', label: 'AGENTS.md' }), '@AGENTS.md');
    assert.equal(mentionChipLabel({ trigger: '/', label: 'goal' }), '/goal');
  });

  it('knows mode colours and placeholders', () => {
    assert.equal(modeInfo('Ask')?.placeholder, 'Ask a question');
    assert.equal(modeInfo(null), null);
  });

  it('tells plugins apart and hides ones that need setup', () => {
    assert.equal(isPluginOption({ label: 'Memory', detail: 'User MCP server', hint: 'Ready' }), true);
    assert.equal(isPluginOption({ label: 'AGENTS.md', detail: '', hint: '' }), false);
    assert.equal(usableOption({ label: 'GitHub', detail: 'User MCP server', hint: 'Error' }), false);
    assert.equal(usableOption({ label: 'Openseo', detail: 'User MCP server', hint: 'Needs authentication' }), false);
  });

  it('dedupes mentions by trigger, label and folder', () => {
    assert.equal(sameMention({ trigger: '@', label: 'a.ts', detail: 'x' }, { trigger: '@', label: 'a.ts', detail: 'x' }), true);
    assert.equal(sameMention({ trigger: '@', label: 'a.ts', detail: 'x' }, { trigger: '@', label: 'a.ts', detail: 'y' }), false);
  });

  it('sends only what was set, and needs text', () => {
    assert.deepEqual(composerPayload({ mode: null, model: null, mentions: [], images: [] }), {});
    assert.deepEqual(
      composerPayload({ mode: 'Plan', model: 'Auto', mentions: [{ trigger: '/', label: 'goal' }], images: [] }),
      { mode: 'Plan', model: 'Auto', mentions: [{ trigger: '/', label: 'goal' }] },
    );
    assert.equal(canSend('  ', false), false);
    assert.equal(canSend('hi', true), false);
    assert.equal(canSend('hi', false), true);
  });
});
