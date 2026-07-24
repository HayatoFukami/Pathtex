/** Default bound for the interaction dedupe cache. The cache holds one entry per
 * recently-seen interaction ID for `ttlMs`; this cap keeps memory bounded under
 * sustained gateway load even if every interaction carries a unique ID. */
export const DEFAULT_DEDUPE_MAX_SIZE = 100_000;

/** Bounded, O(1)-amortized interaction dedupe (spec `00-common.md §8.6`).
 *
 * Discord may redeliver the same interaction (same ID) when an acknowledgement
 * is slow; this cache rejects a previously-seen ID within its TTL so a command
 * or component is never executed twice. Unlike the original implementation it
 * does **not** scan every entry on each `accept` (that was O(n) per call and
 * grew without bound): expiry is checked only for the ID at hand, and expired
 * entries are pruned from the oldest end of the insertion-ordered `Map`.
 *
 * ## Capacity semantics (fail closed)
 *
 * An accepted ID is guaranteed to remain rejected for its full TTL: the cache
 * never evicts an *unexpired* entry to make room. Only expired entries are
 * dropped. If the cache is still at `maxSize` after expired entries are cleared,
 * a *new* ID is rejected (`accept` returns `false`) rather than displacing a
 * still-protected entry. This is the fail-closed direction: under sustained
 * unique-ID load at capacity it is safer to drop a genuine new interaction than
 * to risk double-executing a redelivered one whose TTL has not elapsed. Each
 * expired entry is visited at most once on pruning, giving amortized O(1)
 * `accept` with a hard memory ceiling. */
export class InteractionDedupe {
  private readonly entries = new Map<string, number>();
  public constructor(
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly now = () => Date.now(),
    private readonly maxSize = DEFAULT_DEDUPE_MAX_SIZE,
  ) {}

  public accept(id: string): boolean {
    const current = this.now();
    const expires = this.entries.get(id);
    if (expires !== undefined) {
      // Seen within the TTL window: reject the duplicate. An expired entry is
      // dropped so the ID may be accepted again below.
      if (expires > current) return false;
      this.entries.delete(id);
    }
    this.evictExpired(current);
    // Fail closed: never displace an unexpired (still-protected) entry. If the
    // cache is at capacity after pruning expired entries, reject the new ID.
    if (this.entries.size >= this.maxSize) return false;
    this.entries.set(id, current + this.ttlMs);
    return true;
  }

  public get size(): number {
    return this.entries.size;
  }

  public clear(): void {
    this.entries.clear();
  }

  /** Drops expired entries from the oldest end only; unexpired entries are
   * never evicted. `Map` iterates in insertion order and entries are inserted
   * with non-decreasing expiry (monotonic `now`, constant TTL), so the first
   * unexpired entry marks the boundary: everything after it is also unexpired.
   * Deleting during iteration is safe and each removed entry is visited at most
   * once. */
  private evictExpired(current: number): void {
    for (const [key, expires] of this.entries) {
      if (expires > current) break;
      this.entries.delete(key);
    }
  }
}
