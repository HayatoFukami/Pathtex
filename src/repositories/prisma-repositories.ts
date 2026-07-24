import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type {
  CaseInput,
  StrikeChange,
  ScheduledActionInput,
  GuildSettingsRepository,
  CaseRepository,
  StrikeRepository,
  SchedulerRepository,
  RetentionRepository,
  PunishmentActionDto,
  CaseDto,
  ExternalCaseCreationResult,
  RaidResultDto,
  JobDto,
  ScheduledCaseCreationResult,
  ScheduledCaseTerminalizationInput,
  MessageSnapshotInput,
  MemberSnapshotInput,
  JsonValue,
  GuildSettingsUpdate,
  AutomodSettingsUpdate,
  AutomodRepository,
  PunishmentRepository,
  IgnoreRepository,
  SnapshotRepository,
  RaidRepository,
  ActiveMuteRepository,
  DepartureRepository,
  StrikeResult,
} from './contracts.js';
import {
  CaseInputSchema,
  DepartureSchema,
  RaidActivationSchema,
  ScheduledActionInputSchema,
  StrikeChangeSchema,
  CaseDtoSchema,
  SnowflakeSchema,
  MuteDtoSchema,
  SnapshotDtoSchema,
  MemberSnapshotDtoSchema,
  MessageSnapshotInputSchema,
  MemberSnapshotInputSchema,
  GuildSettingsUpdateSchema,
  AutomodSettingsUpdateSchema,
  PunishmentParametersSchema,
  RaidEvaluationSchema,
  JsonValueSchema,
  IgnoreRoleSchema,
  IgnoreChannelSchema,
  GuildSettingsDtoSchema,
  AutomodSettingsDtoSchema,
  PunishmentDtoSchema,
  LifecycleDtoSchema,
  StrikeTransactionDtoSchema,
  JobDtoSchema,
  JobPayloadSchema,
  CaseStatusParameterSchema,
  MuteReleaseStatusSchema,
  ErrorCodeSchema,
  WorkerIdSchema,
  ReasonSchema,
  CaseNumberRowSchema,
  StrikeCountRowSchema,
  IdRowSchema,
  MuteLockRowSchema,
  SCHEDULED_MAX_ATTEMPTS,
} from './contracts.js';
import type { GeneralRepository } from './contracts.js';
import type { Prisma as PrismaTypes } from '@prisma/client';
import {
  isUserTargetAction,
  normalizeTargetDisplay,
} from '../services/target-identity.js';
import { t } from '../i18n/index.js';

type DbTransaction = PrismaTypes.TransactionClient;

function canonicalScheduledTargetDisplay(value: string): string | null {
  const display = value.normalize('NFKC').trim();
  if (
    display.length > 0 &&
    Array.from(display).length <= 128 &&
    !/^\d{17,20}$/u.test(display) &&
    !/^<@!?\d{17,20}>$/u.test(display) &&
    !/\(\d{17,20}\)$/u.test(display)
  )
    return display;
  return null;
}

export class PrismaGeneralRepository implements GeneralRepository {
  public constructor(private readonly db: PrismaClient) {}

  public async ping(): Promise<void> {
    await this.db.$queryRaw`SELECT 1`;
  }

  public async getStats(): Promise<{ cases: number; strikes: number }> {
    const [cases, strikes] = await Promise.all([
      this.db.moderationCase.count(),
      this.db.userStrike.aggregate({ _sum: { count: true } }),
    ]);
    return { cases, strikes: strikes._sum.count ?? 0 };
  }
}

export class PrismaGuildSettingsRepository implements GuildSettingsRepository {
  public constructor(private readonly db: PrismaClient) {}

  public get(guildId: string) {
    SnowflakeSchema.parse(guildId);
    return this.db.guildSettings
      .findUnique({ where: { guildId } })
      .then((row) => (row ? GuildSettingsDtoSchema.parse(row) : null));
  }

  public getOrCreate(guildId: string) {
    SnowflakeSchema.parse(guildId);
    return this.db.guildSettings
      .upsert({
        where: { guildId },
        create: { guildId },
        update: {},
      })
      .then((row) => GuildSettingsDtoSchema.parse(row));
  }
  public update(guildId: string, patch: GuildSettingsUpdate) {
    SnowflakeSchema.parse(guildId);
    GuildSettingsUpdateSchema.parse(patch);
    return this.db.guildSettings
      .update({
        where: { guildId },
        data: patch,
      })
      .then((row) => GuildSettingsDtoSchema.parse(row));
  }
}

export class PrismaCaseRepository implements CaseRepository {
  public constructor(private readonly db: PrismaClient) {}

  public createWithNumber(input: CaseInput): Promise<CaseDto> {
    CaseInputSchema.parse(input);
    return this.allocate(input, 0).then(validateDbOutput);
  }
  public async createExternalWithAudit(
    input: CaseInput & { discordAuditLogEntryId: string },
  ): Promise<CaseDto> {
    return (await this.createExternalWithAuditResult(input)).case;
  }
  public async createExternalWithAuditResult(
    input: CaseInput & { discordAuditLogEntryId: string },
  ): Promise<ExternalCaseCreationResult> {
    CaseInputSchema.parse(input);
    SnowflakeSchema.parse(input.discordAuditLogEntryId);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await this.db.$transaction(async (tx) => {
          const existing = await tx.moderationCase.findFirst({
            where: {
              guildId: input.guildId,
              discordAuditLogEntryId: input.discordAuditLogEntryId,
            },
          });
          if (existing)
            return { case: validateDbOutput(existing), created: false };
          const created = await allocateCase(
            tx,
            input,
            input.discordAuditLogEntryId,
          );
          return { case: validateDbOutput(created), created: true };
        });
        return result;
      } catch (error) {
        // A concurrent creator can win the audit-id unique constraint after
        // this transaction's initial lookup. Retry the whole transaction so
        // the winner is returned as a deduplicated result and its number is
        // never allocated a second time.
        if (attempt < 3 && isRetryableSerialization(error)) continue;
        throw error;
      }
    }
  }
  private async allocate(input: CaseInput, attempt: number): Promise<CaseDto> {
    try {
      // Delegate to the shared, guarded allocator so `createWithNumber`
      // enforces the same case-number allocation and user target-display
      // invariant as every other case-creation path (external, strike, raid,
      // scheduled) instead of a divergent inline copy.
      return validateDbOutput(
        await this.db.$transaction(async (tx) => allocateCase(tx, input)),
      );
    } catch (error) {
      if (attempt < 3 && isRetryableSerialization(error))
        return this.allocate(input, attempt + 1);
      throw error;
    }
  }

  public async updateReason(id: string, reason: string): Promise<CaseDto> {
    z.uuid().parse(id);
    ReasonSchema.parse(reason);
    return validateDbOutput(
      await this.db.moderationCase.update({
        where: { id },
        data: { reason },
      }),
    );
  }
  public async get(id: string): Promise<CaseDto | null> {
    z.uuid().parse(id);
    const result = await this.db.moderationCase.findUnique({
      where: { id },
    });
    return result ? validateDbOutput(result) : null;
  }
  public updateStatus(
    id: string,
    status: CaseInput['status'],
    errorCode?: string,
  ): Promise<CaseDto> {
    z.uuid().parse(id);
    CaseStatusParameterSchema.parse(status);
    if (errorCode !== undefined) ErrorCodeSchema.parse(errorCode);
    return this.db.moderationCase
      .update({
        where: { id },
        data: { status, errorCode: errorCode ?? null },
      })
      .then(validateDbOutput);
  }
  public async listForTarget(
    guildId: string,
    targetUserId: string,
  ): Promise<CaseDto[]> {
    SnowflakeSchema.parse(guildId);
    SnowflakeSchema.parse(targetUserId);
    return (
      await this.db.moderationCase.findMany({
        where: { guildId, targetUserId },
        orderBy: { caseNumber: 'desc' },
      })
    ).map(validateDbOutput);
  }
  public async findByGuildAndNumber(
    guildId: string,
    caseNumber: number,
  ): Promise<CaseDto | null> {
    SnowflakeSchema.parse(guildId);
    const row = await this.db.moderationCase.findUnique({
      where: { guildId_caseNumber: { guildId, caseNumber } },
    });
    return row ? validateDbOutput(row) : null;
  }
  public async latest(guildId: string): Promise<CaseDto | null> {
    SnowflakeSchema.parse(guildId);
    const row = await this.db.moderationCase.findFirst({
      where: {
        guildId,
        OR: [
          { reason: null },
          { reason: '' },
          { reason: t('moderation:defaultReason') },
        ],
      },
      orderBy: { caseNumber: 'desc' },
    });
    return row
      ? validateDbOutput({
          ...row,
          reason: row.reason?.trim() || t('moderation:defaultReason'),
        })
      : null;
  }
  public async updateMetadata(
    id: string,
    metadata: JsonValue,
  ): Promise<CaseDto> {
    z.uuid().parse(id);
    JsonValueSchema.parse(metadata);
    return validateDbOutput(
      await this.db.moderationCase.update({
        where: { id },
        data: { metadata: metadata === null ? Prisma.JsonNull : metadata },
      }),
    );
  }
  public async updateLog(
    id: string,
    logChannelId: string | null,
    logMessageId: string | null,
  ): Promise<CaseDto> {
    z.uuid().parse(id);
    if (logChannelId) SnowflakeSchema.parse(logChannelId);
    if (logMessageId) SnowflakeSchema.parse(logMessageId);
    return validateDbOutput(
      await this.db.moderationCase.update({
        where: { id },
        data: { logChannelId, logMessageId },
      }),
    );
  }
  public async updateAudit(
    id: string,
    auditEntryId: string | null,
  ): Promise<CaseDto> {
    z.uuid().parse(id);
    if (auditEntryId) SnowflakeSchema.parse(auditEntryId);
    return validateDbOutput(
      await this.db.moderationCase.update({
        where: { id },
        data: { discordAuditLogEntryId: auditEntryId },
      }),
    );
  }
}

