import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  filterSessionsForTab,
  historyTabNote,
  HISTORY_LIST_LIMIT,
  modelSourceLabel,
  sessionsListQueryOpts,
} from './history-list';
import type { SessionListItem, SessionListResponse } from './types';

function item(partial: Partial<SessionListItem> & Pick<SessionListItem, 'id' | 'mode'>): SessionListItem {
  return {
    workspaceId: 'ws_x',
    title: partial.title ?? partial.id,
    preview: null,
    model: null,
    updatedAt: '2026-09-25T18:00:00.000Z',
    createdAt: '2026-09-25T17:00:00.000Z',
    pendingApprovals: 0,
    ...partial,
  };
}

describe('history-list helpers', () => {
  it('sessionsListQueryOpts requests mode=history with page limit', () => {
    assert.deepEqual(sessionsListQueryOpts('history'), {
      mode: 'history',
      limit: HISTORY_LIST_LIMIT,
      tolerateMissing: true,
    });
    assert.equal(sessionsListQueryOpts('live').mode, 'live');
  });

  it('filterSessionsForTab keeps history rows only', () => {
    const items = [
      item({ id: 'live_1', mode: 'live' }),
      item({ id: 'hist_1', mode: 'history', title: 'Past chat' }),
    ];
    const hist = filterSessionsForTab(items, 'history');
    assert.equal(hist.length, 1);
    assert.equal(hist[0]?.id, 'hist_1');
  });

  it('historyTabNote surfaces bind totals and empty reasons', () => {
    const empty: SessionListResponse = {
      workspaceId: 'ws_x',
      items: [],
      nextCursor: null,
      history: {
        ok: true,
        extractorStale: false,
        sessionCountForBind: 0,
        lastScanAt: null,
        reason: 'No local history rows for bound workspace',
      },
    };
    assert.match(historyTabNote(empty, 0) ?? '', /No local history rows/);

    const full: SessionListResponse = {
      workspaceId: 'ws_x',
      items: [item({ id: 'hist_1', mode: 'history' })],
      nextCursor: null,
      history: {
        ok: true,
        extractorStale: false,
        sessionCountForBind: 46,
        lastScanAt: '2026-09-25T18:00:00.000Z',
      },
    };
    assert.match(historyTabNote(full, 1) ?? '', /Showing 1 of 46/);
    assert.match(historyTabNote(full, 46) ?? '', /46 local history/);
  });

  it('modelSourceLabel stays honest about DESIGNED stubs', () => {
    assert.match(modelSourceLabel('env_stub_default'), /Not scraped from Cursor CDP/i);
    assert.match(
      modelSourceLabel('env', 'DESIGNED: from CURSOR_MODELS'),
      /CURSOR_MODELS/,
    );
    assert.match(modelSourceLabel('cdp_scrape'), /scraped from Cursor Composer/i);
  });
});
