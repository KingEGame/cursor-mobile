/** Relative time for session list rows (English, compact). */
export function formatRelativeTime(iso: string, nowMs: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const deltaSec = Math.round((nowMs - then) / 1000);
  if (deltaSec < 45) return 'just now';
  if (deltaSec < 3600) {
    const m = Math.max(1, Math.round(deltaSec / 60));
    return `${m}m ago`;
  }
  if (deltaSec < 86400) {
    const h = Math.max(1, Math.round(deltaSec / 3600));
    return `${h}h ago`;
  }
  const d = Math.max(1, Math.round(deltaSec / 86400));
  return `${d}d ago`;
}

/** Short path for attachment chips. */
export function shortPath(path: string, max = 48): string {
  if (path.length <= max) return path;
  return `…${path.slice(-(max - 1))}`;
}
