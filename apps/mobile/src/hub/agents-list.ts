import type { AgentChatStatus, AgentsChatRow, AgentsResponse } from './types';

/** Short status label for a chat row; null when there is nothing to say. */
export function agentStatusLabel(status: AgentChatStatus): string | null {
  switch (status) {
    case 'working':
      return 'Working';
    case 'waiting_approval':
      return 'Waiting for approval';
    case 'error':
      return 'Stopped with an error';
    default:
      return null;
  }
}

/** Secondary line under a chat title: status first, then lines changed. */
export function agentRowMeta(chat: AgentsChatRow): string {
  const parts: string[] = [];
  const status = agentStatusLabel(chat.status);
  if (status) parts.push(status);
  if (chat.linesAdded > 0 || chat.linesRemoved > 0) {
    parts.push(`+${chat.linesAdded} −${chat.linesRemoved}`);
  }
  if (chat.activeOnPc) parts.push('Open on PC');
  return parts.join(' · ');
}

/** Sync line under the Chats title. */
export function agentsSyncHint(res: AgentsResponse): string {
  const chats = res.projects.reduce((n, p) => n + p.chats.length, 0);
  const counts = `${res.projects.length} project${res.projects.length === 1 ? '' : 's'} · ${chats} chat${chats === 1 ? '' : 's'}`;
  if (res.source === 'sidebar') return `${counts} from Cursor on this PC`;
  return `${counts} from PC history — Cursor Agents window not readable right now`;
}

/** One-line warning when Cursor on the PC shows an error banner (null when fine). */
export function cursorProblem(res: AgentsResponse | null): string | null {
  const alert = res?.alerts?.find((a) => a.needsReload) ?? res?.alerts?.find((a) => a.error);
  if (!alert) return null;
  return alert.needsReload
    ? `Cursor on your PC shows “${alert.title}”. Click Reload Window in Cursor — messages won’t run until then.`
    : `Cursor on your PC shows “${alert.title}”${alert.message ? `: ${alert.message}` : ''}`;
}

/** Waiting-for-approval chats across all projects (for the Home pill / badge). */
export function countWaiting(res: AgentsResponse | null): number {
  if (!res) return 0;
  return res.projects.reduce(
    (n, p) => n + p.chats.filter((c) => c.status === 'waiting_approval').length,
    0,
  );
}

/** Case-insensitive filter over chat titles and project names; drops empty projects. */
export function filterAgents(res: AgentsResponse, query: string): AgentsResponse {
  const q = query.trim().toLowerCase();
  if (!q) return res;
  return {
    ...res,
    projects: res.projects
      .map((p) =>
        p.name.toLowerCase().includes(q)
          ? p
          : { ...p, chats: p.chats.filter((c) => c.title.toLowerCase().includes(q)) },
      )
      .filter((p) => p.chats.length > 0),
  };
}

/** Chats whose agent is running right now. */
export function countWorking(res: AgentsResponse | null): number {
  if (!res) return 0;
  return res.projects.reduce((n, p) => n + p.chats.filter((c) => c.status === 'working').length, 0);
}

/** Only the agent sessions that need attention: working, waiting for approval, or errored. */
export function filterActive(res: AgentsResponse): AgentsResponse {
  return {
    ...res,
    projects: res.projects
      .map((p) => ({ ...p, chats: p.chats.filter((c) => c.status !== 'idle') }))
      .filter((p) => p.chats.length > 0),
  };
}

/** "20 projects · 33 chats" for the compact Home status row. */
export function agentsSyncShort(res: AgentsResponse): string {
  const chats = res.projects.reduce((n, p) => n + p.chats.length, 0);
  return `${res.projects.length} project${res.projects.length === 1 ? '' : 's'} · ${chats} chat${chats === 1 ? '' : 's'}${res.source === 'sidebar' ? '' : ' (history)'}`;
}