export class PrismaStrikeRepository implements StrikeRepository {
  public constructor(private readonly db: PrismaClient) {}

  public changeLocked(input: StrikeChange): Promise<StrikeResult> {
    return this.changeLockedAttempt(input, 0);
  }

  private async changeLockedAttempt(
    input: StrikeChange,
    attempt: number,
  ): Promise<StrikeResult> {
    StrikeChangeSchema.parse(input);
    try {
      return await this.db.$transaction(async (tx) => {
        await ensureSettings(tx, input.guildId);
        const existing = await tx.userStrike.findUnique({
          where: {
            guildId_userId: { guildId: input.guildId, userId: input.userId },
          },
        });
        // A pardon against an unknown user has no effect and must not create
        // an empty strike row (zero-effect changes are intentionally invisible).
        if (!existing && input.source === 'PARDON')
          return {
            beforeCount: 0,
            afterCount: 0,
            delta: 0,
            crossedPunishments: [],
            transaction: null,
          };
        if (!existing)
          await tx.userStrike.upsert({
            where: {
              guildId_userId: { guildId: input.guildId, userId: input.userId },
            },
            create: { guildId: input.guildId, userId: input.userId, count: 0 },
            update: {},
          });
        const rawRows = await tx.$queryRaw<unknown[]>(
          Prisma.sql`SELECT count FROM user_strikes WHERE guild_id = ${input.guildId} AND user_id = ${input.userId} FOR UPDATE`,
        );
        const rows = rawRows.map((row) => StrikeCountRowSchema.parse(row));
        const beforeCount = rows[0]?.count ?? 0;
        const requestedDelta =
          input.source === 'PARDON'
            ? -Math.abs(input.requestedDelta)
            : input.requestedDelta;
        if (requestedDelta === 0) {
          return {
            beforeCount,
            afterCount: beforeCount,
            delta: 0,
            crossedPunishments: [],
            transaction: null,
          };
        }
        const afterCount = Math.max(
          0,
          Math.min(1_000_000, beforeCount + requestedDelta),
        );
        const delta = afterCount - beforeCount;
        if (delta === 0) {
          return {
            beforeCount,
            afterCount,
            delta: 0,
            crossedPunishments: [],
            transaction: null,
          };
        }
        const createdCase = await allocateCase(tx, input.caseInput);
        await tx.userStrike.update({
          where: {
            guildId_userId: { guildId: input.guildId, userId: input.userId },
          },
          data: { count: afterCount },
        });
        const transaction = StrikeTransactionDtoSchema.parse(
          await tx.strikeTransaction.create({
            data: {
              guildId: input.guildId,
              userId: input.userId,
              delta,
              requestedDelta: input.requestedDelta,
              beforeCount,
              afterCount,
              source: input.source,
              actorUserId: input.actorUserId,
              reason: input.reason,
              modCaseId: createdCase.id,
            },
          }),
        );
        const crossedPunishments =
          requestedDelta > 0
            ? (
                await tx.punishment.findMany({
                  where: {
                    guildId: input.guildId,
                    threshold: { gt: beforeCount, lte: afterCount },
                  },
                  orderBy: { threshold: 'desc' },
                  take: 1,
                })
              ).map((row) => PunishmentDtoSchema.parse(row))
            : [];
        return {
          beforeCount,
          afterCount,
          delta,
          crossedPunishments,
          transaction,
        };
      });
    } catch (error) {
      // The first concurrent creator can race on guild_settings/user_strikes.
      // Retry the complete transaction so the row lock is reacquired; never
      // retry inside the transaction, which could duplicate cases/history.
      if (attempt < 3 && isUniqueViolation(error))
        return this.changeLockedAttempt(input, attempt + 1);
      throw error;
    }
  }

