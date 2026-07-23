import type { CaseDto, JobDto } from '../../repositories/contracts.js';
import type { ScheduledCaseTerminalization } from '../../repositories/contracts.js';
import { SCHEDULED_MAX_ATTEMPTS } from '../../repositories/contracts.js';
import type { Result } from '../../domain/result.js';
import type { SchedulerService } from '../../services/scheduler-service.js';
import type { ModerationService } from './moderation-service.js';

const DEFAULT_REASON = '理由未指定';

export interface ScheduledModerationDiscordPort {
  getBotUserId(guildId: string): Promise<string>;
  hasRole(guildId: string, userId: string, roleId: string): Promise<boolean>;
  removeRoleUnlocked(
    guildId: string,
    userId: string,
    roleId: string,
    auditReason: string,
  ): Promise<void>;
  withRoleMutationLock<T>(
    guildId: string,
    userId: string,
    operation: () => Promise<T>,
  ): Promise<T>;
}

export interface ScheduledMuteOwnershipPort {
  claimScheduledUnmute(
    guildId: string,
    userId: string,
    jobId: string,
    workerId: string,
  ): Promise<boolean>;
  verifyScheduledUnmute(
    guildId: string,
    userId: string,
    jobId: string,
    workerId: string,
  ): Promise<boolean>;
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

export interface ScheduledModerationDependencies {
  readonly scheduler: Pick<
    SchedulerService,
    'createScheduledCase' | 'terminalizeScheduledCase' | 'classify'
  >;
  readonly moderation: Pick<ModerationService, 'execute'>;
  readonly discord: ScheduledModerationDiscordPort;
  readonly activeMutes: ScheduledMuteOwnershipPort;
  readonly settings: {
    get(
      guildId: string,
    ): Promise<Result<{ mutedRoleId?: string | null | undefined }>>;
  };
  readonly roleCorrelation: {
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
  readonly modlog: {
    writeCase(guildId: string, caseId: string): Promise<unknown>;
  };
  readonly workerId: string;
}

/** Runtime dispatch for scheduled UNBAN/UNMUTE jobs (limited scheduled-state
 * lane).
 *
 * Each dispatch creates or claims exactly one SCHEDULED moderation case via the
 * scheduler's idempotent `createScheduledCase` primitive, uses it as the
 * pre-created case for enforcement, terminalizes that same case exactly once via
 * `terminalizeScheduledCase`, and attempts modlog only when terminalization
 * wins. Retries/crashes after Discord success never create duplicate
 * cases/modlogs: `createScheduledCase` returns the existing case
 * (`created: false`) and `terminalizeScheduledCase` returns `false` once the
 * case has left PENDING.
 *
 * Classification preserves the underlying Discord HTTP status (carried on the
 * moderation outcome): 401 propagates fatal/unterminalized, 400/403 terminalize
 * FAILED, 5xx/network stay retryable, and idempotent outcomes terminalize
 * COMPLETED. At the final attempt (`SCHEDULED_MAX_ATTEMPTS`) a retryable failure
 * terminalizes FAILED + modlog; the repository's retry-exhaustion/stale-recovery
 * fallback fails a still-PENDING linked case if the dispatcher crashes first. */
export class ScheduledModerationDispatcher {
  public constructor(private readonly deps: ScheduledModerationDependencies) {}

  public dispatch(job: JobDto): Promise<void> {
    if (job.type === 'UNBAN') return this.dispatchUnban(job);
    if (job.type === 'UNMUTE') return this.dispatchUnmute(job);
    throw new Error(`Unsupported scheduled moderation type: ${job.type}`);
  }

  private payload(job: JobDto): { guildId: string; userId: string } {
    const payload = job.payload as { guildId?: string; userId?: string };
    if (!payload.guildId || !payload.userId)
      throw new Error('Invalid moderation job payload');
    return { guildId: payload.guildId, userId: payload.userId };
  }

  private isFinalAttempt(job: JobDto): boolean {
    return job.attempts >= SCHEDULED_MAX_ATTEMPTS;
  }

