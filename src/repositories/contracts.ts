import { z } from 'zod';
import { punishmentDurationError } from '../domain/punishment.js';

export const SnowflakeSchema = z.string().regex(/^\d{17,20}$/);
const snowflake = SnowflakeSchema;
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);
const json = JsonValueSchema;
export const CaseInputSchema = z.object({
  guildId: snowflake,
  action: z.enum([
    'KICK',
    'BAN',
    'SOFTBAN',
    'SILENTBAN',
    'UNBAN',
    'MUTE',
    'UNMUTE',
    'STRIKE',
    'PARDON',
    'RAIDMODE_ON',
    'RAIDMODE_OFF',
    'VOICEKICK',
    'SLOWMODE',
    'AUTO_PUNISHMENT',
  ]),
  targetUserId: snowflake.nullish(),
  targetDisplay: z.string().max(128),
  moderatorUserId: snowflake,
  reason: z.string().max(1000).nullish(),
  durationSeconds: z.number().int().positive().nullish(),
  source: z.enum([
    'COMMAND',
    'AUTOMOD',
    'PUNISHMENT',
    'RAIDMODE',
    'EXTERNAL',
    'SCHEDULED',
  ]),
  status: z.enum(['PENDING', 'COMPLETED', 'FAILED', 'PARTIAL']),
  metadata: json.optional(),
});
export const StrikeChangeSchema = z
  .object({
    guildId: snowflake,
    userId: snowflake,
    requestedDelta: z.number().int().min(1).max(100),
    source: z.enum(['MANUAL_STRIKE', 'PARDON', 'AUTOMOD']),
    actorUserId: snowflake,
    reason: z.string().min(1).max(1000),
    caseInput: CaseInputSchema,
  })
  .superRefine((value, ctx) => {
    const expected = value.source === 'PARDON' ? 'PARDON' : 'STRIKE';
    if (value.caseInput.guildId !== value.guildId)
      ctx.addIssue({
        code: 'custom',
        path: ['caseInput', 'guildId'],
        message: 'case guild must match strike guild',
      });
    if (value.caseInput.targetUserId !== value.userId)
      ctx.addIssue({
        code: 'custom',
        path: ['caseInput', 'targetUserId'],
        message: 'case target must match strike user',
      });
    if (value.caseInput.action !== expected)
      ctx.addIssue({
        code: 'custom',
        path: ['caseInput', 'action'],
        message: 'case action must match strike source',
      });
  });
export const ScheduledActionInputSchema = z
  .object({
    guildId: snowflake,
    targetUserId: snowflake.nullish(),
    channelId: snowflake.nullish(),
    executeAt: z.date(),
    createdByCaseId: z.uuid().nullish(),
  })
  .and(
    z.discriminatedUnion('type', [
      z.object({
        type: z.literal('UNBAN'),
        payload: z.object({ guildId: snowflake, userId: snowflake }),
      }),
      z.object({
        type: z.literal('UNMUTE'),
        payload: z.object({ guildId: snowflake, userId: snowflake }),
      }),
      z.object({
        type: z.literal('RESTORE_SLOWMODE'),
        payload: z.object({
          guildId: snowflake,
          channelId: snowflake,
          interval: z.number().int().min(0).max(21600),
        }),
      }),
      z.object({
        type: z.literal('DISABLE_RAIDMODE'),
        payload: z.object({ guildId: snowflake }),
      }),
    ]),
  )
  .superRefine((value, ctx) => {
    if (value.payload.guildId !== value.guildId)
      ctx.addIssue({
        code: 'custom',
        path: ['payload', 'guildId'],
        message: 'payload guild must match top-level guild',
      });
    if (value.type === 'UNBAN' || value.type === 'UNMUTE') {
      if (
        value.targetUserId !== value.payload.userId ||
        (value.channelId !== null && value.channelId !== undefined)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['payload', 'userId'],
          message: 'user job target mismatch',
        });
    } else if (value.type === 'RESTORE_SLOWMODE') {
      if (
        value.channelId !== value.payload.channelId ||
        (value.targetUserId !== null && value.targetUserId !== undefined)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['payload', 'channelId'],
          message: 'channel job target mismatch',
        });
    } else if (
      (value.targetUserId !== null && value.targetUserId !== undefined) ||
      (value.channelId !== null && value.channelId !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['type'],
        message: 'raid job cannot target a user or channel',
      });
    }
  });
