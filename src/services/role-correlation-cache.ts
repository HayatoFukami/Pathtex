/**
 * Role-specific correlation cache for Bot-initiated role mutations.
 *
 * Key format: `{guildId}:{targetUserId}:{roleId}:{ADD|REMOVE}`
 * TTL: 15 seconds, max 10,000 entries.
 *
 * Registered immediately before a Bot role mutation API call;
 * consumed by the matching `guildMemberUpdate` transition;
 * removed on API failure; expires by TTL otherwise.
 */
export class RoleCorrelationCache {
  private readonly map = new Map<string, { expiresAt: number }>();

  public constructor(
    private readonly ttlMs = 15_000,
    private readonly limit = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  public static key(
    guildId: string,
    targetUserId: string,
    roleId: string,
    direction: 'ADD' | 'REMOVE',
  ): string {
    return `${guildId}:${targetUserId}:${roleId}:${direction}`;
  }

  public put(
    guildId: string,
    targetUserId: string,
    roleId: string,
    direction: 'ADD' | 'REMOVE',
  ): void {
    this.purge();
    const key = RoleCorrelationCache.key(
      guildId,
      targetUserId,
      roleId,
      direction,
    );
    this.map.delete(key);
    this.map.set(key, { expiresAt: this.now() + this.ttlMs });
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /** Consumes the entry if present and not expired; returns true if consumed. */
  public consume(
    guildId: string,
    targetUserId: string,
    roleId: string,
    direction: 'ADD' | 'REMOVE',
  ): boolean {
    this.purge();
    return this.map.delete(
      RoleCorrelationCache.key(guildId, targetUserId, roleId, direction),
    );
  }

  /** Removes the entry without consuming (e.g. on API failure). */
  public remove(
    guildId: string,
    targetUserId: string,
    roleId: string,
    direction: 'ADD' | 'REMOVE',
  ): void {
    this.map.delete(
      RoleCorrelationCache.key(guildId, targetUserId, roleId, direction),
    );
  }

  private purge(): void {
    const now = this.now();
    for (const [key, value] of this.map)
      if (value.expiresAt <= now) this.map.delete(key);
  }
}