  private async dispatchUnban(job: JobDto): Promise<void> {
    const { guildId, userId } = this.payload(job);
    const fallbackModerator = await this.deps.discord.getBotUserId(guildId);
    const created = await this.deps.scheduler.createScheduledCase(
      job.id,
      fallbackModerator,
    );
    if (!created.ok)
      throw Object.assign(new Error('Invalid scheduled case request'), {
        status: 400,
      });
    const scheduledCase = created.value.case;
    const terminalization = created.value.terminalization;
    const reason = scheduledCase.reason ?? DEFAULT_REASON;
    const actorId = scheduledCase.moderatorUserId;
    // A thrown 401 from enforcement propagates unterminalized (fatal); the case
    // stays PENDING for recovery, matching the moderation service's pre-created
    // 401 behavior.
    const result = await this.deps.moderation.execute(
      {
        guildId,
        actorId,
        targets: [{ id: userId }],
        reason,
        execution: {
          source: 'SCHEDULED',
          sendDm: false,
          waitForDm: false,
          preCreatedCase: scheduledCase,
        },
      },
      'UNBAN',
      {
        source: 'SCHEDULED',
        sendDm: false,
        waitForDm: false,
        preCreatedCase: scheduledCase,
      },
    );
    const outcome = result.ok ? result.value.outcomes[0] : undefined;
    if (result.ok && outcome?.ok) {
      await this.terminalizeAndLog(terminalization, guildId, 'COMPLETED');
      return;
    }
    const code =
      outcome?.code ?? (result.ok ? 'NOT_APPLIED' : result.error.code);
    const status = outcome?.status;
    const classification = this.deps.scheduler.classify(
      this.classificationError(code, status),
    );
    if (classification === 'IDEMPOTENT_SUCCESS') {
      await this.terminalizeAndLog(terminalization, guildId, 'COMPLETED');
      return;
    }
    if (classification === 'FATAL') {
      // 401: propagate without terminalizing so the case stays recoverable.
      throw this.classificationError(code, status ?? 401);
    }
    if (classification === 'RETRYABLE') {
      // Final attempt: terminalize FAILED + modlog so the case is not left
      // PENDING; the repository fallback covers a crash before this point.
      if (this.isFinalAttempt(job))
        await this.terminalizeAndLog(terminalization, guildId, 'FAILED', code);
      throw this.classificationError(code, status);
    }
    // FAILED (400/403/429): terminalize once + modlog, then surface as terminal.
    await this.terminalizeAndLog(terminalization, guildId, 'FAILED', code);
    throw this.classificationError(code, status);
  }

