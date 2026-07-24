import { DateTime, IANAZone } from 'luxon';
import { err, ok, type Result } from '../../domain/result.js';
import {
  SnowflakeSchema,
  type GuildSettingsDto,
  type GuildSettingsRepository,
  type GuildSettingsUpdate,
  type AutomodSettingsDto,
  type AutomodSettingsUpdate,
  type PunishmentDto,
} from '../../repositories/contracts.js';
import { SettingsService } from '../../services/settings-service.js';
import { t } from '../../i18n/index.js';

export type LogKind = 'message' | 'moderation' | 'server' | 'voice';
const channelField: Record<LogKind, keyof GuildSettingsUpdate> = {
  message: 'messageLogChannelId',
  moderation: 'modlogChannelId',
  server: 'serverLogChannelId',
  voice: 'voiceLogChannelId',
};

export interface SetupPort {
  findMutedRole(guildId: string, roleId: string | null): Promise<string | null>;
  createMutedRole(guildId: string): Promise<string>;
  listChannels(
    guildId: string,
  ): Promise<
    ReadonlyArray<{ id: string; kind: 'text' | 'forum' | 'voice' | 'stage' }>
  >;
  denyMutedRole(
    guildId: string,
    channelId: string,
    kind: string,
  ): Promise<void>;
  ensureAutomodSettings?(guildId: string): Promise<void>;
  checkChannelPermissions?(
    guildId: string,
    channelId: string,
  ): Promise<ReadonlyArray<string>>;
  getBotWarnings?(guildId: string): Promise<ReadonlyArray<string>>;
  getAutomaticIgnoredRoles?(guildId: string): Promise<ReadonlyArray<string>>;
}

export interface ConfigurationDependencies {
  readonly settings: GuildSettingsRepository;
  /** Feature service ports; persistence adapters stay behind composition. */
  readonly automod?: AutomodServicePort;
  readonly punishments?: PunishmentServicePort;
  readonly ignores?: IgnoreServicePort;
  readonly setup?: SetupPort;
}

export interface AutomodServicePort {
  getOrCreate(guildId: string): Promise<AutomodSettingsDto>;
  update(
    guildId: string,
    patch: AutomodSettingsUpdate,
  ): Promise<AutomodSettingsDto>;
  resourceWarnings?(): readonly string[];
}
export interface PunishmentServicePort {
  list(guildId: string): Promise<PunishmentDto[]>;
}
export interface IgnoreServicePort {
  listRoles(guildId: string): Promise<
    ReadonlyArray<{
      guildId: string;
      roleId: string;
      createdBy: string;
      createdAt: Date;
    }>
  >;
  listChannels(guildId: string): Promise<
    ReadonlyArray<{
      guildId: string;
      channelId: string;
      createdBy: string;
      createdAt: Date;
    }>
  >;
  clearChannel(guildId: string, channelId: string): Promise<number>;
}

/** Identifies which /settings overview dependency failed while retaining its cause. */
export class ConfigurationOverviewError extends Error {
  public constructor(
    readonly dependency: string,
    cause: unknown,
  ) {
    super(`Settings overview dependency failed: ${dependency}`, { cause });
    this.name = 'ConfigurationOverviewError';
  }
}

