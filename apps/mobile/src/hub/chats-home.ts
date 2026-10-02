/**
 * Pure helpers for Gemini-style Chats home (project section + recent sessions).
 * Bound to PC Hub workspace / history only — never invents cloud projects.
 */

import type { CompanionConnectionState } from './connection-state';
import type { SessionListItem, WorkspaceResponse } from './types';
import { isWorkspaceBound } from './types';

export type ConnectionChipTone = 'online' | 'degraded' | 'offline' | 'pair';

export interface ConnectionChipView {
  label: 'Online' | 'Degraded' | 'Offline' | 'Pair';
  tone: ConnectionChipTone;
}

/** Quiet chip copy from companion connection state. */
export function connectionChipFromState(
  state: CompanionConnectionState,
): ConnectionChipView {
  switch (state) {
    case 'Ready':
      return { label: 'Online', tone: 'online' };
    case 'Unpaired':
    case 'Revoked':
      return { label: 'Pair', tone: 'pair' };
    case 'Queuing':
    case 'CDPOff':
    case 'SenderBlocked':
    case 'CursorDown':
      return { label: 'Degraded', tone: 'degraded' };
    case 'TailscaleDown':
    case 'HubDown':
      return { label: 'Offline', tone: 'offline' };
    case 'Unknown':
      return { label: 'Offline', tone: 'offline' };
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

export interface ProjectSection {
  workspaceId: string;
  name: string;
  path: string | null;
  /** True when this is the Hub-bound open project on the PC. */
  isOpenOnPc: boolean;
  sessions: SessionListItem[];
  pendingApprovals: number;
}

/** Merge live + history lists, de-dupe by id, newest first. */
export function mergeSessionsByRecency(
  ...lists: SessionListItem[][]
): SessionListItem[] {
  const byId = new Map<string, SessionListItem>();
  for (const list of lists) {
    for (const item of list) {
      const prev = byId.get(item.id);
      if (!prev || Date.parse(item.updatedAt) >= Date.parse(prev.updatedAt)) {
        byId.set(item.id, item);
      }
    }
  }
  return [...byId.values()].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
}

/**
 * Build a single Gemini-like project section from Hub workspace + sessions.
 * Extra workspaceIds from history still group under their own quiet headers.
 */
export function buildProjectSections(opts: {
  workspace: WorkspaceResponse | null;
  sessions: SessionListItem[];
}): ProjectSection[] {
  const { workspace, sessions } = opts;
  const groups = new Map<string, SessionListItem[]>();
  for (const s of sessions) {
    const key = s.workspaceId || '_unknown';
    const bucket = groups.get(key) ?? [];
    bucket.push(s);
    groups.set(key, bucket);
  }

  const sections: ProjectSection[] = [];
  const boundId =
    workspace && isWorkspaceBound(workspace) ? workspace.workspaceId : null;

  if (boundId) {
    const items = groups.get(boundId) ?? [];
    groups.delete(boundId);
    sections.push({
      workspaceId: boundId,
      name: workspace && isWorkspaceBound(workspace) ? workspace.name : 'Project',
      path: workspace && isWorkspaceBound(workspace) ? workspace.path : null,
      isOpenOnPc: true,
      sessions: items,
      pendingApprovals: items.reduce((n, s) => n + (s.pendingApprovals || 0), 0),
    });
  }

  for (const [workspaceId, items] of groups) {
    const rawName = workspaceId === '_unknown' ? 'Other' : workspaceId;
    sections.push({
      workspaceId,
      name: rawName.length > 48 ? `${rawName.slice(0, 47)}…` : rawName,
      path: null,
      isOpenOnPc: false,
      sessions: items,
      pendingApprovals: items.reduce((n, s) => n + (s.pendingApprovals || 0), 0),
    });
  }

  return sections;
}

/** Soft empty-state copy when no chats yet. */
export function chatsEmptyCopy(bound: boolean): {
  title: string;
  body: string;
  cta: string;
} {
  if (!bound) {
    return {
      title: 'No project on PC',
      body: 'Open a folder in Cursor on the PC. This app remotes that project only.',
      cta: 'Check Health',
    };
  }
  return {
    title: 'No chats yet',
    body: 'Start a new chat to continue in the project open on your PC.',
    cta: 'New chat',
  };
}

/** Compact mode hint under a chat title (not a loud badge). */
export function chatModeHint(mode: string | null | undefined): string {
  if (mode === 'live') return 'Live';
  if (mode === 'history') return 'History';
  if (mode === 'editor') return 'Editor';
  return '';
}