  private async dispatchUnmute(job: JobDto): Promise<void> {
    const { guildId, userId } = this.payload(job);
    const fallbackModerator = await this.deps.discord.getBotUserId(guildId);
    const created = await this.deps.scheduler.createScheduledCase(
      job.id,
      fallbackModerator,
    );
    if (!created.ok)
      throw Object.assign(new Error('Invalid scheduled case request'), {
        status: 400,
      });
    const terminalization = created.value.terminalization;
    try {
      await this.deps.discord.withRoleMutationLock(
        guildId,
        userId,
        async () => {
          const settingsResult = await this.deps.settings.get(guildId);
          const roleId = settingsResult.ok
            ? settingsResult.value.mutedRoleId
            : null;
          if (!roleId) throw new Error('Muted role is not configured');
          const ownsJob = await this.deps.activeMutes.claimScheduledUnmute(
            guildId,
            userId,
            job.id,
            this.deps.workerId,
          );
          if (!ownsJob)
            throw Object.assign(new Error('Mute is no longer active'), {
              code: 'NOT_APPLIED',
            });
          try {
            if (
              !(await this.deps.activeMutes.verifyScheduledUnmute(
                guildId,
                userId,
                job.id,
                this.deps.workerId,
              ))
            )
              throw Object.assign(
                new Error('Scheduled unmute was superseded'),
                { code: 'NOT_APPLIED' },
              );
            // Check actual role presence; no-op if already removed.
            const actuallyHas = await this.deps.discord.hasRole(
              guildId,
              userId,
              roleId,
            );
            if (!actuallyHas) {
              // Role already absent: expire the mute if still ACTIVE. Whether or
              // not the CAS wins, the member is unmuted, so this is settled.
              await this.deps.activeMutes.completeScheduledUnmute(
                guildId,
                userId,
                job.id,
                this.deps.workerId,
              );
              return;
            }
            this.deps.roleCorrelation.put(guildId, userId, roleId, 'REMOVE');
            try {
              await this.deps.discord.removeRoleUnlocked(
                guildId,
                userId,
                roleId,
                `scheduled:${job.id}`,
              );
            } catch (error) {
              this.deps.roleCorrelation.remove(
                guildId,
                userId,
                roleId,
                'REMOVE',
              );
              throw error;
            }
            // Require the mute-side CAS to succeed before terminalizing
            // COMPLETED; completeScheduledUnmute expires the mute and leaves the
            // job RUNNING for terminalizeScheduledCase to complete.
            const completed =
              await this.deps.activeMutes.completeScheduledUnmute(
                guildId,
                userId,
                job.id,
                this.deps.workerId,
              );
            if (!completed)
              throw new Error('Scheduled unmute ownership was lost');
          } catch (error) {
            await this.deps.activeMutes.restoreScheduledUnmute(
              guildId,
              userId,
              job.id,
              this.deps.workerId,
            );
            throw error;
          }
        },
      );
    } catch (error) {
      const classification = this.deps.scheduler.classify(error);
      if (classification === 'FATAL') throw error;
      if (classification === 'IDEMPOTENT_SUCCESS') {
        await this.terminalizeAndLog(terminalization, guildId, 'COMPLETED');
        return;
      }
      if (classification === 'RETRYABLE') {
        if (this.isFinalAttempt(job))
          await this.terminalizeAndLog(
            terminalization,
            guildId,
            'FAILED',
            this.errorCode(error),
          );
        throw error;
      }
      await this.terminalizeAndLog(
        terminalization,
        guildId,
        'FAILED',
        this.errorCode(error),
      );
      throw error;
    }
    // The lock completed without throwing: the mute-side CAS succeeded (or the
    // role was already absent and the mute is settled), so terminalize COMPLETED.
    await this.terminalizeAndLog(terminalization, guildId, 'COMPLETED');
  }

  /** Terminalizes the scheduled case once and attempts modlog only when this
   * call wins the terminalization (subsequent calls return `false` and skip
   * modlog). An unauthorized modlog delivery is rethrown so the gateway fatal
   * handler sees it; any other delivery failure is non-fatal. */
  private async terminalizeAndLog(
    terminalization: ScheduledCaseTerminalization,
    guildId: string,
    status: 'COMPLETED' | 'FAILED',
    errorCode?: string,
  ): Promise<void> {
    const result = await this.deps.scheduler.terminalizeScheduledCase({
      ...terminalization,
      status,
      ...(errorCode !== undefined ? { errorCode } : {}),
    });
    if (!result.ok || !result.value) return;
    try {
      await this.deps.modlog.writeCase(guildId, terminalization.executedCaseId);
    } catch (error) {
      if (this.isUnauthorized(error)) throw error;
      /* non-auth modlog failure: the terminalized case remains authoritative. */
    }
  }

  private classificationError(code: string, status?: number): Error {
    return Object.assign(new Error(`Scheduled action failed: ${code}`), {
      code,
      ...(status !== undefined ? { status } : {}),
    });
  }

  private isUnauthorized(error: unknown): boolean {
    const marker = (value: unknown): boolean => {
      if (typeof value !== 'object' || value === null) return false;
      const status =
        'status' in value ? (value as { status?: unknown }).status : undefined;
      const code =
        'code' in value ? (value as { code?: unknown }).code : undefined;
      return status === 401 || code === 401;
    };
    if (marker(error)) return true;
    if (typeof error === 'object' && error !== null && 'cause' in error)
      return marker((error as { cause?: unknown }).cause);
    return false;
  }

  private errorCode(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && code.length > 0) return code;
    }
    const status =
      typeof error === 'object' && error !== null && 'status' in error
        ? (error as { status?: number }).status
        : undefined;
    return status ? 'DISCORD_API_ERROR' : 'INTERNAL_ERROR';
  }
}

export type { CaseDto };