  public async history(guildId: string, userId: string) {
    SnowflakeSchema.parse(guildId);
    SnowflakeSchema.parse(userId);
    const rows = await this.db.strikeTransaction.findMany({
      where: { guildId, userId },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    return rows.map((row) => StrikeTransactionDtoSchema.parse(row));
  }
}

export class PrismaSchedulerRepository implements SchedulerRepository {
  public constructor(
    private readonly db: PrismaClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public scheduleReplacing(input: ScheduledActionInput) {
    ScheduledActionInputSchema.parse(input);
    return this.replaceWithRetry(input, 0);
  }
  private async replaceWithRetry(
    input: ScheduledActionInput,
    attempt: number,
  ): Promise<JobDto> {
    try {
      return await this.db.$transaction(async (tx) => {
        await ensureSettings(tx, input.guildId);
        await tx.$queryRaw(
          Prisma.sql`SELECT guild_id FROM guild_settings WHERE guild_id = ${input.guildId} FOR UPDATE`,
        );
        await cancelMatching(tx, input);
        return validateJobOutput(
          await tx.scheduledAction.create({
            data: {
              guildId: input.guildId,
              targetUserId: input.targetUserId ?? null,
              channelId: input.channelId ?? null,
              type: input.type,
              executeAt: input.executeAt,
              payload: input.payload,
              createdByCaseId: input.createdByCaseId ?? null,
              status: 'PENDING',
            },
          }),
        );
      });
    } catch (error) {
      if (attempt < 3 && isUniqueViolation(error))
        return this.replaceWithRetry(input, attempt + 1);
      throw error;
    }
  }

  public async cancelTarget(
    input: Pick<
      ScheduledActionInput,
      'guildId' | 'targetUserId' | 'channelId' | 'type'
    >,
  ) {
    SnowflakeSchema.parse(input.guildId);
    if (input.targetUserId) SnowflakeSchema.parse(input.targetUserId);
    if (input.channelId) SnowflakeSchema.parse(input.channelId);
    const result = await this.db.scheduledAction.updateMany({
      where: {
        guildId: input.guildId,
        targetUserId: input.targetUserId ?? null,
        channelId: input.channelId ?? null,
        type: input.type,
        status: 'PENDING',
      },
      data: { status: 'CANCELLED' },
    });
    return result.count;
  }

  public async claimDue(
    limit: number,
    workerId: string,
    now = new Date(),
    supportedTypes?: readonly JobDto['type'][],
  ) {
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
    const typeClause =
      supportedTypes && supportedTypes.length > 0
        ? Prisma.sql` AND type IN (${Prisma.join(
            supportedTypes.map(
              (type) => Prisma.sql`${type}::"ScheduledActionType"`,
            ),
          )})`
        : Prisma.empty;
    return this.db.$transaction(async (tx) => {
      const rawIds = await tx.$queryRaw<unknown[]>(Prisma.sql`
        UPDATE scheduled_actions SET status = 'RUNNING', locked_at = ${now}, locked_by = ${workerId},
          attempts = attempts + 1, updated_at = ${now}
        WHERE id IN (SELECT id FROM scheduled_actions WHERE status = 'PENDING' AND execute_at <= ${now}
          ${typeClause} ORDER BY execute_at FOR UPDATE SKIP LOCKED LIMIT ${safeLimit}) RETURNING id`);
      const ids = rawIds.map((row) => IdRowSchema.parse(row));
      return (
        await tx.scheduledAction.findMany({
          where: { id: { in: ids.map((row) => row.id) } },
        })
      ).map(validateJobOutput);
    });
  }

  public async complete(id: string, workerId: string) {
    z.uuid().parse(id);
    WorkerIdSchema.parse(workerId);
    const result = await this.db.scheduledAction.updateMany({
      where: {
        id,
        status: 'RUNNING',
        lockedBy: workerId,
      },
      data: { status: 'COMPLETED', lockedAt: null, lockedBy: null },
    });
    return result.count === 1;
  }

  public async fail(
    id: string,
    workerId: string,
    error: string,
    retryable: boolean,
  ) {
    z.uuid().parse(id);
    WorkerIdSchema.parse(workerId);
    z.string().min(1).parse(error);
    z.boolean().parse(retryable);
    return this.db.$transaction(async (tx) => {
      const action = await tx.scheduledAction.findFirst({
        where: { id, status: 'RUNNING', lockedBy: workerId },
      });
      if (!action) return false;
      const retry = retryable && action.attempts < SCHEDULED_MAX_ATTEMPTS;
      const delays = [30, 60, 120, 240, 480];
      const delaySeconds = delays[Math.max(0, action.attempts - 1)] ?? 480;
      const result = await tx.scheduledAction.updateMany({
        where: { id, status: 'RUNNING', lockedBy: workerId },
        data: {
          status: retry ? 'PENDING' : 'FAILED',
          executeAt: retry
            ? new Date(this.clock().getTime() + delaySeconds * 1000)
            : action.executeAt,
          lastError: error,
          lockedAt: null,
          lockedBy: null,
        },
      });
      if (result.count !== 1) return false;
      // Retry exhaustion: when the job becomes FAILED, atomically fail any
      // linked still-PENDING SCHEDULED case. This is the repository fallback
      // that prevents a case staying PENDING after a dispatcher crash before it
      // could terminalize at the final attempt.
      if (!retry && action.executedCaseId)
        await tx.moderationCase.updateMany({
          where: { id: action.executedCaseId, status: 'PENDING' },
          data: { status: 'FAILED', errorCode: 'SCHEDULED_JOB_FAILED' },
        });
      return true;
    });
  }

  public async recoverStale(now = new Date(), workerTimeoutMs = 5 * 60_000) {
    const staleBefore = new Date(now.getTime() - workerTimeoutMs);
    return this.db.$transaction(async (tx) => {
      const exhaustedJobs = await tx.scheduledAction.findMany({
        where: {
          status: 'RUNNING',
          attempts: { gte: SCHEDULED_MAX_ATTEMPTS },
          lockedAt: { lt: staleBefore },
        },
        select: { executedCaseId: true },
      });
      const exhausted = await tx.scheduledAction.updateMany({
        where: {
          status: 'RUNNING',
          attempts: { gte: SCHEDULED_MAX_ATTEMPTS },
          lockedAt: { lt: staleBefore },
        },
        data: {
          status: 'FAILED',
          lastError: 'worker lease expired',
          lockedAt: null,
          lockedBy: null,
        },
      });
      // Exhausted stale recovery: fail linked still-PENDING SCHEDULED cases so
      // a crashed worker that never terminalized cannot leave a case PENDING.
      const exhaustedCaseIds = exhaustedJobs
        .map((job) => job.executedCaseId)
        .filter((caseId): caseId is string => caseId !== null);
      if (exhaustedCaseIds.length > 0)
        await tx.moderationCase.updateMany({
          where: { id: { in: exhaustedCaseIds }, status: 'PENDING' },
          data: { status: 'FAILED', errorCode: 'SCHEDULED_JOB_FAILED' },
        });
      const recovered = await tx.scheduledAction.updateMany({
        where: {
          status: 'RUNNING',
          attempts: { lt: SCHEDULED_MAX_ATTEMPTS },
          lockedAt: { lt: staleBefore },
        },
        data: { status: 'PENDING', lockedAt: null, lockedBy: null },
      });
      return exhausted.count + recovered.count;
    });
  }
  public async findPending(
    guildId: string,
    targetUserId: string | null,
    channelId: string | null,
    type: ScheduledActionInput['type'],
  ): Promise<JobDto | null> {
    const job = await this.db.scheduledAction.findFirst({
      where: { guildId, targetUserId, channelId, type, status: 'PENDING' },
    });
    return job ? validateJobOutput(job) : null;
  }
  public async getStatus(id: string): Promise<JobDto['status'] | null> {
    const job = await this.db.scheduledAction.findUnique({
      where: { id },
      select: { status: true },
    });
    return job?.status ?? null;
  }
  public async createScheduledCase(
    jobId: string,
    workerId: string,
    fallbackModeratorUserId: string,
  ): Promise<ScheduledCaseCreationResult> {
    z.uuid().parse(jobId);
    WorkerIdSchema.parse(workerId);
    SnowflakeSchema.parse(fallbackModeratorUserId);
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM scheduled_actions WHERE id = ${jobId}::uuid FOR UPDATE`,
      );
      const job = await tx.scheduledAction.findUnique({ where: { id: jobId } });
      if (!job || job.status !== 'RUNNING' || job.lockedBy !== workerId)
        throw new Error('Scheduled job is not owned by worker');
      if (job.type !== 'UNBAN' && job.type !== 'UNMUTE')
        throw new Error('Scheduled case is only supported for UNBAN/UNMUTE');
      const payload = z
        .object({ guildId: SnowflakeSchema, userId: SnowflakeSchema })
        .safeParse(job.payload);
      if (
        !payload.success ||
        job.targetUserId === null ||
        job.targetUserId !== payload.data.userId ||
        job.guildId !== payload.data.guildId
      )
        throw new Error('Scheduled job target does not match its payload');
      if (job.executedCaseId) {
        const existing = await tx.moderationCase.findUnique({
          where: { id: job.executedCaseId },
        });
        if (!existing) throw new Error('Scheduled case reference is missing');
        return {
          case: validateDbOutput(existing),
          created: false,
          terminalization: { jobId, workerId, executedCaseId: existing.id },
        };
      }
      const originCandidate = job.createdByCaseId
        ? await tx.moderationCase.findUnique({
            where: { id: job.createdByCaseId },
          })
        : null;
      const originMatchesJob =
        originCandidate?.guildId === job.guildId &&
        originCandidate.targetUserId === job.targetUserId;
      const originDisplay = originMatchesJob
        ? canonicalScheduledTargetDisplay(originCandidate.targetDisplay)
        : null;
      const origin =
        originCandidate?.guildId === job.guildId &&
        originCandidate.targetUserId === job.targetUserId &&
        originDisplay !== null
          ? originCandidate
          : null;
      const created = await allocateCase(tx, {
        guildId: job.guildId,
        action: job.type === 'UNBAN' ? 'UNBAN' : 'UNMUTE',
        targetUserId: job.targetUserId,
        targetDisplay: originDisplay ?? t('system:identity.unknownUser'),
        moderatorUserId: origin?.moderatorUserId ?? fallbackModeratorUserId,
        reason: origin?.reason ?? null,
        durationSeconds: null,
        source: 'SCHEDULED',
        status: 'PENDING',
        metadata: {},
      });
      await tx.scheduledAction.update({
        where: { id: jobId },
        data: { executedCaseId: created.id },
      });
      return {
        case: validateDbOutput(created),
        created: true,
        terminalization: { jobId, workerId, executedCaseId: created.id },
      };
    });
  }
  public async terminalizeScheduledCase(
    input: ScheduledCaseTerminalizationInput,
  ): Promise<boolean> {
    z.uuid().parse(input.jobId);
    z.uuid().parse(input.executedCaseId);
    WorkerIdSchema.parse(input.workerId);
    z.enum(['COMPLETED', 'FAILED', 'PARTIAL']).parse(input.status);
    if (input.errorCode !== undefined && input.errorCode !== null)
      ErrorCodeSchema.parse(input.errorCode);
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM scheduled_actions WHERE id = ${input.jobId}::uuid FOR UPDATE`,
      );
      const job = await tx.scheduledAction.findUnique({
        where: { id: input.jobId },
      });
      if (
        !job ||
        job.status !== 'RUNNING' ||
        job.lockedBy !== input.workerId ||
        job.executedCaseId !== input.executedCaseId
      )
        return false;
      const caseUpdated = await tx.moderationCase.updateMany({
        where: { id: input.executedCaseId, status: 'PENDING' },
        data: {
          status: input.status,
          errorCode: input.errorCode ?? null,
        },
      });
      if (caseUpdated.count !== 1) return false;
      const jobUpdated = await tx.scheduledAction.updateMany({
        where: {
          id: input.jobId,
          status: 'RUNNING',
          lockedBy: input.workerId,
          executedCaseId: input.executedCaseId,
        },
        data: {
          status: input.status === 'FAILED' ? 'FAILED' : 'COMPLETED',
          lockedAt: null,
          lockedBy: null,
        },
      });
      if (jobUpdated.count !== 1)
        throw new Error('Scheduled job terminalization CAS failed');
      return true;
    });
  }
}

