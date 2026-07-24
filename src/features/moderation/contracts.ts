import type { CaseDto, JsonValue } from '../../repositories/contracts.js';
import type { Result } from '../../domain/result.js';
import type { SettingsService } from '../../services/settings-service.js';
import type { TargetIdentity } from '../../services/target-identity.js';

export type ModerationAction =
  | 'KICK'
  | 'BAN'
  | 'SILENTBAN'
  | 'SOFTBAN'
  | 'UNBAN'
  | 'MUTE'
  | 'UNMUTE'
  | 'SLOWMODE';
/** Actions currently owned by ModerationService. Other feature actions use
 * their own public service contracts and must not be smuggled through here. */
export type ModerationExecutionAction = ModerationAction;

export interface ModerationTarget {
  readonly id: string;
  readonly display?: string;
  readonly globalName?: string | null;
  readonly username?: string;
  readonly identity?: TargetIdentity;
}

export interface MemberSnapshot {
  readonly id: string;
  readonly displayName: string;
  readonly isOwner: boolean;
  readonly isBot: boolean;
  readonly rolePosition: number;
  readonly isMember?: boolean;
}

export interface ModerationDiscordPort {
  getUser(guildId: string, userId: string): Promise<ModerationTarget | null>;
  getMember(guildId: string, userId: string): Promise<MemberSnapshot | null>;
  getBotRolePosition(guildId: string): Promise<number>;
  getBotUserId(guildId: string): Promise<string>;
  getActorRolePosition?(guildId: string, userId: string): Promise<number>;
  getActorIsOwner?(guildId: string, userId: string): Promise<boolean>;
  kick(guildId: string, userId: string, auditReason: string): Promise<void>;
  ban(
    guildId: string,
    userId: string,
    deleteMessageSeconds: number,
    auditReason: string,
  ): Promise<void>;
  unban(guildId: string, userId: string, auditReason: string): Promise<void>;
  isBanned(guildId: string, userId: string): Promise<boolean>;
  hasRole(guildId: string, userId: string, roleId: string): Promise<boolean>;
  addRole(
    guildId: string,
    userId: string,
    roleId: string,
    auditReason: string,
  ): Promise<void>;
  removeRole(
    guildId: string,
    userId: string,
    roleId: string,
    auditReason: string,
  ): Promise<void>;
  sendDm(userId: string, content: string): Promise<void>;
  setSlowmode(
    channelId: string,
    interval: number,
    auditReason: string,
  ): Promise<void>;
  getSlowmode(channelId: string): Promise<number>;
  fetchMessages(
    channelId: string,
    before?: string,
    limit?: number,
  ): Promise<ReadonlyArray<ModerationMessage>>;
  deleteMessages(
    channelId: string,
    messageIds: readonly string[],
  ): Promise<void>;
  deleteMessage(channelId: string, messageId: string): Promise<void>;
}

export interface ModerationMessage {
  readonly id: string;
  readonly authorId: string;
  readonly authorIsBot: boolean;
  readonly webhook: boolean;
  readonly content: string;
  readonly embeds: number;
  readonly embedMedia?: boolean;
  readonly attachments: ReadonlyArray<{ readonly contentType?: string | null }>;
  readonly createdAt: Date;
}

export interface ModerationOperationOptions {
  readonly guildId: string;
  readonly actorId: string;
  readonly targets: readonly ModerationTarget[];
  readonly reason?: string;
  readonly durationSeconds?: number;
  readonly deleteMessages?: number;
  readonly execution?: ModerationExecutionContext;
}

export interface ModerationExecutionContext {
  readonly source: 'COMMAND' | 'AUTO_PUNISHMENT' | 'RAIDMODE' | 'SCHEDULED';
  readonly action?: ModerationExecutionAction;
  readonly reason?: string;
  readonly sendDm?: boolean;
  readonly waitForDm?: boolean;
  /** A caller may allocate the case transactionally before invoking moderation. */
  readonly preCreatedCase?: CaseDto;
  /** Reserved for scheduled callers that deliberately do not allocate a case. */
}

export interface TargetOutcome {
  readonly targetId: string;
  readonly ok: boolean;
  readonly code?: string;
  /** Underlying Discord HTTP status preserved from the enforcement failure (if
   * any). Scheduled callers classify on this so a 401 stays fatal, 400/403
   * terminalize FAILED, and 5xx/network errors stay retryable. */
  readonly status?: number;
  readonly case?: CaseDto;
  readonly identity?: TargetIdentity;
}

export interface ModerationBatchResult {
  readonly action: ModerationExecutionAction;
  readonly outcomes: readonly TargetOutcome[];
}

export interface ModerationServiceDependencies {
  readonly discord: ModerationDiscordPort;
  readonly cases: import('../../services/case-service.js').CaseService;
  readonly scheduler: import('../../services/scheduler-service.js').SchedulerService;
  readonly activeMutes: import('../../repositories/contracts.js').ActiveMuteRepository;
  readonly settings: SettingsService;
  /** Configurable bulk-target ceiling (`MAX_BULK_TARGETS`, 1..20). Defaults to
   * the static cap of 20 and is clamped so it can never exceed that ceiling. */
  readonly maxBulkTargets?: number;
  readonly targetIdentityResolver?: {
    resolve(
      guildId: string,
      userId: string,
      context?: { member?: { displayName?: unknown } | null },
    ): Promise<TargetIdentity>;
  };
  readonly fatal?: (error: unknown) => void;
  readonly modlog?: {
    write(guildId: string, event: unknown, caseId?: string): Promise<unknown>;
    editReason?(guildId: string, caseId: string, reason: string): Promise<void>;
    writeCase(guildId: string, caseId: string): Promise<unknown>;
  };
  readonly clock?: () => Date;
  readonly correlation?: {
    add?(key: string, value: unknown): void;
    put?(kind: 'moderation', key: string, value: { caseId: string }): unknown;
    putSlowmode?(
      key: string,
      value: { previousInterval: number; newInterval: number },
    ): unknown;
  };
  readonly roleMutationLock?: <T>(
    guildId: string,
    userId: string,
    operation: () => Promise<T>,
  ) => Promise<T>;
  readonly addRoleUnlocked?: ModerationDiscordPort['addRole'];
  readonly removeRoleUnlocked?: ModerationDiscordPort['removeRole'];
  readonly hasRoleUnlocked?: (
    guildId: string,
    userId: string,
    roleId: string,
  ) => Promise<boolean>;
  readonly roleCorrelation?: {
    put(
      guildId: string,
      targetUserId: string,
      roleId: string,
      direction: 'ADD' | 'REMOVE',
    ): void;
    remove(
      guildId: string,
      targetUserId: string,
      roleId: string,
      direction: 'ADD' | 'REMOVE',
    ): void;
  };
}

export type ModerationResult = Result<ModerationBatchResult>;
export type Metadata = JsonValue;
