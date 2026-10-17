/**
 * Every reason a phone send can fail, with what the operator should do about it.
 * Codes come from the Hub (packages/hub routes/api.ts + live-cursor adapter) or are
 * raised by the phone client itself (NOT_PAIRED, NETWORK_ERROR).
 */

export type SendFailureKind =
  /** Phone cannot reach or is not trusted by the Hub. */
  | 'connection'
  /** Hub is up but cannot drive Cursor on the PC right now. */
  | 'pc'
  /** The chat, project or window is not in the state the send needs. */
  | 'target'
  /** Composer options (mode / model / mentions / images) did not apply. */
  | 'options'
  /** The request itself is invalid. */
  | 'request';

export interface SendFailureInfo {
  kind: SendFailureKind;
  /** One line shown to the operator. */
  message: string;
  /** Safe to put in the offline queue and resend later with the same idempotency key. */
  queueable: boolean;
  /** Not sent for sure. false = the text may already be in Cursor; check before resending. */
  definitelyNotSent: boolean;
}

export const SEND_FAILURES: Record<string, SendFailureInfo> = {
  // — phone ↔ Hub —
  NETWORK_ERROR: { kind: 'connection', message: 'Cannot reach your PC. Check Tailscale is on for the phone and the PC, then try again.', queueable: true, definitelyNotSent: false },
  NOT_PAIRED: { kind: 'connection', message: 'This phone is not paired. Scan the QR on the PC /pair page.', queueable: false, definitelyNotSent: true },
  UNAUTHORIZED: { kind: 'connection', message: 'The Hub no longer trusts this phone. Pair it again from the PC /pair page.', queueable: false, definitelyNotSent: true },
  FORBIDDEN: { kind: 'connection', message: 'The Hub refused this request. Pair the phone again.', queueable: false, definitelyNotSent: true },
  ROUTE_NOT_AVAILABLE: { kind: 'connection', message: 'The PC Hub is older than this app. Update the Hub on the PC.', queueable: false, definitelyNotSent: true },

  // — Hub ↔ Cursor on the PC —
  CDP_UNAVAILABLE: { kind: 'pc', message: 'Cursor on your PC isn’t reachable. On the PC, restart Cursor with remote control on (the Hub console shows how), then send again.', queueable: true, definitelyNotSent: true },
  CURSOR_DOWN: { kind: 'pc', message: 'Cursor is not running on the PC. Open Cursor, then send again.', queueable: true, definitelyNotSent: true },
  NOT_RUNNING: { kind: 'pc', message: 'Cursor is not running on the PC. Open Cursor, then send again.', queueable: true, definitelyNotSent: true },
  OPEN_ON_PC_CDP_DOWN: { kind: 'pc', message: 'Cursor on your PC isn’t reachable. Restart it with remote control on, then try again.', queueable: true, definitelyNotSent: true },
  CURSOR_NEEDS_RELOAD: { kind: 'pc', message: 'Cursor on the PC is stuck ("Agent Execution Timed Out"). Click Reload Window in Cursor on the PC, then send again.', queueable: false, definitelyNotSent: true },
  CURSOR_WINDOW_HIDDEN: { kind: 'pc', message: 'The Cursor window on the PC is minimized or hidden. Bring it to the front, then send again.', queueable: false, definitelyNotSent: true },
  EXTRACTOR_STALE: { kind: 'pc', message: 'The Hub can’t read this version of Cursor yet. Update the Hub on the PC, then try again.', queueable: false, definitelyNotSent: true },
  CDP_INPUT_FAILED: { kind: 'pc', message: 'Cursor did not accept the typing. Check the PC screen, then send again.', queueable: false, definitelyNotSent: false },
  SEND_NOT_CONFIRMED: { kind: 'pc', message: 'The message was typed but Cursor never showed it as sent. Look at the chat on the PC before sending again, or it may be sent twice.', queueable: false, definitelyNotSent: false },
  COMPOSER_NOT_EMPTY: { kind: 'pc', message: 'The Cursor input box on the PC already has unsent text. Send or clear it on the PC first.', queueable: false, definitelyNotSent: true },

  // — chat / project target —
  SESSION_NOT_FOUND: { kind: 'target', message: 'This chat is not known to the Hub. Refresh the chat list.', queueable: false, definitelyNotSent: true },
  SESSION_NOT_LIVE: { kind: 'target', message: 'This is an old history chat. Open it from the sidebar and continue it as an agent chat.', queueable: false, definitelyNotSent: true },
  CHAT_NOT_IN_SIDEBAR: { kind: 'target', message: 'This chat is not in the Cursor sidebar on the PC (too old or archived). Open it in Cursor first.', queueable: false, definitelyNotSent: true },
  CHAT_SWITCH_FAILED: { kind: 'target', message: 'The Hub could not switch Cursor to this chat. Click the chat on the PC and try again.', queueable: false, definitelyNotSent: true },
  PROJECT_NOT_IN_SIDEBAR: { kind: 'target', message: 'This project is not in the Cursor sidebar on the PC.', queueable: false, definitelyNotSent: true },
  NEW_CHAT_FAILED: { kind: 'target', message: 'Cursor could not start a new chat in this project.', queueable: false, definitelyNotSent: false },
  FOREIGN_WORKSPACE: { kind: 'target', message: 'This chat belongs to a project that is not open in Cursor on the PC.', queueable: false, definitelyNotSent: true },

  // — composer options —
  MODE_NOT_APPLIED: { kind: 'options', message: 'Cursor did not switch to the chosen mode, so nothing was sent. Pick the mode again.', queueable: false, definitelyNotSent: true },
  MODEL_NOT_APPLIED: { kind: 'options', message: 'Cursor did not switch to the chosen model, so nothing was sent. Pick the model again.', queueable: false, definitelyNotSent: true },
  MODEL_UNAVAILABLE: { kind: 'options', message: 'That model is not available in Cursor on the PC. Pick another model.', queueable: false, definitelyNotSent: true },
  MENTION_NOT_APPLIED: { kind: 'options', message: 'An @ or / attachment did not attach, so nothing was sent. Remove it or pick it again.', queueable: false, definitelyNotSent: true },
  MENTION_NOT_FOUND: { kind: 'options', message: 'Cursor does not offer that @ or / item for this project.', queueable: false, definitelyNotSent: true },
  IMAGE_NOT_ATTACHED: { kind: 'options', message: 'The image did not attach, so nothing was sent. Try attaching it again.', queueable: false, definitelyNotSent: true },
  ATTACHMENT_OUTSIDE_ROOTS: { kind: 'options', message: 'That file is outside the project folders the Hub may attach from.', queueable: false, definitelyNotSent: true },

  // — request —
  VALIDATION_ERROR: { kind: 'request', message: 'The Hub rejected the message.', queueable: false, definitelyNotSent: true },
  IDEMPOTENCY_KEY_MISSING: { kind: 'request', message: 'The app sent the message without a retry key. Update the app.', queueable: false, definitelyNotSent: true },
  IDEMPOTENCY_KEY_REUSE: { kind: 'request', message: 'A different message already used this retry key. Send it again as a new message.', queueable: false, definitelyNotSent: true },
};