export class PrismaRetentionRepository implements RetentionRepository {
  public constructor(private readonly db: PrismaClient) {}
  public async deleteExpiredSnapshots(now = new Date()) {
    return (
      await this.db.messageSnapshot.deleteMany({
        where: { expiresAt: { lte: now } },
      })
    ).count;
  }
  public async deleteOldRaidEvents(now = new Date()) {
    return (
      await this.db.raidJoinEvent.deleteMany({
        where: { joinedAt: { lt: new Date(now.getTime() - 5 * 60_000) } },
      })
    ).count;
  }
  public async deleteOldScheduledActions(now = new Date()) {
    return this.db.$transaction(async (tx) => {
      const completed = await tx.scheduledAction.deleteMany({
        where: {
          status: { in: ['COMPLETED', 'CANCELLED'] },
          updatedAt: { lt: new Date(now.getTime() - 30 * 86_400_000) },
        },
      });
      const failed = await tx.scheduledAction.deleteMany({
        where: {
          status: 'FAILED',
          updatedAt: { lt: new Date(now.getTime() - 90 * 86_400_000) },
        },
      });
      return completed.count + failed.count;
    });
  }
}

export class PrismaAutomodRepository implements AutomodRepository {
  public constructor(private readonly db: PrismaClient) {}
  public getOrCreate(guildId: string) {
    SnowflakeSchema.parse(guildId);
    return this.db.automodSettings
      .upsert({
        where: { guildId },
        create: { guildId },
        update: {},
      })
      .then((row) => AutomodSettingsDtoSchema.parse(row));
  }
  public update(guildId: string, patch: AutomodSettingsUpdate) {
    SnowflakeSchema.parse(guildId);
    AutomodSettingsUpdateSchema.parse(patch);
    return this.db.automodSettings
      .upsert({
        where: { guildId },
        create: { guildId, ...patch },
        update: patch,
      })
      .then((row) => AutomodSettingsDtoSchema.parse(row));
  }
}

export class PrismaPunishmentRepository implements PunishmentRepository {
  public constructor(private readonly db: PrismaClient) {}
  public replace(
    guildId: string,
    threshold: number,
    action: PunishmentActionDto,
    durationSeconds: number | null,
    actor: string,
  ) {
    PunishmentParametersSchema.parse({
      guildId,
      threshold,
      action,
      durationSeconds,
      actor,
    });
    SnowflakeSchema.parse(guildId);
    SnowflakeSchema.parse(actor);
    return this.db.punishment
      .upsert({
        where: { guildId_threshold: { guildId, threshold } },
        create: {
          guildId,
          threshold,
          action,
          durationSeconds,
          createdBy: actor,
        },
        update: { action, durationSeconds, createdBy: actor },
      })
      .then((row) => PunishmentDtoSchema.parse(row));
  }
  public list(guildId: string) {
    SnowflakeSchema.parse(guildId);
    return this.db.punishment
      .findMany({
        where: { guildId },
        orderBy: { threshold: 'asc' },
      })
      .then((rows) => rows.map((row) => PunishmentDtoSchema.parse(row)));
  }
  public crossed(guildId: string, before: number, after: number) {
    SnowflakeSchema.parse(guildId);
    return this.db.punishment
      .findMany({
        where: { guildId, threshold: { gt: before, lte: after } },
        orderBy: { threshold: 'desc' },
        take: 1,
      })
      .then((rows) => rows.map((row) => PunishmentDtoSchema.parse(row)));
  }
  public async remove(guildId: string, threshold: number) {
    SnowflakeSchema.parse(guildId);
    return (
      (await this.db.punishment.deleteMany({ where: { guildId, threshold } }))
        .count === 1
    );
  }
}

export class PrismaIgnoreRepository implements IgnoreRepository {
  public constructor(private readonly db: PrismaClient) {}
  public async setRole(guildId: string, roleId: string, actor: string) {
    SnowflakeSchema.parse(guildId);
    SnowflakeSchema.parse(roleId);
    SnowflakeSchema.parse(actor);
    await this.db.ignoredRole.upsert({
      where: { guildId_roleId: { guildId, roleId } },
      create: { guildId, roleId, createdBy: actor },
      update: { createdBy: actor },
    });
  }
  public async setChannel(guildId: string, channelId: string, actor: string) {
    SnowflakeSchema.parse(guildId);
    SnowflakeSchema.parse(channelId);
    SnowflakeSchema.parse(actor);
    await this.db.ignoredChannel.upsert({
      where: { guildId_channelId: { guildId, channelId } },
      create: { guildId, channelId, createdBy: actor },
      update: { createdBy: actor },
    });
  }
  public async removeRole(guildId: string, roleId: string) {
    SnowflakeSchema.parse(guildId);
    SnowflakeSchema.parse(roleId);
    await this.db.ignoredRole.deleteMany({ where: { guildId, roleId } });
  }
  public async removeChannel(guildId: string, channelId: string) {
    SnowflakeSchema.parse(guildId);
    SnowflakeSchema.parse(channelId);
    await this.db.ignoredChannel.deleteMany({ where: { guildId, channelId } });
  }
  public async clearChannel(guildId: string, channelId: string) {
    SnowflakeSchema.parse(guildId);
    SnowflakeSchema.parse(channelId);
    return this.db.$transaction(async (tx) => {
      const ignored = await tx.ignoredChannel.deleteMany({
        where: { guildId, channelId },
      });
      const snapshots = await tx.messageSnapshot.deleteMany({
        where: { guildId, channelId },
      });
      const jobs = await tx.scheduledAction.updateMany({
        where: {
          guildId,
          channelId,
          type: 'RESTORE_SLOWMODE',
          status: 'PENDING',
        },
        data: { status: 'CANCELLED' },
      });
      await tx.$executeRaw(Prisma.sql`UPDATE guild_settings SET
        modlog_channel_id = CASE WHEN modlog_channel_id = ${channelId} THEN NULL ELSE modlog_channel_id END,
        message_log_channel_id = CASE WHEN message_log_channel_id = ${channelId} THEN NULL ELSE message_log_channel_id END,
        server_log_channel_id = CASE WHEN server_log_channel_id = ${channelId} THEN NULL ELSE server_log_channel_id END,
        voice_log_channel_id = CASE WHEN voice_log_channel_id = ${channelId} THEN NULL ELSE voice_log_channel_id END
        WHERE guild_id = ${guildId}`);
      return ignored.count + snapshots.count + jobs.count;
    });
  }
  public async listRoles(guildId: string) {
    SnowflakeSchema.parse(guildId);
    return (
      await this.db.ignoredRole.findMany({
        where: { guildId },
        orderBy: { createdAt: 'asc' },
      })
    ).map((row) => IgnoreRoleSchema.parse(row));
  }
  public async listChannels(guildId: string) {
    SnowflakeSchema.parse(guildId);
    return (
      await this.db.ignoredChannel.findMany({
        where: { guildId },
        orderBy: { createdAt: 'asc' },
      })
    ).map((row) => IgnoreChannelSchema.parse(row));
  }
}

