import {
  GuildSettingsDtoSchema,
  GuildSettingsUpdateSchema,
  type GuildSettingsDto,
  type GuildSettingsRepository,
  type GuildSettingsUpdate,
} from '../repositories/contracts.js';
import { err, ok, type Result } from '../domain/result.js';

export interface SettingsCacheOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export class SettingsService {
  private readonly cache = new Map<
    string,
    { value: GuildSettingsDto; expiresAt: number }
  >();
  private readonly ttl: number;
  private readonly now: () => number;
  public constructor(
    private readonly repository: GuildSettingsRepository,
    options: SettingsCacheOptions = {},
  ) {
    this.ttl = options.ttlMs ?? 300_000;
    this.now = options.now ?? Date.now;
  }
  public async get(guildId: string): Promise<Result<GuildSettingsDto>> {
    if (!/^\d{17,20}$/u.test(guildId))
      return err('INVALID_INPUT', 'Invalid guild ID');
    const hit = this.cache.get(guildId);
    if (hit && hit.expiresAt > this.now()) return ok(hit.value);
    const value = GuildSettingsDtoSchema.parse(
      await this.repository.getOrCreate(guildId),
    );
    this.cache.set(guildId, { value, expiresAt: this.now() + this.ttl });
    return ok(value);
  }
  public async update(
    guildId: string,
    patch: GuildSettingsUpdate,
  ): Promise<Result<GuildSettingsDto>> {
    if (!/^\d{17,20}$/u.test(guildId))
      return err('INVALID_INPUT', 'Invalid guild ID');
    const parsed = GuildSettingsUpdateSchema.safeParse(patch);
    if (!parsed.success) return err('INVALID_INPUT', 'Invalid settings update');
    const value = GuildSettingsDtoSchema.parse(
      await this.repository.update(guildId, parsed.data as GuildSettingsUpdate),
    );
    this.cache.set(guildId, { value, expiresAt: this.now() + this.ttl });
    return ok(value);
  }
  public invalidate(guildId: string): void {
    this.cache.delete(guildId);
  }
  public clear(): void {
    this.cache.clear();
  }
}
