import type {
  AutomodSettingsDto,
  CaseDto,
  GuildSettingsDto,
  RaidRepository,
} from '../../repositories/contracts.js';
import type { Logger } from 'pino';
import type { Result } from '../../domain/result.js';
import type { SettingsService } from '../../services/settings-service.js';
import type { ModerationService } from '../moderation/moderation-service.js';
import type { TargetIdentity } from '../../services/target-identity.js';

export interface RaidDiscordPort {
  getVerificationLevel(guildId: string): Promise<number>;
  setVerificationLevel(
    guildId: string,
    level: number,
    reason: string,
  ): Promise<void>;
  getBotUserId(guildId: string): Promise<string>;
  sendDm(userId: string, content: string): Promise<void>;
  getGuildName(guildId: string): Promise<string>;
}

export interface RaidDependencies {
  readonly repository: RaidRepository;
  readonly settings: SettingsService;
  readonly automod: {
    getOrCreate(
      guildId: string,
    ): Promise<import('../../repositories/contracts.js').AutomodSettingsDto>;
    update(
      guildId: string,
      patch: import('../../repositories/contracts.js').AutomodSettingsUpdate,
    ): Promise<import('../../repositories/contracts.js').AutomodSettingsDto>;
  };
  readonly moderation: ModerationService;
  /** Shared identity resolver; Raid supplies the joining member as context. */
  readonly targetIdentityResolver?: {
    resolve(
      guildId: string,
      userId: string,
      context?: { member?: { displayName?: unknown } | null },
    ): Promise<TargetIdentity>;
  };
  readonly discord: RaidDiscordPort;
  readonly modlog?: {
    write(guildId: string, event: unknown, caseId?: string): Promise<unknown>;
    writeCase(guildId: string, caseId: string): Promise<unknown>;
  };
  /** Operational warnings (e.g. a failed verification raise) are emitted here. */
  readonly logger?: Logger;
  readonly clock?: () => Date;
}

export type RaidResult = Result<{ settings: GuildSettingsDto; case?: CaseDto }>;

/** `/raidmode status` result: the guild's raid state plus the AutoRaid
 * settings, which §5.3.12 lists among the status display items (AutoRaid設定). */
export type RaidStatusResult = Result<{
  readonly settings: GuildSettingsDto;
  readonly autoRaid: AutomodSettingsDto;
}>;

export interface RaidMemberAdd {
  readonly guildId: string;
  readonly userId: string;
  readonly isBot: boolean;
  /** The event's already-resolved identity, when the adapter has one. */
  readonly identity?: TargetIdentity;
  /** Raw member display name used only as resolver context. */
  readonly displayName?: unknown;
}
