import type { ModerationService } from '../moderation/moderation-service.js';
import type {
  PunishmentDto,
  StrikeRepository,
  StrikeTransactionDto,
} from '../../repositories/contracts.js';
import type { CaseService } from '../../services/case-service.js';
import type { SettingsService } from '../../services/settings-service.js';

export interface StrikeDiscordPort {
  getUser(
    guildId: string,
    userId: string,
  ): Promise<{ id: string; display?: string } | null>;
  getMember(
    guildId: string,
    userId: string,
  ): Promise<{ id: string; displayName: string; rolePosition: number } | null>;
  isBanned(guildId: string, userId: string): Promise<boolean>;
  getBanExpiresAt?(guildId: string, userId: string): Promise<Date | null>;
  getGuildName?(guildId: string): Promise<string>;
  getBotUserId?(guildId: string): Promise<string>;
  hasMutedRole?(
    guildId: string,
    userId: string,
    roleId: string,
  ): Promise<boolean>;
  sendDm(userId: string, content: string): Promise<void>;
}

export interface StrikeServiceDependencies {
  readonly strikes: StrikeRepository;
  readonly cases: CaseService;
  readonly punishments: {
    list(guildId: string): Promise<PunishmentDto[]>;
    set?: PunishmentConfiguration['set'];
    remove?: PunishmentConfiguration['remove'];
  };
  readonly moderation: ModerationService;
  readonly discord: StrikeDiscordPort;
  readonly settings?: SettingsService;
  readonly activeMutes?: {
    getActive(
      guildId: string,
      userId: string,
    ): Promise<{ expiresAt?: Date | null | undefined } | null>;
  };
  readonly modlog?: {
    write(guildId: string, event: unknown, caseId?: string): Promise<unknown>;
  };
  readonly clock?: () => Date;
}
type PunishmentConfiguration = {
  set: (
    guildId: string,
    threshold: number,
    action: 'MUTE' | 'KICK' | 'SOFTBAN' | 'BAN',
    durationSeconds: number | null,
    actor: string,
  ) => Promise<PunishmentDto>;
  remove: (guildId: string, threshold: number) => Promise<boolean>;
};

export interface StrikeChangeInput {
  readonly guildId: string;
  readonly userId: string;
  readonly actorId: string;
  readonly amount: number;
  readonly reason: string;
  readonly display?: string;
  readonly evidence?: readonly unknown[];
  readonly warnings?: readonly string[];
}

export interface StrikeCheck {
  readonly count: number;
  readonly muted: boolean;
  readonly banned: boolean | null;
  readonly banExpiresAt?: Date | null;
  readonly history: readonly StrikeTransactionDto[];
  readonly next: PunishmentDto | null;
  readonly muteExpiresAt?: Date | null;
}
