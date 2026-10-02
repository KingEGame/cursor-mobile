import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canOpenSessionFromList,
  liveEmptyListGuidance,
  normalizeSessionMode,
  sessionModeBadgeLabel,
  unboundWorkspaceCreateGuidance,
} from './session-list-ux';

describe('session-list-ux (AC-020-04 / AC-021 / AC-053-04)', () => {
  it('AC-021-01 mode badge labels live and history', () => {
    assert.equal(sessionModeBadgeLabel('live'), 'live');
    assert.equal(sessionModeBadgeLabel('history'), 'history');
  });

  it('AC-021-02 unknown mode is safe fallback (no open, badge unknown)', () => {
    assert.equal(normalizeSessionMode('cloud_agent'), 'unknown');
    assert.equal(normalizeSessionMode(null), 'unknown');
    assert.equal(sessionModeBadgeLabel('cloud_agent'), 'unknown');
    assert.equal(canOpenSessionFromList('cloud_agent'), false);
    assert.equal(canOpenSessionFromList('live'), true);
    assert.equal(canOpenSessionFromList('history'), true);
  });

  it('AC-020-04 empty live list keeps New session CTA', () => {
    const g = liveEmptyListGuidance({
      degraded: false,
      note: 'No live sessions for this project yet.',
    });
    assert.match(g.body, /No live sessions/);
    assert.equal(g.showNewSessionCta, true);
    assert.match(g.ctaLabel, /new session/i);
  });

  it('AC-053-04 unbound create guidance points at PC project', () => {
    assert.match(unboundWorkspaceCreateGuidance(), /Open a project in Cursor on the PC/);
  });
});