export class ConfigurationService {
  private automodWarningsProvider?: () => readonly string[];
  public readonly settings: SettingsService;
  private static readonly settingsServices = new WeakMap<
    object,
    SettingsService
  >();
  private readonly setupLocks = new Map<
    string,
    Promise<
      Result<{
        mutedRoleId: string;
        succeeded: number;
        failed: number;
        warnings: readonly string[];
      }>
    >
  >();
  public constructor(private readonly deps: ConfigurationDependencies) {
    const existing = ConfigurationService.settingsServices.get(deps.settings);
    this.settings = existing ?? new SettingsService(deps.settings);
    ConfigurationService.settingsServices.set(deps.settings, this.settings);
  }
  public async get(guildId: string): Promise<Result<GuildSettingsDto>> {
    return this.settings.get(guildId);
  }
  public async setLogChannel(
    guildId: string,
    kind: LogKind,
    channelId: string,
  ): Promise<Result<GuildSettingsDto>> {
    if (!(kind in channelField))
      return err('INVALID_INPUT', 'Invalid log kind');
    if (!SnowflakeSchema.safeParse(channelId).success)
      return err('INVALID_INPUT', 'Invalid channel ID');
    if (this.deps.setup?.checkChannelPermissions) {
      const missing = await this.deps.setup.checkChannelPermissions(
        guildId,
        channelId,
      );
      if (missing.length > 0)
        return err(
          'BOT_PERMISSION_MISSING',
          t('configuration:service.missingBotPermissions', {
            missing: missing.join(', '),
          }),
          { missing },
        );
    }
    return this.settings.update(guildId, {
      [channelField[kind]]: channelId,
    });
  }
  public async disableLog(
    guildId: string,
    kind: LogKind,
  ): Promise<Result<GuildSettingsDto>> {
    if (!(kind in channelField))
      return err('INVALID_INPUT', 'Invalid log kind');
    return this.settings.update(guildId, {
      [channelField[kind]]: null,
    });
  }
  public async setTimezone(
    guildId: string,
    zone: string,
  ): Promise<Result<{ settings: GuildSettingsDto; currentTime: string }>> {
    const normalized = zone.trim();
    if (!IANAZone.isValidZone(normalized))
      return err('INVALID_INPUT', 'Invalid IANA timezone');
    const canonical =
      normalized.toUpperCase() === 'UTC'
        ? 'UTC'
        : IANAZone.create(normalized).name;
    const updated = await this.settings.update(guildId, {
      timezone: canonical,
    });
    if (!updated.ok) return updated;
    return ok({
      settings: updated.value,
      currentTime: formatGuildTime(new Date(), canonical),
    });
  }
  public async setModRole(
    guildId: string,
    roleId: string | null,
    role?: { managed?: boolean; everyone?: boolean; botIntegration?: boolean },
  ): Promise<Result<GuildSettingsDto>> {
    if (
      roleId !== null &&
      (!SnowflakeSchema.safeParse(roleId).success ||
        role?.managed ||
        role?.everyone ||
        role?.botIntegration)
    )
      return err('INVALID_INPUT', 'Invalid MOD role');
    return this.settings.update(guildId, { modRoleId: roleId });
  }
  public async setup(guildId: string): Promise<
    Result<{
      mutedRoleId: string;
      succeeded: number;
      failed: number;
      warnings: readonly string[];
    }>
  > {
    if (!SnowflakeSchema.safeParse(guildId).success || !this.deps.setup)
      return err('INVALID_INPUT', 'Setup is unavailable');
    const inFlight = this.setupLocks.get(guildId);
    if (inFlight) return inFlight;
    const operation = this.setupLocked(guildId);
    this.setupLocks.set(guildId, operation);
    try {
      return await operation;
    } finally {
      this.setupLocks.delete(guildId);
    }
  }
  private async setupLocked(guildId: string): Promise<
    Result<{
      mutedRoleId: string;
      succeeded: number;
      failed: number;
      warnings: readonly string[];
    }>
  > {
    if (!this.deps.setup) return err('INVALID_INPUT', 'Setup is unavailable');
    const current = await this.settings.get(guildId);
    if (!current.ok) return current;
    let role = await this.deps.setup.findMutedRole(
      guildId,
      current.value.mutedRoleId ?? null,
    );
    if (!role) role = await this.deps.setup.createMutedRole(guildId);
    let succeeded = 0;
    let failed = 0;
    const warnings: string[] = [];
    try {
      await this.deps.setup.ensureAutomodSettings?.(guildId);
    } catch {
      warnings.push(t('configuration:service.automodInitFailed'));
    }
    for (const channel of await this.deps.setup.listChannels(guildId)) {
      try {
        await this.deps.setup.denyMutedRole(guildId, channel.id, channel.kind);
        succeeded++;
      } catch {
        failed++;
      }
    }
    await this.settings.update(guildId, { mutedRoleId: role });
    if (this.deps.setup.getBotWarnings)
      warnings.push(...(await this.deps.setup.getBotWarnings(guildId)));
    return ok({ mutedRoleId: role, succeeded, failed, warnings });
  }
  public async overview(
    guildId: string,
  ): Promise<Result<Record<string, unknown>>> {
    const settings = await this.overviewDependency('settings', () =>
      this.settings.get(guildId),
    );
    if (!settings.ok)
      throw new ConfigurationOverviewError('settings', settings.error);
    const automod = this.deps.automod;
    const punishments = this.deps.punishments;
    const ignores = this.deps.ignores;
    const setup = this.deps.setup;
    return ok({
      settings: settings.value,
      automod: automod
        ? await this.overviewDependency('automod', () =>
            automod.getOrCreate(guildId),
          )
        : null,
      punishments: punishments
        ? await this.overviewDependency('punishments', () =>
            punishments.list(guildId),
          )
        : [],
      ignoredRoles: ignores
        ? await this.overviewDependency('ignoredRoles', () =>
            ignores.listRoles(guildId),
          )
        : [],
      ignoredChannels: ignores
        ? await this.overviewDependency('ignoredChannels', () =>
            ignores.listChannels(guildId),
          )
        : [],
      automaticIgnoredRoles: setup?.getAutomaticIgnoredRoles
        ? await this.overviewDependency(
            'automaticIgnoredRoles',
            () => setup.getAutomaticIgnoredRoles?.(guildId) ?? [],
          )
        : [],
      botWarnings: setup?.getBotWarnings
        ? await this.overviewDependency(
            'botWarnings',
            () => setup.getBotWarnings?.(guildId) ?? [],
          )
        : [],
      resourceWarnings: await this.overviewDependency(
        'resourceWarnings',
        () =>
          this.automodWarningsProvider?.() ??
          this.deps.automod?.resourceWarnings?.() ??
          [],
      ),
    });
  }

  private async overviewDependency<T>(
    dependency: string,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (cause: unknown) {
      throw new ConfigurationOverviewError(dependency, cause);
    }
  }

  public setAutomodWarningsProvider(provider: () => readonly string[]): void {
    this.automodWarningsProvider = provider;
  }

  /** Repairs legacy/corrupt timezone values instead of allowing them into log rendering. */
  public async getWithTimezoneRepair(
    guildId: string,
  ): Promise<Result<GuildSettingsDto>> {
    const result = await this.settings.get(guildId);
    if (!result.ok) return result;
    if (IANAZone.isValidZone(result.value.timezone)) return result;
    return this.settings.update(guildId, { timezone: 'UTC' });
  }
}

export function formatGuildTime(value: Date, zone: string): string {
  const dt = DateTime.fromJSDate(value, {
    zone: IANAZone.isValidZone(zone) ? zone : 'UTC',
  });
  return dt.toFormat('yyyy-MM-dd HH:mm:ss ZZZZ');
}
