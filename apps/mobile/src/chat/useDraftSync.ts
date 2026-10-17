import { useCallback, useEffect, useRef, useState } from 'react';
import type { HubClient } from '../hub/client';
import { decideDraft } from './draftSync';

const POLL_MS = 2_500;
const PUSH_DEBOUNCE_MS = 700;

export interface DraftConflict {
  pc: string;
  local: string;
}

/**
 * Keeps the unsent text of this chat in step with the PC composer (two-way, see draftSync.ts).
 * Only chats that are open on the PC take part; everything else keeps the phone text local.
 */
export function useDraftSync(opts: {
  client: HubClient | null;
  composerId: string | null;
  /** Off while sending, editing an old message, or when chips/photos are attached. */
  enabled: boolean;
}) {
  const { client, composerId, enabled } = opts;
  const localRef = useRef('');
  const baseRef = useRef('');
  const busyRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Text the composer should show because the PC changed (nonce makes repeats apply). */
  const [adopted, setAdopted] = useState<{ text: string; nonce: number } | null>(null);
  const [conflict, setConflict] = useState<DraftConflict | null>(null);
  const [pcOpen, setPcOpen] = useState(false);

  const tick = useCallback(async () => {
    if (!client || !composerId || !enabled || busyRef.current) return;
    busyRef.current = true;
    try {
      const pc = await client.getAgentDraft(composerId);
      setPcOpen(pc.open);
      if (!pc.open || pc.text === null || pc.hasAttachments) {
        setConflict(null);
        return;
      }
      const action = decideDraft({ local: localRef.current, pc: pc.text, base: baseRef.current });
      switch (action.kind) {
        case 'none':
          baseRef.current = action.base;
          setConflict(null);
          break;
        case 'adopt':
          baseRef.current = action.text;
          localRef.current = action.text;
          setConflict(null);
          setAdopted((prev) => ({ text: action.text, nonce: (prev?.nonce ?? 0) + 1 }));
          break;
        case 'push': {
          const res = await client.putAgentDraft(composerId, action.text);
          if (res.ok) baseRef.current = action.text;
          setConflict(null);
          break;
        }
        case 'conflict':
          setConflict({ pc: action.pc, local: action.local });
          break;
      }
    } catch {
      /* offline or Hub restarting: try again on the next tick */
    } finally {
      busyRef.current = false;
    }
  }, [client, composerId, enabled]);

  useEffect(() => {
    if (!enabled) return;
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      clearInterval(id);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [enabled, tick]);

  /** Call on every keystroke in the phone composer. */
  const onLocalChange = useCallback(
    (text: string) => {
      localRef.current = text;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void tick(), PUSH_DEBOUNCE_MS);
    },
    [tick],
  );

  /** The phone just sent the text: both boxes start fresh. */
  const reset = useCallback(() => {
    localRef.current = '';
    baseRef.current = '';
    setConflict(null);
  }, []);

  /** Conflict: keep the phone text and overwrite the PC box. */
  const keepMine = useCallback(async () => {
    if (!client || !composerId || !conflict) return;
    try {
      const res = await client.putAgentDraft(composerId, conflict.local);
      if (res.ok) baseRef.current = conflict.local;
    } catch {
      /* next tick retries */
    }
    setConflict(null);
  }, [client, composerId, conflict]);

  /** Conflict: take the PC text into the phone box. */
  const usePc = useCallback(() => {
    if (!conflict) return;
    baseRef.current = conflict.pc;
    localRef.current = conflict.pc;
    setAdopted((prev) => ({ text: conflict.pc, nonce: (prev?.nonce ?? 0) + 1 }));
    setConflict(null);
  }, [conflict]);

  return { adopted, conflict, pcOpen, onLocalChange, reset, keepMine, usePc };
}
