/**
 * Hub-side attachment registry for live sessions.
 * DESIGNED: stores paths Hub accepted; Composer DOM @-inject is separate / fail-closed.
 */

export class SessionAttachmentStore {
  private bySession = new Map<string, string[]>();

  seed(sessionId: string, attachments: string[]): void {
    const unique = [...new Set(attachments)];
    this.bySession.set(sessionId, unique);
  }

  get(sessionId: string): string[] {
    return [...(this.bySession.get(sessionId) ?? [])];
  }

  /** Add-only merge. Returns full list + newly added paths. */
  add(
    sessionId: string,
    attachments: string[],
  ): { attachments: string[]; added: string[] } {
    const current = this.bySession.get(sessionId) ?? [];
    const set = new Set(current);
    const added: string[] = [];
    for (const p of attachments) {
      if (!set.has(p)) {
        set.add(p);
        added.push(p);
      }
    }
    const next = [...set];
    this.bySession.set(sessionId, next);
    return { attachments: next, added };
  }

  has(sessionId: string): boolean {
    return this.bySession.has(sessionId);
  }
}
