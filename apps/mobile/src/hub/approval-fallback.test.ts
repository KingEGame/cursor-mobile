import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  approvalCardShowsActions,
  normalizeApprovalForCard,
} from './approval-fallback';

describe('approval-fallback (AC-062-02)', () => {
  it('unknown tool shape still yields denyable pending card', () => {
    const card = normalizeApprovalForCard({
      approvalId: 'apr_unknown_1',
      sessionId: 'sess_live_x',
      tool: { weird: true },
      argsPreview: { nested: { x: 1 } },
    });
    assert.ok(card);
    assert.equal(card!.tool.name, 'Unknown tool');
    assert.equal(card!.tool.kind, 'unknown');
    assert.equal(card!.status, 'pending');
    assert.equal(approvalCardShowsActions(card!), true);
    assert.match(card!.summary, /Unrecognized tool shape|approve or deny/i);
  });

  it('rejects payloads without approval id (fail-closed)', () => {
    assert.equal(normalizeApprovalForCard({ tool: { name: 'Shell' } }), null);
  });
});
