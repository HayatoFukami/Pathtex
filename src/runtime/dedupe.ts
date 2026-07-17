export class InteractionDedupe {
  private readonly entries = new Map<string, number>();
  public constructor(
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly now = () => Date.now(),
  ) {}

  public accept(id: string): boolean {
    const current = this.now();
    for (const [key, expires] of this.entries)
      if (expires <= current) this.entries.delete(key);
    if (this.entries.has(id)) return false;
    this.entries.set(id, current + this.ttlMs);
    return true;
  }
  public clear(): void {
    this.entries.clear();
  }
}
