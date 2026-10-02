import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TAILSCALE_SETUP_STEPS,
  formatTailscaleSetupSteps,
  shouldShowTailscaleGuide,
} from './tailscale-guide';

describe('tailscale-guide', () => {
  it('lists Tailscale-first steps before Hub URL', () => {
    assert.ok(TAILSCALE_SETUP_STEPS.length >= 4);
    const blob = formatTailscaleSetupSteps().toLowerCase();
    assert.match(blob, /tailscale/);
    assert.match(blob, /tail246b3f/);
    assert.match(blob, /hub url/);
    assert.ok(!blob.includes('9222'), 'must not mention CDP port on phone');
    assert.ok(!blob.includes('ngrok'), 'must not suggest ngrok');
  });

  it('shows guide before pair and when Hub unreachable', () => {
    assert.equal(shouldShowTailscaleGuide({ beforePair: true }), true);
    assert.equal(shouldShowTailscaleGuide({ hubUnreachable: true }), true);
    assert.equal(
      shouldShowTailscaleGuide({ connectionState: 'TailscaleDown' }),
      true,
    );
    assert.equal(shouldShowTailscaleGuide({ connectionState: 'HubDown' }), true);
    assert.equal(shouldShowTailscaleGuide({ connectionState: 'Unknown' }), true);
    assert.equal(shouldShowTailscaleGuide({ connectionState: 'Ready' }), false);
    assert.equal(shouldShowTailscaleGuide({ connectionState: 'CDPOff' }), false);
    assert.equal(shouldShowTailscaleGuide({}), false);
  });
});
