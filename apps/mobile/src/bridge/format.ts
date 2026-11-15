/** Pure display helpers for sessions/messages — unit-tested. */
import type { Message, Session } from './types';

const SOURCE_LABEL: Record<string, string> = {
  cli: 'PC terminal',
  desktop: 'PC app',
  phone: 'Phone',
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  cron: 'Scheduled',
  ntfy: 'ntfy',
  api: 'API',
  webhook: 'Webhook',
};

export function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** One clean line for list rows (markdown and whitespace collapsed). */
export function oneLine(text: string | null | undefined, max = 120): string {
  if (!text) return '';
  const t = text
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function sessionTitle(s: Pick<Session, 'title' | 'id' | 'preview'>): string {
  const t = oneLine(s.title, 80);
  return t && t !== s.id ? t : oneLine(s.preview, 80) || 'Untitled session';
}

export type ChatItem =
  | { kind: 'message'; key: string; message: Message }
  | { kind: 'tools'; key: string; names: string[]; count: number };

/**
 * Transcript for a phone screen: user/assistant text stays, tool plumbing collapses into one
 * compact row per run ("Used terminal, read_file ×3"), system prompts are hidden.
 */
export function buildTranscript(messages: Message[]): ChatItem[] {
  const out: ChatItem[] = [];
  let run: { names: string[]; count: number; firstId: number } | null = null;
  const flush = () => {
    if (run && run.count) out.push({ kind: 'tools', key: `t${run.firstId}`, names: run.names, count: run.count });
    run = null;
  };
  const addTools = (id: number, names: (string | null)[]) => {
    if (!run) run = { names: [], count: 0, firstId: id };
    for (const n of names) {
      run.count += 1;
      if (n && !run.names.includes(n)) run.names.push(n);
    }
  };
  for (const m of messages) {
    // Only conversation roles render; `system`, `session_meta` and other bookkeeping rows stay hidden.
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool') continue;
    if (m.role === 'user' && !m.content.trim()) continue;
    if (m.role === 'tool') {
      if (!run) addTools(m.id, []);
      continue; // results are counted via the assistant's toolCalls
    }
    if (m.role === 'assistant' && !m.content.trim()) {
      addTools(m.id, m.toolCalls ?? [m.toolName]);
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      flush();
      out.push({ kind: 'message', key: `m${m.id}`, message: m });
      addTools(m.id, m.toolCalls);
      continue;
    }
    flush();
    out.push({ kind: 'message', key: `m${m.id}`, message: m });
  }
  flush();
  return out;
}

export function toolsLabel(names: string[], count: number): string {
  if (!names.length) return count > 1 ? `Used ${count} tools` : 'Used a tool';
  const shown = names.slice(0, 3).join(', ');
  const more = names.length > 3 ? ` +${names.length - 3}` : '';
  return `Used ${shown}${more}${count > names.length ? ` · ${count} calls` : ''}`;
}

export function resumeCommand(sessionId: string): string {
  return `hermes --resume ${sessionId}`;
}
