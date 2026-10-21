/**
 * Brute-force guard for POST /v1/pair/complete (the only unauthenticated write a phone on the
 * mesh can make). Six-digit codes live for minutes, so a peer on the tailnet could otherwise
 * guess at wire speed. Per caller address: after `maxFailures` wrong codes inside `windowMs`
 * the caller is refused until the window has passed. A correct code clears the caller.
 */
export interface PairAttemptLimiterOptions {
  maxFailures?: number;
  windowMs?: number;
  now?: () => number;
}

export class PairAttemptLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts: PairAttemptLimiterOptions = {}) {
    this.maxFailures = opts.maxFailures ?? 8;
    this.windowMs = opts.windowMs ?? 10 * 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Seconds the caller must wait, or 0 when it may try now. */
  retryAfterSec(key: string): number {
    const recent = this.recent(key);
    if (recent.length < this.maxFailures) return 0;
    const oldest = recent[0]!;
    return Math.max(1, Math.ceil((oldest + this.windowMs - this.now()) / 1000));
  }

  recordFailure(key: string): void {
    const recent = this.recent(key);
    recent.push(this.now());
    this.failures.set(key, recent);
  }

  clear(key: string): void {
    this.failures.delete(key);
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length === 0) this.failures.delete(key);
    else this.failures.set(key, kept);
    return kept;
  }
}
