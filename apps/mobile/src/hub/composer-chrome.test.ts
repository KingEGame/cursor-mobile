import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AGENT_MODE_OPTIONS,
  agentModeLabel,
  composerOverflowItems,
  defaultAgentMode,
  isAgentModeId,
} from './composer-chrome';

describe('composer-chrome (Gemini-style + sheet)', () => {
  it('default agent mode is agent', () => {
    assert.equal(defaultAgentMode(), 'agent');
    assert.equal(agentModeLabel('ask'), 'Ask');
  });

  it('overflow keeps attach wired and mic/camera designed', () => {
    const items = composerOverflowItems({ attachAvailable: true });
    assert.equal(items.find((i) => i.id === 'attach')?.status, 'wired');
    assert.equal(items.find((i) => i.id === 'mic')?.status, 'designed');
    assert.equal(items.find((i) => i.id === 'camera')?.status, 'designed');
    assert.equal(items.find((i) => i.id === 'mention')?.status, 'partial');
  });

  it('all agent mode ids are create-session strings (not CDP-verified claims)', () => {
    for (const m of AGENT_MODE_OPTIONS) {
      assert.equal(isAgentModeId(m.id), true);
      assert.equal(m.liveSwitch, 'designed');
      assert.equal(m.createWired, true);
    }
    assert.equal(isAgentModeId('cloud'), false);
  });
});
