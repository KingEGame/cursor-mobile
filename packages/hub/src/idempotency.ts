/**
 * In-memory Idempotency-Key store (TOR-03 mutation routes).
 * Phase 1: process-local only.
 */

export interface IdempotencyRecord {
  key: string;
  route: string;
  bodyHash: string;
  status: number;
  response: unknown;
  createdAt: number;
}

export class IdempotencyStore {
  private records = new Map<string, IdempotencyRecord>();

  private mapKey(route: string, key: string): string {
    return `${route}::${key}`;
  }

  get(route: string, key: string): IdempotencyRecord | undefined {
    return this.records.get(this.mapKey(route, key));
  }

  put(record: IdempotencyRecord): void {
    this.records.set(this.mapKey(record.route, record.key), record);
  }
}

export function hashBody(body: unknown): string {
  return JSON.stringify(body ?? null);
}
