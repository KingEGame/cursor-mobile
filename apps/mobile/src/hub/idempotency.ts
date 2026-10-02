/** Generate a client Idempotency-Key for mutating Hub routes (TOR-03). */
export function createIdempotencyKey(prefix: string): string {
  const safe = prefix.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'op';
  const rand =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${safe}-${rand}`;
}
