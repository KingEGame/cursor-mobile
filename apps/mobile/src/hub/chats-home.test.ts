import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildProjectSections,
  chatModeHint,
  chatsEmptyCopy,
  connectionChipFromState,
  mergeSessionsByRecency,
} from './chats-home';
import type { SessionListItem, WorkspaceBound } from './types';

function session(
  partial: Partial<SessionListItem> & Pick<SessionListItem, 'id' | 'workspaceId'>,
): SessionListItem {
  return {
    mode: 'live',
    title: partial.title ?? partial.id,
    preview: null,
    model: null,
    updatedAt: partial.updatedAt ?? '2026-10-01T12:00:00.000Z',
    createdAt: '2026-10-01T11:00:00.000Z',
    pendingApprovals: partial.pendingApprovals ?? 0,
    ...partial,
  };
}

describe('chats-home (Gemini-style list helpers)', () => {
  it('connection chip maps Ready → Online and Unpaired → Pair', () => {
    assert.deepEqual(connectionChipFromState('Ready'), {
      label: 'Online',
      tone: 'online',
    });
    assert.deepEqual(connectionChipFromState('Unpaired'), {
      label: 'Pair',
      tone: 'pair',
    });
    assert.deepEqual(connectionChipFromState('HubDown'), {
      label: 'Offline',
      tone: 'offline',
    });
    assert.deepEqual(connectionChipFromState('CDPOff'), {
      label: 'Degraded',
      tone: 'degraded',
    });
  });

  it('mergeSessionsByRecency de-dupes and sorts newest first', () => {
    const a = session({
      id: 'a',
      workspaceId: 'w1',
      updatedAt: '2026-10-01T10:00:00.000Z',
    });
    const b = session({
      id: 'b',
      workspaceId: 'w1',
      updatedAt: '2026-10-01T12:00:00.000Z',
    });
    const a2 = session({
      id: 'a',
      workspaceId: 'w1',
      title: 'newer a',
      updatedAt: '2026-10-01T13:00:00.000Z',
    });
    const merged = mergeSessionsByRecency([a, b], [a2]);
    assert.equal(merged.length, 2);
    assert.equal(merged[0]!.id, 'a');
    assert.equal(merged[0]!.title, 'newer a');
    assert.equal(merged[1]!.id, 'b');
  });

  it('buildProjectSections puts bound PC project first', () => {
    const ws: WorkspaceBound = {
      workspaceId: 'w-open',
      name: 'cursor_mobile',
      path: '/data/projects/cursor_mobile',
      roots: [{ name: 'cursor_mobile', path: '/data/projects/cursor_mobile' }],
      windowId: 'win1',
      windows: [],
      updatedAt: '2026-10-01T12:00:00.000Z',
    };
    const sections = buildProjectSections({
      workspace: ws,
      sessions: [
        session({ id: '1', workspaceId: 'w-open', title: 'Live chat' }),
        session({
          id: '2',
          workspaceId: 'other',
          mode: 'history',
          title: 'Old',
        }),
      ],
    });
    assert.equal(sections[0]!.workspaceId, 'w-open');
    assert.equal(sections[0]!.isOpenOnPc, true);
    assert.equal(sections[0]!.name, 'cursor_mobile');
    assert.equal(sections.length, 2);
  });

  it('empty copy stays PC-local (no cloud picker)', () => {
    const unbound = chatsEmptyCopy(false);
    assert.match(unbound.body, /Open a folder in Cursor on the PC/);
    assert.match(unbound.cta, /Health/i);
    const bound = chatsEmptyCopy(true);
    assert.match(bound.cta, /New chat/i);
  });

  it('chatModeHint is quiet text, not a invented cloud mode', () => {
    assert.equal(chatModeHint('live'), 'Live');
    assert.equal(chatModeHint('history'), 'History');
    assert.equal(chatModeHint('cloud'), '');
  });
});