/** HTTP-level fallbacks when the Hub sent no known code. */
function fallback(status: number): SendFailureInfo {
  if (status === 401) return SEND_FAILURES.UNAUTHORIZED!;
  if (status === 429) return { kind: 'pc', message: 'Too many requests. Wait a few seconds and try again.', queueable: false, definitelyNotSent: true };
  if (status >= 500) return { kind: 'pc', message: 'The Hub hit an internal error. Try again; if it repeats, check the Hub console on the PC.', queueable: false, definitelyNotSent: false };
  return { kind: 'request', message: 'The send failed for an unknown reason.', queueable: false, definitelyNotSent: false };
}

export function describeSendFailure(code: string, status = 0): SendFailureInfo {
  if (status === 401 && code !== 'NOT_PAIRED') return SEND_FAILURES.UNAUTHORIZED!;
  return SEND_FAILURES[code] ?? fallback(status);
}

/** Catalog line, plus the Hub's own detail when it adds something (validation text, banner title…). */
export function sendFailureText(code: string, status: number, hubMessage: string): string {
  const info = describeSendFailure(code, status);
  const detail = hubMessage.trim();
  const showDetail = detail && !info.message.includes(detail) && (info.kind === 'request' || !SEND_FAILURES[code]);
  return showDetail ? `${info.message} (${detail})` : info.message;
}