export class PrismaSnapshotRepository implements SnapshotRepository {
  public constructor(private readonly db: PrismaClient) {}
  public async upsertMessage(
    input: MessageSnapshotInput,
  ): Promise<import('./contracts.js').SnapshotDto> {
    MessageSnapshotInputSchema.parse(input);
    return SnapshotDtoSchema.parse(
      await this.db.$transaction(async (tx) => {
        await ensureSettings(tx, input.guildId);
        return tx.messageSnapshot.upsert({
          where: { messageId: input.messageId },
          create: {
            messageId: input.messageId,
            guildId: input.guildId,
            channelId: input.channelId,
            authorUserId: input.authorUserId,
            authorDisplay: input.authorDisplay,
            content: input.content,
            attachments: prismaJson(input.attachments),
            embedsSummary: prismaJson(input.embedsSummary),
            createdAt: input.createdAt ?? new Date(),
            editedAt: input.editedAt ?? null,
            expiresAt: input.expiresAt,
          },
          update: {
            guildId: input.guildId,
            channelId: input.channelId,
            authorUserId: input.authorUserId,
            authorDisplay: input.authorDisplay,
            content: input.content,
            attachments: prismaJson(input.attachments),
            embedsSummary: prismaJson(input.embedsSummary),
            // Preserve the original creation time on edit: only override it when
            // the caller explicitly supplies one. An `messageUpdate` upsert that
            // omits `createdAt` must never reset the snapshot's creation time to
            // the edit time.
            ...(input.createdAt ? { createdAt: input.createdAt } : {}),
            editedAt: input.editedAt ?? null,
            expiresAt: input.expiresAt,
          },
        });
      }),
    ) as import('./contracts.js').SnapshotDto;
  }
  public async upsertMember(
    input: MemberSnapshotInput,
  ): Promise<import('./contracts.js').MemberSnapshotDto> {
    MemberSnapshotInputSchema.parse(input);
    return MemberSnapshotDtoSchema.parse(
      await this.db.guildMemberSnapshot.upsert({
        where: {
          guildId_userId: {
            guildId: input.guildId,
            userId: input.userId,
          },
        },
        create: {
          guildId: input.guildId,
          userId: input.userId,
          username: input.username,
          globalName: input.globalName ?? null,
          nickname: input.nickname ?? null,
          joinedAt: input.joinedAt ?? null,
        },
        update: {
          username: input.username,
          globalName: input.globalName ?? null,
          nickname: input.nickname ?? null,
          joinedAt: input.joinedAt ?? null,
        },
      }),
    );
  }
  public async deleteExpired(now = new Date()) {
    return (
      await this.db.messageSnapshot.deleteMany({
        where: { expiresAt: { lte: now } },
      })
    ).count;
  }
  public async deleteMessage(messageId: string) {
    SnowflakeSchema.parse(messageId);
    await this.db.messageSnapshot.deleteMany({ where: { messageId } });
  }
  public async deleteMessages(messageIds: string[]) {
    messageIds.forEach((id) => SnowflakeSchema.parse(id));
    if (messageIds.length === 0) return 0;
    return (
      await this.db.messageSnapshot.deleteMany({
        where: { messageId: { in: messageIds } },
      })
    ).count;
  }
  public async deleteMember(guildId: string, userId: string) {
    SnowflakeSchema.parse(guildId);
    SnowflakeSchema.parse(userId);
    await this.db.guildMemberSnapshot.deleteMany({
      where: { guildId, userId },
    });
  }
  public async getMessage(messageId: string) {
    SnowflakeSchema.parse(messageId);
    const row = await this.db.messageSnapshot.findUnique({
      where: { messageId },
    });
    return row
      ? (SnapshotDtoSchema.parse(row) as import('./contracts.js').SnapshotDto)
      : null;
  }
  public async getMessages(messageIds: string[]) {
    messageIds.forEach((id) => SnowflakeSchema.parse(id));
    return (
      await this.db.messageSnapshot.findMany({
        where: { messageId: { in: messageIds } },
      })
    ).map(
      (row) =>
        SnapshotDtoSchema.parse(row) as import('./contracts.js').SnapshotDto,
    );
  }
  public async getMember(guildId: string, userId: string) {
    SnowflakeSchema.parse(guildId);
    SnowflakeSchema.parse(userId);
    const row = await this.db.guildMemberSnapshot.findUnique({
      where: { guildId_userId: { guildId, userId } },
    });
    return row ? MemberSnapshotDtoSchema.parse(row) : null;
  }
  public async listMembersForUser(userId: string) {
    SnowflakeSchema.parse(userId);
    const left = await this.db.guildLifecycleMarker.findMany({
      where: { status: 'LEFT' },
      select: { guildId: true },
    });
    const leftGuildIds = left.map((row) => row.guildId);
    return (
      await this.db.guildMemberSnapshot.findMany({
        where: { userId, guildId: { notIn: leftGuildIds } },
        orderBy: { guildId: 'asc' },
      })
    ).map((row) => MemberSnapshotDtoSchema.parse(row));
  }
}

export class PrismaActiveMuteRepository implements ActiveMuteRepository {
  public constructor(private readonly db: PrismaClient) {}
  private activate(
    guildId: string,
    userId: string,
    caseId: string,
    expiresAt: Date | null,
  ) {
    return this.db.activeMute.upsert({
      where: { guildId_userId: { guildId, userId } },
      create: { guildId, userId, caseId, expiresAt, status: 'ACTIVE' },
      update: { caseId, expiresAt, status: 'ACTIVE' },
    });
  }
  public activateWithSchedule(
    guildId: string,
    userId: string,
    caseId: string,
    expiresAt: Date | null,
    payload: JsonValue,
  ) {
    SnowflakeSchema.parse(guildId);
    SnowflakeSchema.parse(userId);
    z.uuid().parse(caseId);
    if (expiresAt)
      ScheduledActionInputSchema.parse({
        guildId,
        targetUserId: userId,
        channelId: null,
        executeAt: expiresAt,
        createdByCaseId: caseId,
        type: 'UNMUTE',
        payload,
      });
    return this.db.$transaction(async (tx) => {
      const mute = await tx.activeMute.upsert({
        where: { guildId_userId: { guildId, userId } },
        create: { guildId, userId, caseId, expiresAt, status: 'ACTIVE' },
        update: { caseId, expiresAt, status: 'ACTIVE' },
      });
      await tx.scheduledAction.updateMany({
        where: {
          guildId,
          targetUserId: userId,
          type: 'UNMUTE',
          status: 'PENDING',
        },
        data: { status: 'CANCELLED' },
      });
      if (expiresAt)
        await tx.scheduledAction.create({
          data: {
            guildId,
            targetUserId: userId,
            type: 'UNMUTE',
            executeAt: expiresAt,
            payload: payload as PrismaTypes.InputJsonValue,
            createdByCaseId: caseId,
          },
        });
      return MuteDtoSchema.parse(mute);
    });
  }
  private async release(
    guildId: string,
    userId: string,
    status: 'RELEASED' | 'EXPIRED',
  ) {
    return (
      (
        await this.db.activeMute.updateMany({
          where: { guildId, userId, status: 'ACTIVE' },
          data: { status },
        })
      ).count === 1
    );
  }
  public async releaseWithSchedule(
    guildId: string,
    userId: string,
    status: 'RELEASED' | 'EXPIRED',
  ) {
    MuteReleaseStatusSchema.parse(status);
    SnowflakeSchema.parse(guildId);
    SnowflakeSchema.parse(userId);
    return this.db.$transaction(async (tx) => {
      const result = await tx.activeMute.updateMany({
        where: { guildId, userId, status: 'ACTIVE' },
        data: { status },
      });
      await tx.scheduledAction.updateMany({
        where: {
          guildId,
          targetUserId: userId,
          type: 'UNMUTE',
          status: 'PENDING',
        },
        data: { status: 'CANCELLED' },
      });
      return result.count === 1;
    });
  }
  public async expireWithSchedule(
    guildId: string,
    userId: string,
    jobId: string,
    workerId: string,
    now = new Date(),
  ) {
    WorkerIdSchema.parse(workerId);
    SnowflakeSchema.parse(guildId);
    SnowflakeSchema.parse(userId);
    z.uuid().parse(jobId);
    if (!workerId) throw new Error('workerId is required');
    return this.db.$transaction(async (tx) => {
      const rawMuteRows = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT guild_id, user_id, status, expires_at FROM active_mutes WHERE guild_id = ${guildId} AND user_id = ${userId} FOR UPDATE`,
      );
      const mute = rawMuteRows.map((row) => MuteLockRowSchema.parse(row))[0];
      if (
        !mute ||
        mute.status !== 'ACTIVE' ||
        mute.expires_at === null ||
        mute.expires_at === undefined ||
        mute.expires_at > now
      )
        return false;
      const job = await tx.scheduledAction.updateMany({
        where: {
          id: jobId,
          guildId,
          targetUserId: userId,
          type: 'UNMUTE',
          status: 'RUNNING',
          lockedBy: workerId,
        },
        data: { status: 'COMPLETED', lockedAt: null, lockedBy: null },
      });
      if (job.count !== 1) return false;
      await tx.activeMute.update({
        where: { guildId_userId: { guildId, userId } },
        data: { status: 'EXPIRED' },
      });
      return true;
      /*
      const mute = await tx.activeMute.findUnique({
        where: { guildId_userId: { guildId, userId } },
      });
      if (
        !mute ||
        mute.status !== 'ACTIVE' ||
        (mute.expiresAt !== null && mute.expiresAt > now)
      )
        return false;
      await tx.activeMute.update({
        where: { guildId_userId: { guildId, userId } },
        data: { status: 'EXPIRED' },
      });
      await tx.scheduledAction.updateMany({
        where: {
          guildId,
          targetUserId: userId,
          type: 'UNMUTE',
          status: 'PENDING',
        },
        data: { status: 'CANCELLED' },
      });
      await tx.scheduledAction.updateMany({
        where: {
          guildId,
          targetUserId: userId,
          type: 'UNMUTE',
          status: 'RUNNING',
        },
        data: { status: 'COMPLETED', lockedAt: null, lockedBy: null },
      });
      return true; */
    });
  }

  public async verifyScheduledUnmute(
    guildId: string,
    userId: string,
    jobId: string,
    workerId: string,
  ): Promise<boolean> {
    SnowflakeSchema.parse(guildId);
    SnowflakeSchema.parse(userId);
    z.uuid().parse(jobId);
    WorkerIdSchema.parse(workerId);
    const [mute, job] = await Promise.all([
      this.db.activeMute.findUnique({
        where: { guildId_userId: { guildId, userId } },
      }),
      this.db.scheduledAction.findUnique({ where: { id: jobId } }),
    ]);
    return (
      mute?.status === 'ACTIVE' &&
      job?.guildId === guildId &&
      job.targetUserId === userId &&
      job.type === 'UNMUTE' &&
      job.status === 'RUNNING' &&
      job.lockedBy === workerId &&
      job.createdByCaseId === mute.caseId &&
      mute.expiresAt !== null &&
      job.executeAt.getTime() === mute.expiresAt.getTime()
    );
  }

  public async claimScheduledUnmute(
    guildId: string,
    userId: string,
    jobId: string,
    workerId: string,
  ): Promise<boolean> {
    WorkerIdSchema.parse(workerId);
    z.uuid().parse(jobId);
    return this.db.$transaction(async (tx) => {
      const muteRows = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT guild_id, user_id, status, expires_at FROM active_mutes WHERE guild_id = ${guildId} AND user_id = ${userId} FOR UPDATE`,
      );
      const mute = muteRows.map((row) => MuteLockRowSchema.parse(row))[0];
      const job = await tx.scheduledAction.findUnique({ where: { id: jobId } });
      if (
        !mute ||
        mute.status !== 'ACTIVE' ||
        !mute.expires_at ||
        !job ||
        job.guildId !== guildId ||
        job.targetUserId !== userId ||
        job.type !== 'UNMUTE' ||
        job.status !== 'RUNNING' ||
        job.lockedBy !== workerId ||
        job.createdByCaseId === null
      )
        return false;
      const caseRow = await tx.activeMute.findUnique({
        where: { guildId_userId: { guildId, userId } },
        select: { caseId: true },
      });
      if (
        caseRow?.caseId !== job.createdByCaseId ||
        job.executeAt.getTime() !== mute.expires_at.getTime()
      )
        return false;
      return true;
    });
  }

  public async completeScheduledUnmute(
    guildId: string,
    userId: string,
    jobId: string,
    workerId: string,
  ): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM scheduled_actions WHERE id = ${jobId}::uuid FOR UPDATE`,
      );
      const job = await tx.scheduledAction.findUnique({ where: { id: jobId } });
      const rows = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT guild_id, user_id, status, expires_at FROM active_mutes WHERE guild_id = ${guildId} AND user_id = ${userId} FOR UPDATE`,
      );
      const mute = rows.map((row) => MuteLockRowSchema.parse(row))[0];
      if (!job || !mute || mute.status !== 'ACTIVE' || !mute.expires_at)
        return false;
      if (
        job.guildId !== guildId ||
        job.targetUserId !== userId ||
        job.type !== 'UNMUTE' ||
        job.status !== 'RUNNING' ||
        job.lockedBy !== workerId ||
        job.createdByCaseId === null ||
        job.executeAt.getTime() !== mute.expires_at.getTime()
      )
        return false;
      // Expire only the matching active mute. The job is deliberately left
      // RUNNING: terminalizing the linked SCHEDULED case (and completing the
      // job) is the dispatcher's responsibility via terminalizeScheduledCase,
      // keeping the case/modlog boundary independent of the mute transition.
      const muteUpdated = await tx.activeMute.updateMany({
        where: {
          guildId,
          userId,
          status: 'ACTIVE',
          caseId: job.createdByCaseId,
        },
        data: { status: 'EXPIRED' },
      });
      return muteUpdated.count === 1;
    });
  }

  public async restoreScheduledUnmute(
    guildId: string,
    userId: string,
    jobId: string,
    workerId: string,
  ): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const job = await tx.scheduledAction.findFirst({
        where: {
          id: jobId,
          guildId,
          targetUserId: userId,
          type: 'UNMUTE',
          status: 'RUNNING',
          lockedBy: workerId,
        },
      });
      if (!job) return false;
      const result = await tx.activeMute.updateMany({
        where: {
          guildId,
          userId,
          status: 'RELEASED',
          ...(job.createdByCaseId ? { caseId: job.createdByCaseId } : {}),
        },
        data: { status: 'ACTIVE' },
      });
      return result.count === 1;
    });
  }
  public async getActive(guildId: string, userId: string) {
    SnowflakeSchema.parse(guildId);
    SnowflakeSchema.parse(userId);
    const mute = await this.db.activeMute.findFirst({
      where: { guildId, userId, status: 'ACTIVE' },
    });
    return mute ? MuteDtoSchema.parse(mute) : null;
  }
}

