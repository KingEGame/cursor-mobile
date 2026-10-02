/**
 * Unknown / partial approval payloads stay denyable (AC-062-02).
 * Never invents auto-approve; phone only shows Approve/Deny when pending.
 */

import type { ApprovalStatus, PendingApproval } from './types';

export function isDeniableApprovalStatus(status: ApprovalStatus | string): boolean {
  return status === 'pending';
}

/**
 * Coerce Hub/CDP tool shapes into a card the APK can render.
 * Missing name → "Unknown tool"; still pending → Approve/Deny available.
 */
export function normalizeApprovalForCard(raw: unknown): PendingApproval | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  const approvalId =
    typeof body.approvalId === 'string'
      ? body.approvalId
      : typeof body.id === 'string'
        ? body.id
        : null;
  if (!approvalId) return null;

  const toolRaw =
    body.tool && typeof body.tool === 'object'
      ? (body.tool as Record<string, unknown>)
      : {};
  const name =
    typeof toolRaw.name === 'string' && toolRaw.name.trim()
      ? toolRaw.name.trim()
      : typeof body.toolName === 'string' && body.toolName.trim()
        ? body.toolName.trim()
        : 'Unknown tool';

  const status =
    typeof body.status === 'string' && body.status.trim()
      ? (body.status as ApprovalStatus)
      : 'pending';

  return {
    approvalId,
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
    tool: {
      name,
      server: typeof toolRaw.server === 'string' ? toolRaw.server : null,
      kind:
        typeof toolRaw.kind === 'string'
          ? toolRaw.kind
          : typeof toolRaw.kind === 'undefined'
            ? 'unknown'
            : null,
    },
    summary:
      typeof body.summary === 'string' && body.summary.trim()
        ? body.summary
        : 'Unrecognized tool shape from Cursor on the PC — approve or deny.',
    argsPreview: body.argsPreview,
    createdAt:
      typeof body.createdAt === 'string'
        ? body.createdAt
        : new Date().toISOString(),
    expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
    status,
    synthetic: body.synthetic === true,
  };
}

export function approvalCardShowsActions(approval: PendingApproval): boolean {
  return isDeniableApprovalStatus(approval.status);
}
