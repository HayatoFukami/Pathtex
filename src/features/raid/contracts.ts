import type {
  CaseDto,
  GuildSettingsDto,
  RaidRepository,
} from '../../repositories/contracts.js';
import type { Result } from '../../domain/result.js';
import type { SettingsService } from '../../services/settings-service.js';
import type { SchedulerService } from '../../services/scheduler-service.js';
import type { ModerationService } from '../moderation/moderation-service.js';
import type { CaseService } from '../../services/case-service.js';

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
  readonly scheduler: SchedulerService;
  readonly moderation: ModerationService;
  readonly cases: CaseService;
  readonly discord: RaidDiscordPort;
  readonly modlog?: {
    write(guildId: string, event: unknown, caseId?: string): Promise<unknown>;
  };
  readonly clock?: () => Date;
}

export type RaidResult = Result<{ settings: GuildSettingsDto; case?: CaseDto }>;