export class PrismaRaidRepository implements RaidRepository {
  public constructor(private readonly db: PrismaClient) {}
  public async recordJoin(guildId: string, userId: string, joinedAt: Date) {
    SnowflakeSchema.parse(guildId);
    SnowflakeSchema.parse(userId);
    z.date().parse(joinedAt);
    await this.db.raidJoinEvent.createMany({
      data: { guildId, userId, joinedAt },
      skipDuplicates: true,
    });
  }
  public activate(input: import('./contracts.js').RaidActivation) {
    RaidActivationSchema.parse(input);
    return this.db.$transaction(async (tx) => {
      await ensureSettings(tx, input.guildId);
      await tx.$queryRaw(
        Prisma.sql`SELECT guild_id FROM guild_settings WHERE guild_id = ${input.guildId} FOR UPDATE`,
      );
      return GuildSettingsDtoSchema.parse(
        await tx.guildSettings.update({
          where: { guildId: input.guildId },
          data: {
            raidModeEnabled: true,
            raidModeSource: input.source,
            raidModeReason: input.reason ?? null,
            raidStartedAt: new Date(),
            verificationLevelBeforeRaid:
              input.verificationLevelBeforeRaid ?? null,
            // Record the verification-raise intent (ownership) durably BEFORE
            // the Discord raise so a crash after the raise succeeds can still
            // restore. The OFF restore stays guarded by the live "still HIGH"
            // check, so an intent whose raise never took effect is harmless.
            raidVerificationChanged: input.changed,
          },
        }),
      );
    });
  }
  public async activateManual(
    input: import('./contracts.js').RaidActivation,
  ): Promise<RaidResultDto> {
    RaidActivationSchema.parse(input);
    return this.db.$transaction(async (tx) => {
      await ensureSettings(tx, input.guildId);
      await tx.$queryRaw(
        Prisma.sql`SELECT guild_id FROM guild_settings WHERE guild_id = ${input.guildId} FOR UPDATE`,
      );
      const current = await tx.guildSettings.findUnique({
        where: { guildId: input.guildId },
      });
      if (current?.raidModeEnabled)
        return {
          activated: false,
          count: 0,
          settings: GuildSettingsDtoSchema.parse(current),
        };
      const settings = await tx.guildSettings.update({
        where: { guildId: input.guildId },
        data: {
          raidModeEnabled: true,
          raidModeSource: 'MANUAL',
          raidModeReason: input.reason ?? null,
          raidStartedAt: new Date(),
          // Capture the prior level and record the verification-raise intent
          // (ownership) durably BEFORE the Discord raise so a crash after the
          // raise succeeds can still restore. A definitive raise failure is
          // relinquished via revokeVerificationRaised; the OFF restore stays
          // guarded by the live "still HIGH" check (see markVerificationRaised).
          verificationLevelBeforeRaid:
            input.verificationLevelBeforeRaid ?? null,
          raidVerificationChanged: input.changed,
        },
      });
      const createdCase = await allocateCase(tx, {
        guildId: input.guildId,
        action: 'RAIDMODE_ON',
        targetDisplay: 'raidmode',
        moderatorUserId: input.actorUserId,
        source: 'RAIDMODE',
        status: 'COMPLETED',
        reason: input.reason ?? t('moderation:defaultReason'),
      });
      await tx.scheduledAction.updateMany({
        where: {
          guildId: input.guildId,
          type: 'DISABLE_RAIDMODE',
          status: 'PENDING',
          targetUserId: null,
          channelId: null,
        },
        data: { status: 'CANCELLED' },
      });
      return {
        activated: true,
        count: 0,
        settings: GuildSettingsDtoSchema.parse(settings),
        case: validateDbOutput(createdCase),
      };
    });
  }
  public markVerificationRaised(guildId: string) {
    SnowflakeSchema.parse(guildId);
    return this.db.$transaction(async (tx) => {
      await ensureSettings(tx, guildId);
      await tx.$queryRaw(
        Prisma.sql`SELECT guild_id FROM guild_settings WHERE guild_id = ${guildId} FOR UPDATE`,
      );
      const current = await tx.guildSettings.findUnique({
        where: { guildId },
      });
      if (!current)
        return GuildSettingsDtoSchema.parse(await ensureSettings(tx, guildId));
      // Confirm ownership only while the raid is still active; a concurrent OFF
      // owns restoration and must not be second-guessed. The intent is already
      // recorded at activation, so this is an idempotent re-assertion.
      if (!current.raidModeEnabled)
        return GuildSettingsDtoSchema.parse(current);
      return GuildSettingsDtoSchema.parse(
        await tx.guildSettings.update({
          where: { guildId },
          data: { raidVerificationChanged: true },
        }),
      );
    });
  }
  public revokeVerificationRaised(guildId: string) {
    SnowflakeSchema.parse(guildId);
    return this.db.$transaction(async (tx) => {
      await ensureSettings(tx, guildId);
      await tx.$queryRaw(
        Prisma.sql`SELECT guild_id FROM guild_settings WHERE guild_id = ${guildId} FOR UPDATE`,
      );
      const current = await tx.guildSettings.findUnique({
        where: { guildId },
      });
      if (!current)
        return GuildSettingsDtoSchema.parse(await ensureSettings(tx, guildId));
      // Relinquish ownership only while the raid is still active; a concurrent
      // OFF owns restoration and must not be second-guessed.
      if (!current.raidModeEnabled)
        return GuildSettingsDtoSchema.parse(current);
      return GuildSettingsDtoSchema.parse(
        await tx.guildSettings.update({
          where: { guildId },
          data: { raidVerificationChanged: false },
        }),
      );
    });
  }
  public async deactivateWithCase(input: {
    guildId: string;
    actorUserId: string;
    reason: string;
  }): Promise<import('./contracts.js').RaidDeactivationDto> {
    SnowflakeSchema.parse(input.guildId);
    SnowflakeSchema.parse(input.actorUserId);
    ReasonSchema.parse(input.reason);
    return this.db.$transaction(async (tx) => {
      await ensureSettings(tx, input.guildId);
      await tx.$queryRaw(
        Prisma.sql`SELECT guild_id FROM guild_settings WHERE guild_id = ${input.guildId} FOR UPDATE`,
      );
      const current = await tx.guildSettings.findUnique({
        where: { guildId: input.guildId },
      });
      // Conditional, idempotent transition: a concurrent OFF that already won
      // leaves `changed` false and creates no additional case.
      if (!current?.raidModeEnabled)
        return {
          changed: false,
          settings: GuildSettingsDtoSchema.parse(
            current ?? (await ensureSettings(tx, input.guildId)),
          ),
          restoreLevel: null,
        };
      const restoreLevel =
        current.raidVerificationChanged &&
        current.verificationLevelBeforeRaid !== null
          ? current.verificationLevelBeforeRaid
          : null;
      const settings = await tx.guildSettings.update({
        where: { guildId: input.guildId },
        data: { raidModeEnabled: false, raidModeSource: null },
      });
      const createdCase = await allocateCase(tx, {
        guildId: input.guildId,
        action: 'RAIDMODE_OFF',
        targetDisplay: 'raidmode',
        moderatorUserId: input.actorUserId,
        source: 'RAIDMODE',
        status: 'COMPLETED',
        reason: input.reason,
      });
      return {
        changed: true,
        settings: GuildSettingsDtoSchema.parse(settings),
        case: validateDbOutput(createdCase),
        restoreLevel,
      };
    });
  }
  public async disableAutoIfIdle(
    guildId: string,
    now: Date,
    actorUserId: string,
  ): Promise<import('./contracts.js').RaidAutoDisableDto> {
    SnowflakeSchema.parse(guildId);
    SnowflakeSchema.parse(actorUserId);
    z.date().parse(now);
    return this.db.$transaction(async (tx) => {
      await ensureSettings(tx, guildId);
      await tx.$queryRaw(
        Prisma.sql`SELECT guild_id FROM guild_settings WHERE guild_id = ${guildId} FOR UPDATE`,
      );
      const settings = await tx.guildSettings.findUnique({
        where: { guildId },
      });
      if (!settings?.raidModeEnabled || settings.raidModeSource !== 'AUTO')
        return { disabled: false };
      const latest = await tx.raidJoinEvent.findFirst({
        where: { guildId },
        orderBy: { joinedAt: 'desc' },
      });
      if (latest) {
        const nextAt = new Date(latest.joinedAt.getTime() + 120_000);
        if (nextAt > now) {
          // Not idle yet. Keep the deadline at the repository-authoritative
          // latest-join deadline (max-only) inside this transaction so a stale
          // disable can never cancel or replace a newer join's deadline.
          await extendAutoDisableDeadline(tx, guildId, latest.joinedAt);
          return { disabled: false };
        }
      }
      // Idle: transition OFF and allocate the single OFF case atomically under
      // the same lock so a restore failure can never leave a durable OFF state
      // without exactly one case.
      const restoreLevel =
        settings.raidVerificationChanged &&
        settings.verificationLevelBeforeRaid !== null
          ? settings.verificationLevelBeforeRaid
          : null;
      const updated = await tx.guildSettings.update({
        where: { guildId },
        data: { raidModeEnabled: false, raidModeSource: null },
      });
      const createdCase = await allocateCase(tx, {
        guildId,
        action: 'RAIDMODE_OFF',
        targetDisplay: 'raidmode',
        moderatorUserId: actorUserId,
        source: 'RAIDMODE',
        status: 'COMPLETED',
        reason: t('raid:service.autoDisableReason'),
      });
      return {
        disabled: true,
        settings: GuildSettingsDtoSchema.parse(updated),
        case: validateDbOutput(createdCase),
        restoreLevel,
      };
    });
  }
  public async recordJoinAndEvaluate(
    guildId: string,
    userId: string,
    joinedAt: Date,
    threshold: number,
    windowSeconds: number,
    activation: import('./contracts.js').RaidActivation,
  ): Promise<RaidResultDto> {
    RaidEvaluationSchema.parse({
      guildId,
      userId,
      joinedAt,
      threshold,
      windowSeconds,
    });
    RaidActivationSchema.parse(activation);
    if (activation.guildId !== guildId)
      throw new Error('activation guild mismatch');
    return this.db.$transaction(async (tx) => {
      await ensureSettings(tx, guildId);
      await tx.$queryRaw(
        Prisma.sql`SELECT guild_id FROM guild_settings WHERE guild_id = ${guildId} FOR UPDATE`,
      );
      await tx.raidJoinEvent.createMany({
        data: { guildId, userId, joinedAt },
        skipDuplicates: true,
      });
      // Concurrent gateway deliveries are not guaranteed to commit in the
      // same order as their timestamps. Evaluate the window against the
      // newest committed join, rather than the transaction's possibly older
      // input timestamp, so the threshold cannot be missed.
      const latest = await tx.raidJoinEvent.findFirst({
        where: { guildId },
        orderBy: { joinedAt: 'desc' },
      });
      const windowEnd = latest?.joinedAt ?? joinedAt;
      const since = new Date(windowEnd.getTime() - windowSeconds * 1000);
      const count = await tx.raidJoinEvent.count({
        where: { guildId, joinedAt: { gte: since, lte: windowEnd } },
      });
      const current = await tx.guildSettings.findUnique({
        where: { guildId },
        select: { raidModeEnabled: true, raidModeSource: true },
      });
      if (current?.raidModeEnabled) {
        // Raid already active. For AUTO raids every join extends the disable
        // deadline to the repository-authoritative latest-join deadline. The
        // deadline only ever moves later (windowEnd is monotonic under the
        // guild lock and the update keeps the max), so out-of-order deliveries
        // or a concurrent completion can never shorten it.
        if (current.raidModeSource === 'AUTO')
          await extendAutoDisableDeadline(tx, guildId, windowEnd);
        return { activated: false, count };
      }
      if (count < threshold) return { activated: false, count };
      const settings = await tx.guildSettings.update({
        where: { guildId },
        data: {
          raidModeEnabled: true,
          raidModeSource: activation.source,
          raidModeReason: activation.reason ?? null,
          raidStartedAt: windowEnd,
          // Capture the prior level and record the verification-raise intent
          // (ownership) durably BEFORE the Discord raise so a crash after the
          // raise succeeds can still restore (see markVerificationRaised).
          verificationLevelBeforeRaid:
            activation.verificationLevelBeforeRaid ?? null,
          raidVerificationChanged: activation.changed,
        },
      });
      const createdCase = await allocateCase(tx, {
        guildId,
        action: 'RAIDMODE_ON',
        targetDisplay: 'raidmode',
        moderatorUserId: activation.actorUserId,
        source: 'RAIDMODE',
        status: 'COMPLETED',
        reason: activation.reason ?? 'AutoRaid',
      });
      await tx.scheduledAction.updateMany({
        where: {
          guildId,
          type: 'DISABLE_RAIDMODE',
          status: 'PENDING',
          targetUserId: null,
          channelId: null,
        },
        data: { status: 'CANCELLED' },
      });
      await tx.scheduledAction.create({
        data: {
          guildId,
          type: 'DISABLE_RAIDMODE',
          // Schedule from the newest committed join chosen for window
          // evaluation, not the possibly stale input timestamp, so
          // out-of-order gateway deliveries cannot pick an older idle base.
          executeAt: new Date(windowEnd.getTime() + 120_000),
          payload: { guildId },
          createdByCaseId: createdCase.id,
        },
      });
      return {
        activated: true,
        count,
        settings: GuildSettingsDtoSchema.parse(settings),
        case: validateDbOutput(createdCase),
      };
    });
  }
}

