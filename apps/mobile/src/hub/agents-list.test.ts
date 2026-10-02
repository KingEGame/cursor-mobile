import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentRowMeta, agentsSyncHint, countWaiting, filterAgents } from './agents-list';
import type { AgentsChatRow, AgentsResponse } from './types';

function chat(partial: Partial<AgentsChatRow> & Pick<AgentsChatRow, 'title'>): AgentsChatRow {
  return {
    sessionId: `hist_${partial.title}`,
    composerId: partial.title,
    ageLabel: '7d',
    updatedAt: null,
    status: 'idle',
    unread: false,
    linesAdded: 0,
    linesRemoved: 0,
    activeOnPc: false,
    ...partial,
  };
}

const res: AgentsResponse = {
  source: 'sidebar',
  note: null,
  scannedAt: '2026-10-01T21:00:00.000Z',
  projects: [
    {
      projectId: 'workspace:a',
      name: 'omnitouter',
      path: '/data/projects/omnitouter',
      hasMore: false,
      expanded: true,
      chats: [chat({ title: 'Omnitouter and Laya project', status: 'waiting_approval' })],
    },
    {
      projectId: 'workspace:b',
      name: 'cursor_mobile',
      path: '/data/projects/cursor_mobile',
      hasMore: true,
      expanded: false,
      chats: [
        chat({ title: 'UI/UX planning discussion', linesAdded: 620, linesRemoved: 72 }),
        chat({ title: 'Mobile app for PC control', status: 'working', activeOnPc: true }),
      ],
    },
  ],
};

describe('agentRowMeta', () => {
  it('puts status first, then lines changed, then PC focus', () => {
    assert.equal(agentRowMeta(res.projects[0]!.chats[0]!), 'Waiting for approval');
    assert.equal(agentRowMeta(res.projects[1]!.chats[0]!), '+620 −72');
    assert.equal(agentRowMeta(res.projects[1]!.chats[1]!), 'Working · Open on PC');
    assert.equal(agentRowMeta(chat({ title: 'x' })), '');
  });
});

describe('agentsSyncHint', () => {
  it('counts projects and chats and names the source', () => {
    assert.equal(agentsSyncHint(res), '2 projects · 3 chats from Cursor on this PC');
    assert.match(agentsSyncHint({ ...res, source: 'history' }), /from PC history/);
  });
});

describe('countWaiting', () => {
  it('counts chats waiting for approval across projects', () => {
    assert.equal(countWaiting(res), 1);
    assert.equal(countWaiting(null), 0);
  });
});

describe('filterAgents', () => {
  it('matches chat titles and keeps whole projects matched by name', () => {
    assert.deepEqual(
      filterAgents(res, 'mobile app').projects.map((p) => p.chats.map((c) => c.title)),
      [['Mobile app for PC control']],
    );
    assert.equal(filterAgents(res, 'OMNI').projects[0]!.chats.length, 1);
    assert.equal(filterAgents(res, '  ').projects.length, 2);
    assert.equal(filterAgents(res, 'zzz').projects.length, 0);
  });
});