export const PunishmentActionSchema = z.enum([
  'MUTE',
  'KICK',
  'SOFTBAN',
  'BAN',
]);
export const CaseActionSchema = z.enum([
  'KICK',
  'BAN',
  'SOFTBAN',
  'SILENTBAN',
  'UNBAN',
  'MUTE',
  'UNMUTE',
  'STRIKE',
  'PARDON',
  'RAIDMODE_ON',
  'RAIDMODE_OFF',
  'VOICEKICK',
  'SLOWMODE',
  'AUTO_PUNISHMENT',
]);
export const CaseSourceSchema = z.enum([
  'COMMAND',
  'AUTOMOD',
  'PUNISHMENT',
  'RAIDMODE',
  'EXTERNAL',
  'SCHEDULED',
]);
export const CaseStatusSchema = z.enum([
  'PENDING',
  'COMPLETED',
  'FAILED',
  'PARTIAL',
]);
export const CaseStatusParameterSchema = CaseStatusSchema;
export const MuteReleaseStatusSchema = z.enum(['RELEASED', 'EXPIRED']);
export const WorkerIdSchema = z.string().min(1).max(64);
export const ReasonSchema = z.string().max(1000);
export const ErrorCodeSchema = z.string().min(1).max(64);
/** Shared maximum number of delivery attempts for a scheduled action. A job
 * claimed for the Nth time carries `attempts === N`; once `attempts` reaches
 * this bound the next retryable failure terminates the job (FAILED) instead of
 * re-queueing it. The scheduler repository, the scheduler service, and the
 * scheduled moderation dispatcher all reference this single constant so the
 * retry bound and the "final attempt" terminalization agree. */
export const SCHEDULED_MAX_ATTEMPTS = 5;
export const CaseNumberRowSchema = z.object({
  next_case_number: z.number().int().positive(),
});
export const StrikeCountRowSchema = z.object({
  count: z.number().int().min(0).max(1_000_000),
});
export const IdRowSchema = z.object({ id: z.uuid() });
export const MuteLockRowSchema = z.object({
  guild_id: snowflake,
  user_id: snowflake,
  status: z.enum(['ACTIVE', 'RELEASED', 'EXPIRED']),
  expires_at: z.date().nullish(),
});
export interface GuildSettingsDto {
  guildId: string;
  modlogChannelId?: string | null | undefined;
  messageLogChannelId?: string | null | undefined;
  serverLogChannelId?: string | null | undefined;
  voiceLogChannelId?: string | null | undefined;
  modRoleId?: string | null | undefined;
  mutedRoleId?: string | null | undefined;
  timezone: string;
  raidModeEnabled: boolean;
  raidModeSource?: 'MANUAL' | 'AUTO' | null | undefined;
  raidModeReason?: string | null | undefined;
  raidStartedAt?: Date | null | undefined;
  verificationLevelBeforeRaid?: number | null | undefined;
  raidVerificationChanged: boolean;
  nextCaseNumber: number;
  createdAt: Date;
  updatedAt: Date;
}
export interface AutomodSettingsDto {
  guildId: string;
  antiInviteStrikes: number;
  antiReferralStrikes: number;
  antiEveryoneStrikes: number;
  antiCopypastaStrikes: number;
  maxUserMentions?: number | null | undefined;
  maxRoleMentions?: number | null | undefined;
  maxLines?: number | null | undefined;
  duplicateEnabled: boolean;
  duplicateDeleteThreshold?: number | null | undefined;
  duplicateStrikeThreshold?: number | null | undefined;
  duplicateStrikes: number;
  autodehoistCharacter?: string | null | undefined;
  autoRaidEnabled: boolean;
  autoRaidJoinCount: number;
  autoRaidWindowSeconds: number;
  autoRaidIdleSeconds: number;
  createdAt: Date;
  updatedAt: Date;
}
export interface PunishmentDto {
  id: string;
  guildId: string;
  threshold: number;
  action: PunishmentActionDto;
  durationSeconds?: number | null | undefined;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}