export class PrismaDepartureRepository implements DepartureRepository {
  public constructor(private readonly db: PrismaClient) {}
  public markLeft(input: import('./contracts.js').Departure) {
    DepartureSchema.parse(input);
    const eligible = new Date(input.departedAt.getTime() + 90 * 86_400_000);
    return this.db.guildLifecycleMarker
      .upsert({
        where: { guildId: input.guildId },
        create: {
          guildId: input.guildId,
          status: 'LEFT',
          departedAt: input.departedAt,
          cleanupEligibleAt: eligible,
        },
        update: {
          status: 'LEFT',
          departedAt: input.departedAt,
          cleanupEligibleAt: eligible,
        },
      })
      .then((row) => LifecycleDtoSchema.parse(row));
  }
  public markActive(guildId: string, at = new Date()) {
    return this.db.guildLifecycleMarker
      .upsert({
        where: { guildId },
        create: { guildId, status: 'ACTIVE', rejoinedAt: at },
        update: { status: 'ACTIVE', rejoinedAt: at, cleanupEligibleAt: null },
      })
      .then((row) => LifecycleDtoSchema.parse(row));
  }
  public async cleanupEligible(now = new Date()) {
    const rows = await this.db.guildLifecycleMarker.findMany({
      where: { status: 'LEFT', cleanupEligibleAt: { lte: now } },
      select: { guildId: true },
    });
    let count = 0;
    for (const row of rows) {
      count += await this.cleanupOne(row.guildId, now);
    }
    return count;
  }
  private cleanupOne(guildId: string, now: Date) {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT guild_id FROM guild_lifecycle_markers WHERE guild_id = ${guildId} FOR UPDATE`,
      );
      const marker = await tx.guildLifecycleMarker.findUnique({
        where: { guildId },
      });
      if (
        !marker ||
        marker.status !== 'LEFT' ||
        !marker.cleanupEligibleAt ||
        marker.cleanupEligibleAt > now
      )
        return 0;
      const activeJobs = await tx.scheduledAction.count({
        where: { guildId, status: { in: ['PENDING', 'RUNNING'] } },
      });
      if (activeJobs > 0) return 0;
      await tx.scheduledAction.deleteMany({
        where: {
          guildId,
          status: { in: ['COMPLETED', 'FAILED', 'CANCELLED'] },
        },
      });
      await tx.activeMute.deleteMany({ where: { guildId } });
      await tx.messageSnapshot.deleteMany({ where: { guildId } });
      await tx.guildMemberSnapshot.deleteMany({ where: { guildId } });
      await tx.raidJoinEvent.deleteMany({ where: { guildId } });
      await tx.ignoredRole.deleteMany({ where: { guildId } });
      await tx.ignoredChannel.deleteMany({ where: { guildId } });
      await tx.automodSettings.deleteMany({ where: { guildId } });
      await tx.punishment.deleteMany({ where: { guildId } });
      await tx.strikeTransaction.deleteMany({ where: { guildId } });
      await tx.userStrike.deleteMany({ where: { guildId } });
      await tx.moderationCase.deleteMany({ where: { guildId } });
      await tx.guildSettings.deleteMany({ where: { guildId } });
      return (
        await tx.guildLifecycleMarker.deleteMany({
          where: { guildId, status: 'LEFT' },
        })
      ).count;
    });
  }
}

async function ensureSettings(tx: DbTransaction, guildId: string) {
  return tx.guildSettings.upsert({
    where: { guildId },
    create: { guildId },
    update: {},
  });
}

/** Write-boundary guard for `moderation_cases.target_display` (spec
 * `01-platform-and-data.md §4.7`, `00-common.md §1.7`). For user-target
 * actions the persisted display must be a normalized name snapshot only — a
 * Snowflake, mention, or already-formatted `name (id)` is rejected so an
 * impossible display can never be newly persisted, even by a caller that
 * bypasses the canonical case factory. Non-user-target cases keep their
 * action-specific descriptor (e.g. `raidmode`) unchanged. Read schemas stay
 * lenient so legacy rows are never rejected on load. */
function assertUserTargetDisplay(input: CaseInput): void {
  if (
    isUserTargetAction(input.action) &&
    normalizeTargetDisplay(input.targetDisplay) === null
  )
    throw new Error(
      'user-target case target_display must be a normalized name snapshot (no Snowflake, mention, or formatted ID)',
    );
}

async function allocateCase(
  tx: DbTransaction,
  input: CaseInput,
  auditEntryId?: string,
) {
  assertUserTargetDisplay(input);
  const settings = await ensureSettings(tx, input.guildId);
  const rawRows = await tx.$queryRaw<unknown[]>(
    Prisma.sql`SELECT next_case_number FROM guild_settings WHERE guild_id = ${input.guildId} FOR UPDATE`,
  );
  const rows = rawRows.map((row) => CaseNumberRowSchema.parse(row));
  const caseNumber = rows[0]?.next_case_number ?? settings.nextCaseNumber;
  await tx.guildSettings.update({
    where: { guildId: input.guildId },
    data: { nextCaseNumber: { increment: 1 } },
  });
  return tx.moderationCase.create({
    data: {
      guildId: input.guildId,
      caseNumber,
      action: input.action,
      targetUserId: input.targetUserId ?? null,
      targetDisplay: input.targetDisplay,
      moderatorUserId: input.moderatorUserId,
      reason: input.reason ?? null,
      durationSeconds: input.durationSeconds ?? null,
      source: input.source,
      status: input.status,
      metadata: input.metadata ?? {},
      discordAuditLogEntryId: auditEntryId ?? null,
    },
  });
}

async function cancelMatching(tx: DbTransaction, input: ScheduledActionInput) {
  await tx.scheduledAction.updateMany({
    where: {
      guildId: input.guildId,
      targetUserId: input.targetUserId ?? null,
      channelId: input.channelId ?? null,
      type: input.type,
      status: 'PENDING',
    },
    data: { status: 'CANCELLED' },
  });
}

/** Extends the AUTO raid disable deadline to `windowEnd + 120s`, keeping the
 * later of the existing and new deadlines so it can never move earlier. */
async function extendAutoDisableDeadline(
  tx: DbTransaction,
  guildId: string,
  windowEnd: Date,
) {
  const deadline = new Date(windowEnd.getTime() + 120_000);
  const pending = await tx.scheduledAction.findFirst({
    where: {
      guildId,
      type: 'DISABLE_RAIDMODE',
      status: 'PENDING',
      targetUserId: null,
      channelId: null,
    },
  });
  if (pending) {
    if (pending.executeAt.getTime() < deadline.getTime())
      await tx.scheduledAction.update({
        where: { id: pending.id },
        data: { executeAt: deadline },
      });
    return;
  }
  await tx.scheduledAction.create({
    data: {
      guildId,
      type: 'DISABLE_RAIDMODE',
      executeAt: deadline,
      payload: { guildId },
      createdByCaseId: null,
    },
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}

function isRetryableSerialization(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error))
    return false;
  return error.code === 'P2002' || error.code === 'P2034';
}

function validateDbOutput(value: unknown): CaseDto {
  CaseDtoSchema.parse(value);
  return value as CaseDto;
}

function validateJobOutput(value: unknown): JobDto {
  const parsed = JobDtoSchema.parse(value);
  JobPayloadSchema.parse({ type: parsed.type, payload: parsed.payload });
  return parsed as JobDto;
}

function prismaJson(
  value: JsonValue,
): PrismaTypes.InputJsonValue | typeof Prisma.JsonNull {
  return value === null ? Prisma.JsonNull : value;
}
