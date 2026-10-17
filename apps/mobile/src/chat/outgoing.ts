/**
 * Messages sent from the phone that the PC transcript does not show yet, with the
 * delivery state the operator sees: sending → sent, or failed with a reason and Retry.
 */

export type DeliveryState = 'sending' | 'sent' | 'failed';

export interface OutgoingMessage<O = unknown> {
  id: string;
  text: string;
  options: O;
  state: DeliveryState;
  /** Epoch ms when the phone first tried to send it. */
  sentAt: number;
  /** Operator-facing reason when failed. */
  reason?: string;
  /** false when the text may already be in Cursor — retry could send it twice. */
  definitelyNotSent?: boolean;
}

let counter = 0;
export function newOutgoingId(): string {
  counter += 1;
  return `out-${Date.now().toString(36)}-${counter}`;
}

export function addOutgoing<O>(
  list: OutgoingMessage<O>[],
  text: string,
  options: O,
  id = newOutgoingId(),
  now: number = Date.now(),
): OutgoingMessage<O>[] {
  return [...list, { id, text, options, state: 'sending', sentAt: now }];
}

export function markSent<O>(list: OutgoingMessage<O>[], id: string): OutgoingMessage<O>[] {
  return list.map((m) => (m.id === id ? { ...m, state: 'sent', reason: undefined } : m));
}

export function markFailed<O>(
  list: OutgoingMessage<O>[],
  id: string,
  reason: string,
  definitelyNotSent: boolean,
): OutgoingMessage<O>[] {
  return list.map((m) => (m.id === id ? { ...m, state: 'failed', reason, definitelyNotSent } : m));
}

export function markSending<O>(list: OutgoingMessage<O>[], id: string): OutgoingMessage<O>[] {
  return list.map((m) => (m.id === id ? { ...m, state: 'sending', reason: undefined } : m));
}

export function dropOutgoing<O>(list: OutgoingMessage<O>[], id: string): OutgoingMessage<O>[] {
  return list.filter((m) => m.id !== id);
}

/** PC and phone clocks can differ; a transcript message this much older than the send is not it. */
const CLOCK_SKEW_MS = 2 * 60_000;

/**
 * A phone-sent message disappears once the PC transcript holds it. "Sent" ones match on text
 * alone. In-flight and failed ones also need a transcript message created after the send began,
 * so an older identical message ("ping" again) does not hide a real failure. This is what clears
 * a "May not have sent" bubble when the message did arrive after all.
 */
export function reconcile<O>(
  list: OutgoingMessage<O>[],
  transcript: Array<{ role: string; content: string; createdAt?: string }>,
): OutgoingMessage<O>[] {
  return list.filter((m) => {
    const want = m.text.trim();
    const arrived = transcript.some((t) => {
      if (t.role !== 'user' || !t.content.trim().endsWith(want)) return false;
      if (m.state === 'sent') return true;
      const at = t.createdAt ? Date.parse(t.createdAt) : NaN;
      return !Number.isNaN(at) && at >= m.sentAt - CLOCK_SKEW_MS;
    });
    return !arrived;
  });
}

/** Copy for the delivery line under a phone-sent bubble. */
export function deliveryLabel(m: Pick<OutgoingMessage, 'state' | 'reason' | 'definitelyNotSent'>): string {
  switch (m.state) {
    case 'sending':
      return 'Sending to your PC…';
    case 'sent':
      return 'Sent — waiting for Cursor to show it';
    case 'failed':
      return `${m.definitelyNotSent === false ? 'May not have sent' : 'Not sent'} — ${m.reason ?? 'unknown reason'}`;
  }
}