export interface CaseDto {
  id: string;
  guildId: string;
  caseNumber: number;
  action: z.infer<typeof CaseActionSchema>;
  targetUserId?: string | null | undefined;
  targetDisplay: string;
  moderatorUserId: string;
  reason?: string | null | undefined;
  durationSeconds?: number | null | undefined;
  source: z.infer<typeof CaseSourceSchema>;
  status: z.infer<typeof CaseStatusSchema>;
  errorCode?: string | null | undefined;
  logMessageId?: string | null | undefined;
  logChannelId?: string | null | undefined;
  discordAuditLogEntryId?: string | null | undefined;
  metadata: JsonValue;
  createdAt: Date;
  updatedAt: Date;
}
export interface ExternalCaseCreationResult {
  case: CaseDto;
  created: boolean;
}
export interface ScheduledCaseTerminalization {
  readonly jobId: string;
  readonly workerId: string;
  readonly executedCaseId: string;
}
export interface ScheduledCaseCreationResult {
  readonly case: CaseDto;
  readonly created: boolean;
  readonly terminalization: ScheduledCaseTerminalization;
}
export interface ScheduledCaseTerminalizationInput extends ScheduledCaseTerminalization {
  readonly status: 'COMPLETED' | 'FAILED';
  readonly errorCode?: string | null | undefined;
}
export interface JobDto {
  id: string;
  guildId: string;
  targetUserId?: string | null;
  channelId?: string | null;
  type: ScheduledActionInput['type'];
  executeAt: Date;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  payload: JsonValue;
  attempts: number;
  lockedAt?: Date | null;
  lockedBy?: string | null;
  lastError?: string | null;
  createdByCaseId?: string | null;
  executedCaseId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface SnapshotDto {
  messageId: string;
  guildId: string;
  channelId: string;
  authorUserId: string;
  authorDisplay: string;
  content: string;
  attachments: JsonValue;
  embedsSummary: JsonValue;
  createdAt: Date;
  editedAt: Date | null;
  expiresAt: Date;
}
export const IgnoreRoleSchema = z.object({
  guildId: snowflake,
  roleId: snowflake,
  createdBy: snowflake,
  createdAt: z.date(),
});
export const IgnoreChannelSchema = z.object({
  guildId: snowflake,
  channelId: snowflake,
  createdBy: snowflake,
  createdAt: z.date(),
});
export const MemberSnapshotDtoSchema = z.object({
  guildId: snowflake,
  userId: snowflake,
  username: z.string().max(32),
  globalName: z.string().max(32).nullish(),
  nickname: z.string().max(32).nullish(),
  joinedAt: z.date().nullish(),
  updatedAt: z.date(),
});
export interface MuteDto {
  guildId: string;
  userId: string;
  caseId: string;
  expiresAt?: Date | null | undefined;
  status: 'ACTIVE' | 'RELEASED' | 'EXPIRED';
  createdAt: Date;
  updatedAt: Date;
}
export interface RaidResultDto {
  activated: boolean;
  count: number;
  settings?: GuildSettingsDto;
  case?: CaseDto;
}
/** Result of a conditional, idempotent manual OFF transition performed under
 * the guild lock. `changed` is false when the raid was already off (a
 * concurrent OFF won the race); `case` is the single reusable OFF case created
 * by the winning transition; `restoreLevel` is the captured pre-raid
 * verification level when ownership was confirmed, else null. */
export interface RaidDeactivationDto {
  readonly changed: boolean;
  readonly settings: GuildSettingsDto;
  readonly case?: CaseDto;
  readonly restoreLevel: number | null;
}
/** Result of the locked AUTO idle-disable evaluation. When `disabled` is true
 * the transition and the single OFF case were committed atomically; `restoreLevel`
 * carries the confirmed ownership level. When not idle, the repository keeps the
 * disable deadline at the latest-join deadline (max-only) inside the transaction;
 * the service performs no deadline replacement. */
export interface RaidAutoDisableDto {
  readonly disabled: boolean;
  readonly settings?: GuildSettingsDto;
  readonly case?: CaseDto;
  readonly restoreLevel?: number | null;
}
export interface LifecycleDto {
  guildId: string;
  status: 'ACTIVE' | 'LEFT';
  departedAt?: Date | null | undefined;
  rejoinedAt?: Date | null | undefined;
  cleanupEligibleAt?: Date | null | undefined;
  createdAt: Date;
  updatedAt: Date;
}
export const CaseDtoSchema = z.object({
  id: z.uuid(),
  guildId: snowflake,
  caseNumber: z.number().int().positive(),
  action: CaseActionSchema,
  targetUserId: snowflake.nullish(),
  targetDisplay: z.string(),
  moderatorUserId: snowflake,
  reason: z.string().nullish(),
  durationSeconds: z.number().int().positive().nullish(),
  source: CaseSourceSchema,
  status: CaseStatusSchema,
  errorCode: z.string().nullish(),
  logMessageId: snowflake.nullish(),
  logChannelId: snowflake.nullish(),
  discordAuditLogEntryId: snowflake.nullish(),
  metadata: JsonValueSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
});
export const GuildSettingsDtoSchema = z.object({
  guildId: snowflake,
  modlogChannelId: snowflake.nullish(),
  messageLogChannelId: snowflake.nullish(),
  serverLogChannelId: snowflake.nullish(),
  voiceLogChannelId: snowflake.nullish(),
  modRoleId: snowflake.nullish(),
  mutedRoleId: snowflake.nullish(),
  timezone: z.string().max(64),
  raidModeEnabled: z.boolean(),
  raidModeSource: z.enum(['MANUAL', 'AUTO']).nullish(),
  raidModeReason: z.string().max(1000).nullish(),
  raidStartedAt: z.date().nullish(),
  verificationLevelBeforeRaid: z.number().int().min(0).max(4).nullish(),
  raidVerificationChanged: z.boolean(),
  nextCaseNumber: z.number().int().positive(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export const AutomodSettingsDtoSchema = z.object({
  guildId: snowflake,
  antiInviteStrikes: z.number().int().min(0).max(100),
  antiReferralStrikes: z.number().int().min(0).max(100),
  antiEveryoneStrikes: z.number().int().min(0).max(100),
  antiCopypastaStrikes: z.number().int().min(0).max(100),
  maxUserMentions: z.number().int().min(1).max(100).nullish(),
  maxRoleMentions: z.number().int().min(1).max(100).nullish(),
  maxLines: z.number().int().min(1).max(500).nullish(),
  duplicateEnabled: z.boolean(),
  duplicateDeleteThreshold: z.number().int().min(2).max(20).nullish(),
  duplicateStrikeThreshold: z.number().int().min(2).max(20).nullish(),
  duplicateStrikes: z.number().int().min(1).max(100),
  autodehoistCharacter: z.string().max(8).nullish(),
  autoRaidEnabled: z.boolean(),
  autoRaidJoinCount: z.number().int().min(3).max(100),
  autoRaidWindowSeconds: z.number().int().min(2).max(300),
  autoRaidIdleSeconds: z.literal(120),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export const PunishmentDtoSchema = z.object({
  id: z.uuid(),
  guildId: snowflake,
  threshold: z.number().int().min(1).max(1_000_000),
  action: PunishmentActionSchema,
  durationSeconds: z.number().int().positive().nullish(),
  createdBy: snowflake,
  createdAt: z.date(),
  updatedAt: z.date(),
});
export const StrikeTransactionDtoSchema = z.object({
  id: z.uuid(),
  guildId: snowflake,
  userId: snowflake,
  delta: z
    .number()
    .int()
    .refine((value) => value !== 0),
  requestedDelta: z.number().int().min(1).max(100),
  beforeCount: z.number().int().min(0).max(1_000_000),
  afterCount: z.number().int().min(0).max(1_000_000),
  source: z.enum(['MANUAL_STRIKE', 'PARDON', 'AUTOMOD']),
  actorUserId: snowflake,
  reason: z.string().max(1000),
  modCaseId: z.uuid().nullish(),
  createdAt: z.date(),
});
export const JobDtoSchema = z.object({
  id: z.uuid(),
  guildId: snowflake,
  targetUserId: snowflake.nullish(),
  channelId: snowflake.nullish(),
  type: z.enum(['UNBAN', 'UNMUTE', 'RESTORE_SLOWMODE', 'DISABLE_RAIDMODE']),
  executeAt: z.date(),
  status: z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']),
  payload: JsonValueSchema,
  attempts: z.number().int().min(0).max(5),
  lockedAt: z.date().nullish(),
  lockedBy: z.string().max(64).nullish(),
  lastError: z.string().nullish(),
  createdByCaseId: z.uuid().nullish(),
  executedCaseId: z.uuid().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export const MuteDtoSchema = z.object({
  guildId: snowflake,
  userId: snowflake,
  caseId: z.uuid(),
  expiresAt: z.date().nullish(),
  status: z.enum(['ACTIVE', 'RELEASED', 'EXPIRED']),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export const SnapshotDtoSchema = z.object({
  messageId: snowflake,
  guildId: snowflake,
  channelId: snowflake,
  authorUserId: snowflake,
  authorDisplay: z.string().max(128),
  content: z.string().max(4000),
  attachments: JsonValueSchema,
  embedsSummary: JsonValueSchema,
  createdAt: z.date(),
  editedAt: z.date().nullish(),
  expiresAt: z.date(),
});
export const LifecycleDtoSchema = z.object({
  guildId: snowflake,
  status: z.enum(['ACTIVE', 'LEFT']),
  departedAt: z.date().nullish(),
  rejoinedAt: z.date().nullish(),
  cleanupEligibleAt: z.date().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export const JobPayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('UNBAN'),
    payload: z.object({ guildId: snowflake, userId: snowflake }),
  }),
  z.object({
    type: z.literal('UNMUTE'),
    payload: z.object({ guildId: snowflake, userId: snowflake }),
  }),
  z.object({
    type: z.literal('RESTORE_SLOWMODE'),
    payload: z.object({
      guildId: snowflake,
      channelId: snowflake,
      interval: z.number().int().min(0).max(21600),
    }),
  }),
  z.object({
    type: z.literal('DISABLE_RAIDMODE'),
    payload: z.object({ guildId: snowflake }),
  }),
]);
export const RaidActivationSchema = z
  .object({
    guildId: snowflake,
    actorUserId: snowflake,
    source: z.enum(['MANUAL', 'AUTO']),
    reason: z.string().max(1000).nullish(),
    verificationLevelBeforeRaid: z.number().int().min(0).max(4).nullish(),
    changed: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.guildId !== value.guildId)
      ctx.addIssue({
        code: 'custom',
        path: ['guildId'],
        message: 'activation guild mismatch',
      });
  });
export const RaidEvaluationSchema = z.object({
  guildId: snowflake,
  userId: snowflake,
  joinedAt: z.date(),
  threshold: z.number().int().min(3).max(100),
  windowSeconds: z.number().int().min(2).max(300),
});
export const DepartureSchema = z.object({
  guildId: snowflake,
  departedAt: z.date(),
});

export type CaseInput = z.infer<typeof CaseInputSchema>;
export type StrikeChange = z.infer<typeof StrikeChangeSchema>;
export type ScheduledActionInput = z.infer<typeof ScheduledActionInputSchema>;
export type PunishmentActionDto = z.infer<typeof PunishmentActionSchema>;
export type RaidActivation = z.infer<typeof RaidActivationSchema>;
export type Departure = z.infer<typeof DepartureSchema>;
export interface StrikeTransactionDto {
  id: string;
  guildId: string;
  userId: string;
  delta: number;
  requestedDelta: number;
  beforeCount: number;
  afterCount: number;
  source: 'MANUAL_STRIKE' | 'PARDON' | 'AUTOMOD';
  actorUserId: string;
  reason: string;
  modCaseId?: string | null | undefined;
  createdAt: Date;
}
export type StrikeResult = {
  beforeCount: number;
  afterCount: number;
  delta: number;
  crossedPunishments: PunishmentDto[];
  transaction: StrikeTransactionDto | null;
};

export interface GuildSettingsRepository {
  get(guildId: string): Promise<GuildSettingsDto | null>;
  getOrCreate(guildId: string): Promise<GuildSettingsDto>;
  update(
    guildId: string,
    patch: GuildSettingsUpdate,
  ): Promise<GuildSettingsDto>;
}

export interface GeneralRepository {
  ping(): Promise<void>;
  getStats(): Promise<{ cases: number; strikes: number }>;
}
export interface GuildSettingsUpdate {
  modlogChannelId?: string | null;
  messageLogChannelId?: string | null;
  serverLogChannelId?: string | null;
  voiceLogChannelId?: string | null;
  modRoleId?: string | null;
  mutedRoleId?: string | null;
  timezone?: string;
  raidModeEnabled?: boolean;
  raidModeReason?: string | null;
}
export const GuildSettingsUpdateSchema = z.object({
  modlogChannelId: snowflake.nullish(),
  messageLogChannelId: snowflake.nullish(),
  serverLogChannelId: snowflake.nullish(),
  voiceLogChannelId: snowflake.nullish(),
  modRoleId: snowflake.nullish(),
  mutedRoleId: snowflake.nullish(),
  timezone: z.string().max(64).optional(),
  raidModeEnabled: z.boolean().optional(),
  raidModeReason: z.string().max(1000).nullish(),
});
export interface AutomodRepository {
  getOrCreate(guildId: string): Promise<AutomodSettingsDto>;
  update(
    guildId: string,
    patch: AutomodSettingsUpdate,
  ): Promise<AutomodSettingsDto>;
}
export interface AutomodSettingsUpdate {
  antiInviteStrikes?: number;
  antiReferralStrikes?: number;
  antiEveryoneStrikes?: number;
  antiCopypastaStrikes?: number;
  maxUserMentions?: number | null;
  maxRoleMentions?: number | null;
  maxLines?: number | null;
  duplicateEnabled?: boolean;
  duplicateDeleteThreshold?: number | null;
  duplicateStrikeThreshold?: number | null;
  duplicateStrikes?: number;
  autodehoistCharacter?: string | null;
  autoRaidEnabled?: boolean;
  autoRaidJoinCount?: number;
  autoRaidWindowSeconds?: number;
}
export const AutomodSettingsUpdateSchema = z.object({
  antiInviteStrikes: z.number().int().min(0).max(100).optional(),
  antiReferralStrikes: z.number().int().min(0).max(100).optional(),
  antiEveryoneStrikes: z.number().int().min(0).max(100).optional(),
  antiCopypastaStrikes: z.number().int().min(0).max(100).optional(),
  maxUserMentions: z.number().int().min(1).max(100).nullish(),
  maxRoleMentions: z.number().int().min(1).max(100).nullish(),
  maxLines: z.number().int().min(1).max(500).nullish(),
  duplicateEnabled: z.boolean().optional(),
  duplicateDeleteThreshold: z.number().int().min(2).max(20).nullish(),
  duplicateStrikeThreshold: z.number().int().min(2).max(20).nullish(),
  duplicateStrikes: z.number().int().min(1).max(100).optional(),
  autodehoistCharacter: z.string().max(8).nullish(),
  autoRaidEnabled: z.boolean().optional(),
  autoRaidJoinCount: z.number().int().min(3).max(100).optional(),
  autoRaidWindowSeconds: z.number().int().min(2).max(300).optional(),
});
/** Write-boundary guard for `PunishmentRepository.replace`. Enforces the same
 * action-specific duration policy as the domain schema and the public
 * configuration service so an impossible rule can never be newly persisted,
 * even by a caller that bypasses the service. Read schemas stay lenient so
 * legacy rows are never rejected or reinterpreted on load. */
export const PunishmentParametersSchema = z
  .object({
    guildId: snowflake,
    threshold: z.number().int().min(1).max(1_000_000),
    action: PunishmentActionSchema,
    durationSeconds: z.number().int().positive().nullish(),
    actor: snowflake,
  })
  .superRefine((value, context) => {
    const message = punishmentDurationError(
      value.action,
      value.durationSeconds,
    );
    if (message)
      context.addIssue({
        code: 'custom',
        path: ['durationSeconds'],
        message,
      });
  });
export interface PunishmentRepository {
  replace(
    guildId: string,
    threshold: number,
    action: PunishmentActionDto,
    durationSeconds: number | null,
    actor: string,
  ): Promise<PunishmentDto>;
  list(guildId: string): Promise<PunishmentDto[]>;
  crossed(
    guildId: string,
    before: number,
    after: number,
  ): Promise<PunishmentDto[]>;
  remove(guildId: string, threshold: number): Promise<boolean>;
}
export interface IgnoreRepository {
  setRole(guildId: string, roleId: string, actor: string): Promise<void>;
  setChannel(guildId: string, channelId: string, actor: string): Promise<void>;
  removeRole(guildId: string, roleId: string): Promise<void>;
  removeChannel(guildId: string, channelId: string): Promise<void>;
  clearChannel(guildId: string, channelId: string): Promise<number>;
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
}
export interface SnapshotRepository {
  upsertMessage(input: MessageSnapshotInput): Promise<SnapshotDto>;
  upsertMember(input: MemberSnapshotInput): Promise<MemberSnapshotDto>;
  deleteExpired(now?: Date): Promise<number>;
  deleteMessage(messageId: string): Promise<void>;
  /** Bulk deletion for `messageDeleteBulk`; returns the number of rows removed. */
  deleteMessages(messageIds: string[]): Promise<number>;
  deleteMember(guildId: string, userId: string): Promise<void>;
  getMessage(messageId: string): Promise<SnapshotDto | null>;
  getMessages(messageIds: string[]): Promise<SnapshotDto[]>;
  getMember(guildId: string, userId: string): Promise<MemberSnapshotDto | null>;
  listMembersForUser(userId: string): Promise<MemberSnapshotDto[]>;
}
export interface MessageSnapshotInput {
  messageId: string;
  guildId: string;
  channelId: string;
  authorUserId: string;
  authorDisplay: string;
  content: string;
  attachments: JsonValue;
  embedsSummary: JsonValue;
  createdAt?: Date;
  editedAt?: Date | null;
  expiresAt: Date;
}
export const MessageSnapshotInputSchema = z.object({
  messageId: snowflake,
  guildId: snowflake,
  channelId: snowflake,
  authorUserId: snowflake,
  authorDisplay: z.string().max(128),
  content: z.string().max(4000),
  attachments: JsonValueSchema,
  embedsSummary: JsonValueSchema,
  createdAt: z.date().optional(),
  editedAt: z.date().nullish(),
  expiresAt: z.date(),
});
export interface MemberSnapshotInput {
  guildId: string;
  userId: string;
  username: string;
  globalName?: string | null | undefined;
  nickname?: string | null | undefined;
  joinedAt?: Date | null | undefined;
}
export const MemberSnapshotInputSchema = z.object({
  guildId: snowflake,
  userId: snowflake,
  username: z.string().max(32),
  globalName: z.string().max(32).nullish(),
  nickname: z.string().max(32).nullish(),
  joinedAt: z.date().nullish(),
});
export interface MemberSnapshotDto extends MemberSnapshotInput {
  updatedAt: Date;
  globalName?: string | null | undefined;
  nickname?: string | null | undefined;
  joinedAt?: Date | null | undefined;
}
export interface RaidRepository {
  recordJoin(guildId: string, userId: string, joinedAt: Date): Promise<void>;
  recordJoinAndEvaluate(
    guildId: string,
    userId: string,
    joinedAt: Date,
    threshold: number,
    windowSeconds: number,
    activation: RaidActivation,
  ): Promise<RaidResultDto>;
  activate(input: RaidActivation): Promise<GuildSettingsDto>;
  activateManual(input: RaidActivation): Promise<RaidResultDto>;
  /** Confirms verification ownership after a successful Discord raise. */
  markVerificationRaised(guildId: string): Promise<GuildSettingsDto>;
  /** Conditional, idempotent OFF transition + single OFF case under the lock. */
  deactivateWithCase(input: {
    guildId: string;
    actorUserId: string;
    reason: string;
  }): Promise<RaidDeactivationDto>;
  disableAutoIfIdle(
    guildId: string,
    now: Date,
    actorUserId: string,
  ): Promise<RaidAutoDisableDto>;
}
export interface ActiveMuteRepository {
  getActive(guildId: string, userId: string): Promise<MuteDto | null>;
  activateWithSchedule(
    guildId: string,
    userId: string,
    caseId: string,
    expiresAt: Date | null,
    payload: JsonValue,
  ): Promise<MuteDto>;
  releaseWithSchedule(
    guildId: string,
    userId: string,
    status: 'RELEASED' | 'EXPIRED',
  ): Promise<boolean>;
  expireWithSchedule(
    guildId: string,
    userId: string,
    jobId: string,
    workerId: string,
    now?: Date,
  ): Promise<boolean>;
  /** Verifies the claimed job still owns the active mute immediately before
   * an external role mutation. */
  verifyScheduledUnmute(
    guildId: string,
    userId: string,
    jobId: string,
    workerId: string,
  ): Promise<boolean>;
  claimScheduledUnmute(
    guildId: string,
    userId: string,
    jobId: string,
    workerId: string,
  ): Promise<boolean>;
  /** Mute-side compare-and-swap: expires only the matching `ACTIVE` mute whose
   * `caseId`/expiry still agree with the claimed job, and leaves the job
   * `RUNNING`. Job terminalization is the dispatcher's responsibility (via
   * `terminalizeScheduledCase`) so the case/modlog boundary stays independent of
   * the mute transition. Returns `false` when the mute no longer matches. */
  completeScheduledUnmute(
    guildId: string,
    userId: string,
    jobId: string,
    workerId: string,
  ): Promise<boolean>;
  restoreScheduledUnmute(
    guildId: string,
    userId: string,
    jobId: string,
    workerId: string,
  ): Promise<boolean>;
}
export interface CaseRepository {
  createWithNumber(input: CaseInput): Promise<CaseDto>;
  updateReason(id: string, reason: string): Promise<CaseDto>;
  get(id: string): Promise<CaseDto | null>;
  updateStatus(
    id: string,
    status: CaseInput['status'],
    errorCode?: string,
  ): Promise<CaseDto>;
  listForTarget(guildId: string, targetUserId: string): Promise<CaseDto[]>;
  findByGuildAndNumber(
    guildId: string,
    caseNumber: number,
  ): Promise<CaseDto | null>;
  /** Selects the newest case in a guild whose reason is still missing
   * (`NULL`, empty, or the `理由未指定` default). The selection is
   * guild-wide: the single newest eligible missing-reason case is returned
   * regardless of which moderator created it. */
  latest(guildId: string): Promise<CaseDto | null>;
  updateMetadata(id: string, metadata: JsonValue): Promise<CaseDto>;
  updateLog(
    id: string,
    logChannelId: string | null,
    logMessageId: string | null,
  ): Promise<CaseDto>;
  updateAudit(id: string, auditEntryId: string | null): Promise<CaseDto>;
  createExternalWithAudit(
    input: CaseInput & { discordAuditLogEntryId: string },
  ): Promise<CaseDto>;
  createExternalWithAuditResult(
    input: CaseInput & { discordAuditLogEntryId: string },
  ): Promise<ExternalCaseCreationResult>;
}
export interface StrikeRepository {
  changeLocked(input: StrikeChange): Promise<StrikeResult>;
  history(guildId: string, userId: string): Promise<StrikeTransactionDto[]>;
}
export interface SchedulerRepository {
  scheduleReplacing(input: ScheduledActionInput): Promise<JobDto>;
  cancelTarget(
    input: Pick<
      ScheduledActionInput,
      'guildId' | 'targetUserId' | 'channelId' | 'type'
    >,
  ): Promise<number>;
  claimDue(
    limit: number,
    workerId: string,
    now?: Date,
    supportedTypes?: readonly JobDto['type'][],
  ): Promise<JobDto[]>;
  complete(id: string, workerId: string): Promise<boolean>;
  fail(
    id: string,
    workerId: string,
    error: string,
    retryable: boolean,
  ): Promise<boolean>;
  recoverStale(now?: Date, workerTimeoutMs?: number): Promise<number>;
  findPending(
    guildId: string,
    targetUserId: string | null,
    channelId: string | null,
    type: ScheduledActionInput['type'],
  ): Promise<JobDto | null>;
  getStatus(id: string): Promise<JobDto['status'] | null>;
  createScheduledCase(
    jobId: string,
    workerId: string,
    fallbackModeratorUserId: string,
  ): Promise<ScheduledCaseCreationResult>;
  terminalizeScheduledCase(
    input: ScheduledCaseTerminalizationInput,
  ): Promise<boolean>;
}
export interface DepartureRepository {
  markLeft(input: Departure): Promise<LifecycleDto>;
  markActive(guildId: string, at?: Date): Promise<LifecycleDto>;
  cleanupEligible(now?: Date): Promise<number>;
}
export interface RetentionRepository {
  deleteExpiredSnapshots(now?: Date): Promise<number>;
  deleteOldRaidEvents(now?: Date): Promise<number>;
  deleteOldScheduledActions(now?: Date): Promise<number>;
}
