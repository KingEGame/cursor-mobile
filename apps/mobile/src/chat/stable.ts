/**
 * Keep object identity across polls: unchanged messages reuse their previous object, and when
 * nothing changed the previous array itself comes back, so React skips re-rendering the list.
 */
export function stabilize<T extends { id: string; content: string; createdAt: string; status?: string }>(
  prev: T[],
  next: T[],
): T[] {
  const byId = new Map(prev.map((m) => [m.id, m]));
  let same = prev.length === next.length;
  const merged = next.map((m, i) => {
    const old = byId.get(m.id);
    const reuse = old && old.content === m.content && old.createdAt === m.createdAt && old.status === m.status;
    if (!reuse || prev[i] !== old) same = false;
    return reuse ? old : m;
  });
  return same ? prev : merged;
}
