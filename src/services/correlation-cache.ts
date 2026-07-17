import { z } from 'zod';
import { err, ok, type Result } from '../domain/result.js';
export type CorrelationKind = 'moderation' | 'message-delete' | 'slowmode';
export const ModerationCorrelationSchema = z.object({ caseId: z.uuid() });
export const MessageDeleteCorrelationSchema = z.object({
  reason: z.string().max(1000),
  caseId: z.uuid().optional(),
});
export const SlowmodeCorrelationSchema = z.object({
  previousInterval: z.number().int().min(0).max(21600),
  newInterval: z.number().int().min(0).max(21600),
});
export type CorrelationValues = {
  moderation: z.infer<typeof ModerationCorrelationSchema>;
  'message-delete': z.infer<typeof MessageDeleteCorrelationSchema>;
  slowmode: z.infer<typeof SlowmodeCorrelationSchema>;
};
type Value = CorrelationValues[keyof CorrelationValues];
export class CorrelationCache {
  private readonly maps = new Map<
    CorrelationKind,
    Map<string, { value: Value; expiresAt: number }>
  >();
  public constructor(
    private readonly ttlMs = 15_000,
    private readonly limits: Readonly<Record<CorrelationKind, number>> = {
      moderation: 10_000,
      'message-delete': 10_000,
      slowmode: 1_000,
    },
    private readonly now = Date.now,
  ) {}
  public put<K extends CorrelationKind>(
    kind: K,
    key: string,
    value: CorrelationValues[K],
  ): Result<void> {
    const keySchemas = {
      moderation: /^\d{17,20}:\d{17,20}:(?:BAN|UNBAN|KICK|MUTE|UNMUTE)$/u,
      'message-delete': /^\d{17,20}:\d{17,20}$/u,
      slowmode: /^\d{17,20}:\d{17,20}$/u,
    };
    const validKey = z.string().regex(keySchemas[kind]).safeParse(key);
    const schemas = {
      moderation: ModerationCorrelationSchema,
      'message-delete': MessageDeleteCorrelationSchema,
      slowmode: SlowmodeCorrelationSchema,
    };
    const parsed = schemas[kind].safeParse(value);
    if (!validKey.success || !parsed.success)
      return err('INVALID_INPUT', 'Invalid correlation entry');
    const map =
      this.maps.get(kind) ??
      new Map<string, { value: Value; expiresAt: number }>();
    this.maps.set(kind, map);
    this.purge(map);
    map.delete(key);
    map.set(key, { value: parsed.data, expiresAt: this.now() + this.ttlMs });
    while (map.size > this.limits[kind]) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
    return ok(undefined);
  }
  public peek<K extends CorrelationKind>(
    kind: K,
    key: string,
  ): CorrelationValues[K] | undefined {
    const map = this.maps.get(kind);
    if (!map) return undefined;
    this.purge(map);
    const item = map.get(key);
    if (!item) return undefined;
    return item.value as CorrelationValues[K];
  }
  public consume<K extends CorrelationKind>(
    kind: K,
    key: string,
  ): CorrelationValues[K] | undefined {
    const map = this.maps.get(kind);
    if (!map) return undefined;
    this.purge(map);
    const item = map.get(key);
    if (item) map.delete(key);
    return item?.value as CorrelationValues[K] | undefined;
  }
  public clear(): void {
    this.maps.clear();
  }
  private purge(map: Map<string, { value: Value; expiresAt: number }>): void {
    const now = this.now();
    for (const [key, value] of map) if (value.expiresAt <= now) map.delete(key);
  }
}
