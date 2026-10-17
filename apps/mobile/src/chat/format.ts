/** Small pure helpers for how the chat talks about time and progress. */

const MIN = 60_000;

/** "2:41 PM" for today, "Yesterday 2:41 PM", or "Oct 14, 2:41 PM". Empty when unparseable. */
export function formatMessageTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = dayDiff(d, now);
  if (days === 0) return time;
  if (days === 1) return `Yesterday ${time}`;
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${date}, ${time}`;
}

/** Divider label when the day changes between messages: "Today", "Yesterday", "Oct 14". */
export function dayLabel(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = dayDiff(d, now);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export function sameDay(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

function dayDiff(d: Date, now: Date): number {
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((b - a) / (24 * 60 * MIN));
}

/** "42s", "3m 05s", "1h 02m" */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Last collapsed tool note ("Used read_file, grep (3 steps)") after the final user message. */
export function lastToolStep(messages: Array<{ role: string; content: string }>): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user') return null;
    if (m.role === 'system' && m.content.trim()) return m.content.trim();
  }
  return null;
}

/** A code span that names a file or folder: has a slash or a file extension, and no spaces. */
export function looksLikePath(text: string): boolean {
  const t = text.trim();
  if (!t || /\s/.test(t) || t.length > 200) return false;
  return /[\\/]/.test(t) || /^[\w.-]+\.[A-Za-z0-9]{1,8}$/.test(t);
}

/** "apps/mobile/…/HistoryReadScreen.tsx": keep the start and the file name, drop the middle. */
export function truncateMiddle(text: string, max = 44): string {
  if (text.length <= max) return text;
  const keepEnd = Math.ceil((max - 1) * 0.6);
  const keepStart = max - 1 - keepEnd;
  return `${text.slice(0, keepStart)}…${text.slice(text.length - keepEnd)}`;
}
