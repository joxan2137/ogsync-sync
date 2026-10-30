// Identical polls inside a short window fail the same way they did a moment
// ago and cost Studio a round trip each; answer them with a retry-after hint
// (or a pointer to the `wait` tool) instead.

const MAX_KEYS = 1_000;

export class PollThrottle {
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #last = new Map<string, number>();

  constructor(windowMs = 1_000, now: () => number = Date.now) {
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** 0 when the call may proceed (and is recorded), else ms until it may. */
  check(key: string): number {
    const now = this.#now();
    const last = this.#last.get(key);
    if (last !== undefined && now - last < this.#windowMs) return this.#windowMs - (now - last);
    this.#last.delete(key);
    this.#last.set(key, now);
    if (this.#last.size > MAX_KEYS) this.#prune(now);
    return 0;
  }

  #prune(now: number): void {
    // Insertion order is recording order, so the stale entries lead.
    for (const [key, at] of this.#last) {
      if (now - at < this.#windowMs) break;
      this.#last.delete(key);
    }
  }
}
