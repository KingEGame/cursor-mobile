/**
 * Two-way mirror of the unsent text between the phone composer and the PC composer of the
 * chat that is open there. Pure rules, so the "never overwrite what someone typed" promise
 * is unit-tested.
 *
 * `base` is the last text both sides agreed on. A side that changed since `base` wins over a
 * side that did not; if both changed, nothing is overwritten and the operator picks.
 */

const norm = (t: string) => t.replace(/\s+/g, ' ').trim();

export type DraftAction =
  | { kind: 'none'; base: string }
  /** The PC changed, the phone did not: put the PC text into the phone composer. */
  | { kind: 'adopt'; text: string }
  /** The phone changed, the PC did not: write the phone text into the PC composer. */
  | { kind: 'push'; text: string }
  /** Both changed differently: touch neither. */
  | { kind: 'conflict'; pc: string; local: string };

export function decideDraft(input: {
  local: string;
  /** PC composer text; null when that chat is not open on the PC (nothing to sync). */
  pc: string | null;
  base: string;
}): DraftAction {
  const { pc } = input;
  if (pc === null) return { kind: 'none', base: input.base };
  const l = norm(input.local);
  const p = norm(pc);
  const b = norm(input.base);
  if (l === p) return { kind: 'none', base: l };
  const pcChanged = p !== b;
  const localChanged = l !== b;
  if (pcChanged && !localChanged) return { kind: 'adopt', text: pc.trim() };
  if (!pcChanged && localChanged) return { kind: 'push', text: input.local.trim() };
  if (pcChanged && localChanged) return { kind: 'conflict', pc: pc.trim(), local: input.local.trim() };
  return { kind: 'none', base: b };
}
