import { err, ok, type Result } from '../../domain/result.js';
import { auditReason, clampBulkTargetLimit } from '../../domain/parsers.js';
import {
  CaseInputSchema,
  CaseDtoSchema,
  SnowflakeSchema,
  type CaseDto,
} from '../../repositories/contracts.js';
import {
  TargetIdentitySchema,
  isUserTargetAction,
} from '../../services/target-identity.js';
import type {
  ModerationBatchResult,
  ModerationDiscordPort,
  ModerationExecutionAction,
  ModerationOperationOptions,
  ModerationServiceDependencies,
  TargetOutcome,
} from './contracts.js';
import {
  fallbackTargetIdentity,
  type TargetIdentity,
} from '../../services/target-identity.js';
import { createCanonicalUserCase } from '../../services/case-service.js';
import { isUnauthorized } from '../logging/adapters.js';

const DAY = 86_400;
const validId = (id: string) => SnowflakeSchema.safeParse(id).success;

/** Public business contract for all moderation actions. Discord I/O stays behind the port. */
export class ModerationService {
  private readonly clock: () => Date;
  private readonly maxBulkTargets: number;
  public constructor(private readonly deps: ModerationServiceDependencies) {
    this.clock = deps.clock ?? (() => new Date());
    this.maxBulkTargets = clampBulkTargetLimit(deps.maxBulkTargets);
  }

  public kick(input: ModerationOperationOptions) {
    return this.apply(input, 'KICK');
  }
  public ban(input: ModerationOperationOptions) {
    return this.apply(input, 'BAN');
  }
  public silentBan(input: ModerationOperationOptions) {
    return this.apply(input, 'SILENTBAN');
  }
  public softBan(input: ModerationOperationOptions) {
    return this.apply(input, 'SOFTBAN');
  }
  public unban(input: ModerationOperationOptions) {
    return this.apply(input, 'UNBAN');
  }
  public mute(input: ModerationOperationOptions) {
    return this.apply(input, 'MUTE');
  }
  public unmute(input: ModerationOperationOptions) {
    return this.apply(input, 'UNMUTE');
  }
  public execute(
    input: ModerationOperationOptions,
    action: ModerationExecutionAction,
    context: Omit<
      import('./contracts.js').ModerationExecutionContext,
      'action'
    >,
  ) {
    return this.apply({ ...input, execution: { ...context, action } }, action);
  }

  private async apply(
    input: ModerationOperationOptions,
    action: ModerationExecutionAction,
  ): Promise<Result<ModerationBatchResult>> {
    if (
      !validId(input.guildId) ||
      !validId(input.actorId) ||
      input.targets.length === 0 ||
      input.targets.length > this.maxBulkTargets
    )
      return err('INVALID_INPUT', 'Invalid moderation input');
    const context = input.execution;
    const effectiveAction = context?.action ?? action;
    const reason = (context?.reason ?? input.reason ?? '理由未指定').trim();
    if (!reason || Array.from(reason).length > 1000)
      return err('INVALID_INPUT', 'Invalid reason');
    if (input.targets.some((target) => !validId(target.id)))
      return err('INVALID_INPUT', 'Invalid target');
    const preCreated = input.execution?.preCreatedCase;
    if (preCreated && input.targets.length !== 1)
      return err('INVALID_INPUT', 'A pre-created case requires one target');
    if (preCreated) {
      const parsedCase = CaseDtoSchema.safeParse(preCreated);
      const parsedIdentity = parsedCase.success
        ? TargetIdentitySchema.safeParse({
            userId: parsedCase.data.targetUserId,
            displayName: parsedCase.data.targetDisplay,
          })
        : undefined;
      const expectedSource =
        context?.source === 'AUTO_PUNISHMENT'
          ? 'PUNISHMENT'
          : context?.source === 'SCHEDULED'
            ? 'SCHEDULED'
            : context?.source === 'RAIDMODE'
              ? 'RAIDMODE'
              : 'COMMAND';
      const onlyTarget = input.targets[0];
      if (
        !parsedCase.success ||
        !onlyTarget ||
        parsedCase.data.guildId !== input.guildId ||
        parsedCase.data.action !== effectiveAction ||
        parsedCase.data.targetUserId !== onlyTarget.id ||
        !isUserTargetAction(parsedCase.data.action) ||
        parsedCase.data.source !== expectedSource ||
        parsedCase.data.status !== 'PENDING' ||
        parsedCase.data.moderatorUserId !== input.actorId ||
        (parsedCase.data.reason ?? '理由未指定') !== reason ||
        (parsedCase.data.durationSeconds ?? undefined) !==
          input.durationSeconds ||
        !parsedIdentity?.success ||
        parsedIdentity.data.displayName !== parsedCase.data.targetDisplay
      )
        return err('INVALID_INPUT', 'Invalid pre-created case');
    }
    if (
      input.targets.some((target) => {
        if (!target.identity) return false;
        const parsed = TargetIdentitySchema.safeParse(target.identity);
        return !parsed.success || parsed.data.userId !== target.id;
      })
    )
      return err('INVALID_INPUT', 'Invalid target identity');
    if (
      input.deleteMessages !== undefined &&
      (!Number.isInteger(input.deleteMessages) ||
        input.deleteMessages < 0 ||
        input.deleteMessages > 7 ||
        !['BAN', 'SOFTBAN', 'SILENTBAN'].includes(action))
    )
      return err('INVALID_INPUT', 'Invalid message deletion period');
    const maxDuration =
      action === 'BAN' || action === 'SILENTBAN' ? 365 * DAY : 28 * DAY;
    if (
      input.durationSeconds !== undefined &&
      (!Number.isInteger(input.durationSeconds) ||
        input.durationSeconds < 1 ||
        input.durationSeconds > maxDuration ||
        !['BAN', 'SILENTBAN', 'MUTE'].includes(action))
    )
      return err('INVALID_INPUT', 'Invalid duration');
    const outcomes: TargetOutcome[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < input.targets.length) {
        const index = next++;
        const target = input.targets[index];
        if (target === undefined) return;
        try {
          outcomes[index] = await this.one(
            input,
            effectiveAction,
            target,
            reason,
          );
        } catch (error: unknown) {
          const status = this.httpStatus(error);
          if (status === 401) throw error;
          const persistedIdentity = preCreated
            ? TargetIdentitySchema.safeParse({
                userId: preCreated.targetUserId,
                displayName: preCreated.targetDisplay,
              })
            : undefined;
          const exceptionIdentity = target.identity
            ? target.identity
            : persistedIdentity?.success
              ? persistedIdentity.data
              : this.deps.targetIdentityResolver
                ? (await this.resolveIdentity(input.guildId, target.id, null))
                    .identity
                : undefined;
          outcomes[index] = {
            targetId: target.id,
            ok: false,
            code: this.errorCode(error),
            ...(status !== undefined ? { status } : {}),
            ...(target.identity
              ? { identity: target.identity }
              : persistedIdentity?.success
                ? { identity: persistedIdentity.data }
                : exceptionIdentity
                  ? { identity: exceptionIdentity }
                  : {}),
            ...(preCreated ? { case: preCreated } : {}),
          };
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(5, input.targets.length) }, () => worker()),
    );
    return ok({ action: effectiveAction, outcomes });
  }

  private async one(
    input: ModerationOperationOptions,
    action: ModerationBatchResult['action'],
    target: { id: string; display?: string; identity?: TargetIdentity },
    reason: string,
  ): Promise<TargetOutcome> {
    const preCreated = input.execution?.preCreatedCase;
    const supplied = target.identity
      ? TargetIdentitySchema.parse(target.identity)
      : undefined;
    const persisted = preCreated
      ? TargetIdentitySchema.safeParse({
          userId: preCreated.targetUserId,
          displayName: preCreated.targetDisplay,
        })
      : undefined;
    if (preCreated && !persisted?.success)
      return { targetId: target.id, ok: false, code: 'INVALID_INPUT' };
    let member: Awaited<ReturnType<ModerationDiscordPort['getMember']>> = null;
    let user: Awaited<ReturnType<ModerationDiscordPort['getUser']>> = null;
    try {
      member = await this.deps.discord.getMember(input.guildId, target.id);
      user =
        member ?? (await this.deps.discord.getUser(input.guildId, target.id));
    } catch (error) {
      const status = this.httpStatus(error);
      if (status === 401) throw error;
      if (persisted?.success && preCreated)
        return {
          targetId: target.id,
          ok: false,
          code: this.errorCode(error),
          ...(status !== undefined ? { status } : {}),
          identity: persisted.data,
          case: preCreated,
        };
      if (supplied)
        return {
          targetId: target.id,
          ok: false,
          code: this.errorCode(error),
          ...(status !== undefined ? { status } : {}),
          identity: supplied,
        };
      if (this.deps.targetIdentityResolver) {
        const resolved = await this.resolveIdentity(
          input.guildId,
          target.id,
          null,
        );
        if (resolved.errorCode)
          return {
            targetId: target.id,
            ok: false,
            code: resolved.errorCode,
            ...(status !== undefined ? { status } : {}),
            identity: resolved.identity,
          };
        return {
          targetId: target.id,
          ok: false,
          code: this.errorCode(error),
          ...(status !== undefined ? { status } : {}),
          identity: resolved.identity,
        };
      }
      return {
        targetId: target.id,
        ok: false,
        code: this.errorCode(error),
        ...(status !== undefined ? { status } : {}),
      };
    }
    const resolved: TargetIdentity | undefined = persisted?.data ?? supplied;
    const identityResult = resolved
      ? { identity: resolved, errorCode: undefined }
      : await this.resolveIdentity(input.guildId, target.id, member);
    const identity = identityResult.identity;
    const failed = (
      code: string,
      caseValue?: CaseDto,
      status?: number,
    ): TargetOutcome => ({
      targetId: target.id,
      ok: false,
      code,
      ...(status !== undefined ? { status } : {}),
      ...(this.deps.targetIdentityResolver || supplied || preCreated
        ? { identity }
        : {}),
      ...(preCreated
        ? { case: caseValue ?? preCreated }
        : caseValue
          ? { case: caseValue }
          : {}),
    });
    if (identityResult.errorCode)
      return failed(identityResult.errorCode, undefined, identityResult.status);
    if (preCreated) {
      const expectedSource =
        input.execution.source === 'AUTO_PUNISHMENT'
          ? 'PUNISHMENT'
          : input.execution.source === 'SCHEDULED'
            ? 'SCHEDULED'
            : input.execution.source === 'RAIDMODE'
              ? 'RAIDMODE'
              : 'COMMAND';
      if (
        preCreated.guildId !== input.guildId ||
        preCreated.action !== action ||
        preCreated.targetUserId !== target.id ||
        !isUserTargetAction(preCreated.action) ||
        preCreated.source !== expectedSource ||
        preCreated.status !== 'PENDING'
      )
        return failed('INVALID_INPUT');
    }
    if (!user)
      return failed(
        member
          ? 'USER_NOT_FOUND'
          : action === 'KICK' || action === 'MUTE' || action === 'UNMUTE'
            ? 'MEMBER_NOT_FOUND'
            : 'USER_NOT_FOUND',
      );
    let botId: string;
    try {
      botId = await this.deps.discord.getBotUserId(input.guildId);
    } catch (error) {
      const status = this.httpStatus(error);
      if (status === 401) throw error;
      return failed(this.errorCode(error), undefined, status);
    }
    if (target.id === input.actorId) return failed('TARGET_IS_SELF');
    if (target.id === botId) return failed('TARGET_IS_BOT');
    if (
      (action === 'KICK' || action === 'MUTE' || action === 'UNMUTE') &&
      !member
    )
      return failed('MEMBER_NOT_FOUND');
    if (member?.isOwner) return failed('TARGET_IS_OWNER');
    let botRolePosition: number | undefined;
    if (member) {
      try {
        botRolePosition = await this.deps.discord.getBotRolePosition(
          input.guildId,
        );
      } catch (error) {
        const status = this.httpStatus(error);
        if (status === 401) throw error;
        return failed(this.errorCode(error), undefined, status);
      }
    }
    if (member && member.rolePosition >= (botRolePosition ?? -1))
      return failed('ROLE_HIERARCHY');
    let actorIsOwner = false;
    try {
      actorIsOwner = this.deps.discord.getActorIsOwner
        ? await this.deps.discord.getActorIsOwner(input.guildId, input.actorId)
        : false;
    } catch (error) {
      const status = this.httpStatus(error);
      if (status === 401) throw error;
      return failed(this.errorCode(error), undefined, status);
    }
    if (member && this.deps.discord.getActorRolePosition && !actorIsOwner) {
      let actorRole: number;
      try {
        actorRole = await this.deps.discord.getActorRolePosition(
          input.guildId,
          input.actorId,
        );
      } catch (error) {
        const status = this.httpStatus(error);
        if (status === 401) throw error;
        return failed(this.errorCode(error), undefined, status);
      }
      if (member.rolePosition >= actorRole) return failed('ROLE_HIERARCHY');
    }
    let pending: Awaited<ReturnType<ModerationService['createCase']>>;
    try {
      pending = await this.createCase(
        input,
        action,
        target.id,
        this.deps.targetIdentityResolver || supplied || preCreated
          ? identity.displayName
          : (member?.displayName ?? target.display ?? target.id),
        reason,
        identity,
      );
    } catch (error) {
      const status = this.httpStatus(error);
      if (status === 401) throw error;
      return failed(this.errorCode(error), undefined, status);
    }
    if (!pending.ok) return failed(pending.error.code);
    const audit = auditReason(pending.value.caseNumber, reason);
    if (!audit.ok) return failed(audit.error.code, pending.value);
    let dmDelivered = true;
    let apiError: unknown;
    let banSucceeded = false;
    let detachedDm: Promise<void> | undefined;
    let detachedFatal: unknown;
    try {
      if (
        input.execution?.sendDm !== false &&
        ['KICK', 'BAN', 'SILENTBAN', 'SOFTBAN', 'MUTE'].includes(action)
      ) {
        const dm = this.deps.discord.sendDm(
          target.id,
          `${input.guildId} から${action === 'KICK' ? 'キック' : action === 'MUTE' ? 'ミュート' : '制裁'}されました。\n理由: ${reason}\nケース: #${String(pending.value.caseNumber)}`,
        );
        if (input.execution?.waitForDm === false)
          detachedDm = dm.catch(async (error: unknown) => {
            if (this.errorStatus(error) !== 401) return;
            detachedFatal = error;
            if (preCreated) {
              this.deps.fatal?.(error);
              return;
            }
            try {
              await this.terminalizeFatal(error, pending.value);
            } catch (fatalError) {
              this.deps.fatal?.(fatalError);
            }
          });
        else {
          try {
            await dm;
          } catch (error) {
            if (this.errorStatus(error) === 401)
              throw preCreated
                ? error
                : await this.terminalizeFatal(error, pending.value);
            throw error;
          }
        }
      }
    } catch (error) {
      if (this.errorStatus(error) === 401) throw error;
      dmDelivered = false;
    }
    try {
      const correlationAction =
        action === 'SOFTBAN' || action === 'SILENTBAN' ? 'BAN' : action;
      const correlationKey = `${input.guildId}:${target.id}:${correlationAction}`;
      const correlationValue = {
        caseId: pending.value.id,
        createdAt: this.clock(),
        expiresAt: new Date(this.clock().getTime() + 15_000),
      };
      // Role transitions use role-specific correlation (roleCorrelation) for
      // Mute/Unmute deduplication; do not register the legacy one.
      if (action !== 'MUTE' && action !== 'UNMUTE') {
        if (this.deps.correlation?.put)
          this.deps.correlation.put('moderation', correlationKey, {
            caseId: pending.value.id,
          });
        else this.deps.correlation?.add?.(correlationKey, correlationValue);
      }
      if (action === 'KICK')
        await this.deps.discord.kick(input.guildId, target.id, audit.value);
      else if (
        action === 'BAN' ||
        action === 'SILENTBAN' ||
        action === 'SOFTBAN'
      ) {
        const banned = await this.deps.discord.isBanned(
          input.guildId,
          target.id,
        );
        if (!banned)
          await this.deps.discord.ban(
            input.guildId,
            target.id,
            action === 'SILENTBAN' ? 0 : (input.deleteMessages ?? 7) * DAY,
            audit.value,
          );
        banSucceeded = true;
        if (action === 'SOFTBAN')
          this.deps.correlation?.put?.(
            'moderation',
            `${input.guildId}:${target.id}:UNBAN`,
            {
              caseId: pending.value.id,
            },
          );
        if (action === 'SOFTBAN') {
          await this.deps.scheduler.cancel({
            guildId: input.guildId,
            targetUserId: target.id,
            channelId: null,
            type: 'UNBAN',
          });
          await this.deps.discord.unban(input.guildId, target.id, audit.value);
        } else if (input.durationSeconds)
          await this.schedule(
            input,
            target.id,
            'UNBAN',
            input.durationSeconds,
            pending.value.id,
          );
        else
          await this.deps.scheduler.cancel({
            guildId: input.guildId,
            targetUserId: target.id,
            channelId: null,
            type: 'UNBAN',
          });
      } else if (action === 'UNBAN') {
        if (!(await this.deps.discord.isBanned(input.guildId, target.id)))
          throw Object.assign(new Error('User is not banned'), {
            code: 'NOT_APPLIED',
          });
        await this.deps.discord.unban(input.guildId, target.id, audit.value);
        await this.deps.scheduler.cancel({
          guildId: input.guildId,
          targetUserId: target.id,
          channelId: null,
          type: 'UNBAN',
        });
      } else if (action === 'MUTE' || action === 'UNMUTE')
        await this.muteApi(
          input,
          target.id,
          action,
          audit.value,
          pending.value.id,
        );
    } catch (error) {
      if (this.errorStatus(error) === 401)
        throw preCreated
          ? error
          : await this.terminalizeFatal(error, pending.value);
      apiError = error;
    }
    if (detachedDm) await detachedDm;
    if (detachedFatal) {
      if (detachedFatal instanceof Error) throw detachedFatal;
      throw new Error('Fatal detached DM failure');
    }
    const failureCode = apiError ? this.errorCode(apiError) : undefined;
    const failureStatus = apiError ? this.httpStatus(apiError) : undefined;
    const partial =
      action === 'SOFTBAN' && apiError && banSucceeded
        ? 'PARTIAL'
        : apiError
          ? 'FAILED'
          : 'COMPLETED';
    let updated: Result<CaseDto> = pending;
    if (!preCreated) {
      try {
        updated = await this.deps.cases.updateStatus(
          input.guildId,
          pending.value.id,
          partial,
          failureCode,
        );
      } catch (error) {
        if (this.errorStatus(error) === 401) throw error;
        return failed(this.errorCode(error), pending.value);
      }
    }
    if (!preCreated) {
      try {
        await this.deps.cases.updateMetadata(input.guildId, pending.value.id, {
          dmDelivered,
          ...(apiError
            ? { errorCode: failureCode ?? 'DISCORD_API_ERROR' }
            : {}),
        });
      } catch (error) {
        if (this.errorStatus(error) === 401) throw error;
        return failed(this.errorCode(error), pending.value);
      }
      try {
        await this.deps.modlog?.writeCase(input.guildId, pending.value.id);
      } catch (error) {
        if (this.errorStatus(error) === 401) throw error;
        /* modlog is non-fatal */
      }
    }
    return apiError
      ? {
          targetId: target.id,
          ok: false,
          code: failureCode ?? 'DISCORD_API_ERROR',
          ...(failureStatus !== undefined ? { status: failureStatus } : {}),
          case: updated.ok ? updated.value : pending.value,
          ...(this.deps.targetIdentityResolver || supplied || preCreated
            ? { identity }
            : {}),
        }
      : {
          targetId: target.id,
          ok: true,
          case: updated.ok ? updated.value : pending.value,
          ...(this.deps.targetIdentityResolver || supplied || preCreated
            ? { identity }
            : {}),
        };
  }

  private async resolveIdentity(
    guildId: string,
    userId: string,
    member: { displayName?: unknown } | null,
  ): Promise<{
    identity: TargetIdentity;
    errorCode?: string;
    status?: number;
  }> {
    if (!this.deps.targetIdentityResolver)
      return { identity: fallbackTargetIdentity(userId) };
    try {
      const value = await this.deps.targetIdentityResolver.resolve(
        guildId,
        userId,
        { member },
      );
      const parsed = TargetIdentitySchema.safeParse(value);
      if (!parsed.success || parsed.data.userId !== userId)
        return {
          identity: fallbackTargetIdentity(userId),
          errorCode: 'INVALID_TARGET_IDENTITY',
        };
      return {
        identity: parsed.data,
      };
    } catch (error) {
      const status = this.httpStatus(error);
      if (status === 401) throw error;
      return {
        identity: fallbackTargetIdentity(userId),
        errorCode: this.errorCode(error),
        ...(status !== undefined ? { status } : {}),
      };
    }
  }

  private errorStatus(error: unknown): number | undefined {
    if (typeof error !== 'object' || error === null || !('status' in error))
      return undefined;
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  /** Resolves the underlying Discord HTTP status from an enforcement error,
   * unwrapping a `cause` wrapper the same way the scheduler classifier does so
   * the preserved outcome status classifies identically downstream. */
  private httpStatus(error: unknown): number | undefined {
    const source =
      error instanceof Error && 'cause' in error
        ? (error as Error & { cause?: unknown }).cause
        : error;
    const status =
      typeof source === 'object' && source !== null && 'status' in source
        ? (source as { status?: unknown }).status
        : undefined;
    return typeof status === 'number' ? status : undefined;
  }
  private errorCode(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string') return code;
    }
    return this.errorStatus(error) ? 'DISCORD_API_ERROR' : 'INTERNAL_ERROR';
  }

  private async terminalizeFatal(
    error: unknown,
    caseValue: CaseDto,
  ): Promise<never> {
    try {
      await this.deps.cases.updateStatus(
        caseValue.guildId,
        caseValue.id,
        'FAILED',
        this.errorCode(error),
      );
    } catch {
      /* Preserve the fatal error when persistence is unavailable. */
    }
    throw error;
  }

  private async createCase(
    input: ModerationOperationOptions,
    action: CaseDto['action'],
    targetUserId: string,
    display: string,
    reason: string,
    identity?: TargetIdentity,
  ) {
    if (input.execution?.preCreatedCase)
      return ok(input.execution.preCreatedCase);
    const parsed = CaseInputSchema.safeParse({
      guildId: input.guildId,
      action,
      targetUserId,
      targetDisplay: display,
      moderatorUserId: input.actorId,
      reason,
      durationSeconds: input.durationSeconds,
      source:
        input.execution?.source === 'AUTO_PUNISHMENT'
          ? 'PUNISHMENT'
          : (input.execution?.source ?? 'COMMAND'),
      status: 'PENDING',
      metadata: {},
    });
    if (!parsed.success) return err('INVALID_INPUT', 'Invalid case input');
    if (this.deps.targetIdentityResolver || identity) {
      return this.deps.cases.createCanonical(
        createCanonicalUserCase({
          ...parsed.data,
          identity:
            identity ??
            (
              await this.resolveIdentity(input.guildId, targetUserId, {
                displayName: display,
              })
            ).identity,
        }),
      );
    }
    return this.deps.cases.create(parsed.data);
  }
  private async schedule(
    input: ModerationOperationOptions,
    userId: string,
    type: 'UNBAN' | 'UNMUTE',
    seconds: number,
    caseId: string,
  ) {
    return this.deps.scheduler.schedule({
      guildId: input.guildId,
      targetUserId: userId,
      channelId: null,
      type,
      executeAt: new Date(this.clock().getTime() + seconds * 1000),
      payload: { guildId: input.guildId, userId },
      createdByCaseId: caseId,
    });
  }
  private async muteApi(
    input: ModerationOperationOptions,
    userId: string,
    action: 'MUTE' | 'UNMUTE',
    audit: string,
    caseId: string,
  ) {
    const settingsResult = await this.deps.settings.get(input.guildId);
    if (!settingsResult.ok) throw settingsResult.error;
    const settings = settingsResult.value;
    if (!settings.mutedRoleId)
      throw Object.assign(new Error('Muted role missing'), {
        code: 'CONFIGURATION_MISSING',
      });
    const mutedRoleId = settings.mutedRoleId;
    if (action === 'MUTE') {
      const apply = async (): Promise<void> => {
        const expiresAt = input.durationSeconds
          ? new Date(this.clock().getTime() + input.durationSeconds * 1000)
          : null;
        const hasRole =
          this.deps.hasRoleUnlocked ??
          this.deps.discord.hasRole.bind(this.deps.discord);
        const alreadyHas = await hasRole(input.guildId, userId, mutedRoleId);
        if (alreadyHas) {
          await this.deps.activeMutes.activateWithSchedule(
            input.guildId,
            userId,
            caseId,
            expiresAt,
            { type: 'UNMUTE', payload: { guildId: input.guildId, userId } },
          );
          return;
        }
        const addRole =
          this.deps.addRoleUnlocked ??
          this.deps.discord.addRole.bind(this.deps.discord);
        this.deps.roleCorrelation?.put(
          input.guildId,
          userId,
          mutedRoleId,
          'ADD',
        );
        try {
          await addRole(input.guildId, userId, mutedRoleId, audit);
        } catch (error) {
          this.deps.roleCorrelation?.remove(
            input.guildId,
            userId,
            mutedRoleId,
            'ADD',
          );
          throw error;
        }
        await this.deps.activeMutes.activateWithSchedule(
          input.guildId,
          userId,
          caseId,
          expiresAt,
          { type: 'UNMUTE', payload: { guildId: input.guildId, userId } },
        );
      };
      if (this.deps.roleMutationLock)
        await this.deps.roleMutationLock(input.guildId, userId, apply);
      else await apply();
    } else {
      const release = async (): Promise<void> => {
        const hasRole =
          this.deps.hasRoleUnlocked ??
          this.deps.discord.hasRole.bind(this.deps.discord);
        const currentlyHas = await hasRole(input.guildId, userId, mutedRoleId);
        if (!currentlyHas) {
          await this.deps.activeMutes.releaseWithSchedule(
            input.guildId,
            userId,
            'RELEASED',
          );
          await this.deps.scheduler.cancel({
            guildId: input.guildId,
            targetUserId: userId,
            channelId: null,
            type: 'UNMUTE',
          });
          return;
        }
        const removeRole =
          this.deps.removeRoleUnlocked ??
          this.deps.discord.removeRole.bind(this.deps.discord);
        this.deps.roleCorrelation?.put(
          input.guildId,
          userId,
          mutedRoleId,
          'REMOVE',
        );
        try {
          await removeRole(input.guildId, userId, mutedRoleId, audit);
        } catch (error) {
          this.deps.roleCorrelation?.remove(
            input.guildId,
            userId,
            mutedRoleId,
            'REMOVE',
          );
          throw error;
        }
        await this.deps.activeMutes.releaseWithSchedule(
          input.guildId,
          userId,
          'RELEASED',
        );
        await this.deps.scheduler.cancel({
          guildId: input.guildId,
          targetUserId: userId,
          channelId: null,
          type: 'UNMUTE',
        });
      };
      if (this.deps.roleMutationLock)
        await this.deps.roleMutationLock(input.guildId, userId, release);
      else await release();
    }
  }

  public async reason(
    guildId: string,
    caseNumber: number | undefined,
    value: string,
  ): Promise<Result<CaseDto>> {
    const reason = value.trim();
    if (!validId(guildId) || !reason || Array.from(reason).length > 1000)
      return err('INVALID_INPUT', 'Invalid reason');
    const found =
      caseNumber === undefined
        ? await this.deps.cases.latest(guildId)
        : await this.deps.cases.byNumber(guildId, caseNumber);
    if (!found.ok || !found.value) return err('NOT_FOUND', 'Case not found');
    const updated = await this.deps.cases.updateReason(
      guildId,
      found.value.id,
      reason,
    );
    if (updated.ok && this.deps.modlog?.editReason)
      try {
        await this.deps.modlog.editReason(guildId, updated.value.id, reason);
      } catch (error) {
        // A Discord authentication failure (401, direct or cause-wrapped) is
        // fatal and must propagate; any other modlog edit failure stays
        // best-effort because the DB update remains authoritative.
        if (isUnauthorized(error)) throw error;
        /* DB update remains authoritative. */
      }
    return updated;
  }
  public async clean(input: {
    guildId: string;
    channelId: string;
    limit?: number;
    bots?: boolean;
    embeds?: boolean;
    links?: boolean;
    images?: boolean;
    userId?: string;
    contains?: string;
    regex?: { test(value: string): boolean };
  }): Promise<
    Result<{
      searched: number;
      matched: number;
      deleted: number;
      failed: number;
    }>
  > {
    const limit = input.limit ?? 100;
    if (
      !validId(input.guildId) ||
      !validId(input.channelId) ||
      !Number.isInteger(limit) ||
      limit < 2 ||
      limit > 1000
    )
      return err('INVALID_INPUT', 'Invalid clean input');
    const messages: import('./contracts.js').ModerationMessage[] = [];
    let before: string | undefined;
    while (messages.length < limit) {
      const page = await this.deps.discord.fetchMessages(
        input.channelId,
        before,
        Math.min(100, limit - messages.length),
      );
      messages.push(...page);
      if (page.length < 100) break;
      before = page[page.length - 1]?.id;
      if (before === undefined) break;
    }
    const matches = messages
      .filter((message) => {
        const tests: boolean[] = [];
        if (input.bots) tests.push(message.authorIsBot || message.webhook);
        if (input.embeds) tests.push(message.embeds > 0);
        if (input.links)
          tests.push(/https?:\/\/|www\./iu.test(message.content));
        if (input.images)
          tests.push(
            message.embedMedia === true ||
              message.attachments.some(
                (a) =>
                  a.contentType?.startsWith('image/') ||
                  a.contentType?.startsWith('video/'),
              ),
          );
        if (input.userId) tests.push(message.authorId === input.userId);
        if (input.contains)
          tests.push(
            message.content
              .toLocaleLowerCase()
              .includes(input.contains.toLocaleLowerCase()),
          );
        if (input.regex) tests.push(input.regex.test(message.content));
        return tests.length === 0 || tests.some(Boolean);
      })
      .slice(0, limit);
    let deleted = 0;
    let failed = 0;
    const recent = matches.filter(
      (m) => this.clock().getTime() - m.createdAt.getTime() < 14 * DAY,
    );
    const batches: import('./contracts.js').ModerationMessage[][] = [];
    for (let index = 0; index < recent.length; index += 100)
      batches.push(recent.slice(index, index + 100));
    let cursor = 0;
    const bulkWorker = async (): Promise<void> => {
      while (cursor < batches.length) {
        const batch = batches[cursor++];
        if (batch === undefined) return;
        try {
          await this.deps.discord.deleteMessages(
            input.channelId,
            batch.map((m) => m.id),
          );
          deleted += batch.length;
        } catch (error) {
          // A Discord authentication failure (401, direct or cause-wrapped) is
          // fatal and must propagate rather than be tallied as a best-effort
          // deletion failure.
          if (isUnauthorized(error)) throw error;
          const status =
            typeof error === 'object' && error !== null && 'status' in error
              ? (error as { status?: number }).status
              : undefined;
          if (status === 404) deleted += batch.length;
          else failed += batch.length;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(3, Math.max(1, batches.length)) }, () =>
        bulkWorker(),
      ),
    );
    const old = matches.filter((m) => !recent.includes(m));
    cursor = 0;
    const oldWorker = async (): Promise<void> => {
      while (cursor < old.length) {
        const message = old[cursor++];
        if (message === undefined) return;
        try {
          await this.deps.discord.deleteMessage(input.channelId, message.id);
          deleted++;
        } catch (error) {
          // A Discord authentication failure (401, direct or cause-wrapped) is
          // fatal and must propagate rather than be tallied as a best-effort
          // deletion failure.
          if (isUnauthorized(error)) throw error;
          const status =
            typeof error === 'object' && error !== null && 'status' in error
              ? (error as { status?: number }).status
              : undefined;
          if (status === 404) deleted++;
          else failed++;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(3, Math.max(1, old.length)) }, () =>
        oldWorker(),
      ),
    );
    return ok({
      searched: messages.length,
      matched: matches.length,
      deleted,
      failed,
    });
  }
  public async slowmode(
    guildId: string,
    actorId: string,
    channelId: string,
    interval: number,
    durationSeconds?: number,
    reason = '理由未指定',
  ): Promise<Result<CaseDto | null>> {
    if (
      !validId(guildId) ||
      !validId(actorId) ||
      !validId(channelId) ||
      !Number.isInteger(interval) ||
      interval < 0 ||
      interval > 21600
    )
      return err('INVALID_INPUT', 'Invalid slowmode');
    if (
      durationSeconds !== undefined &&
      (!Number.isInteger(durationSeconds) ||
        durationSeconds < 1 ||
        durationSeconds > 28 * DAY)
    )
      return err('INVALID_INPUT', 'Invalid duration');
    const previous = await this.deps.discord.getSlowmode(channelId);
    const pending = await this.createCase(
      { guildId, actorId, targets: [], reason },
      'SLOWMODE',
      channelId,
      channelId,
      reason,
    );
    if (!pending.ok) return pending;
    const audit = auditReason(pending.value.caseNumber, reason);
    if (!audit.ok) return audit;
    this.deps.correlation?.putSlowmode?.(`${guildId}:${channelId}`, {
      previousInterval: previous,
      newInterval: interval,
    });
    try {
      await this.deps.discord.setSlowmode(channelId, interval, audit.value);
    } catch (error: unknown) {
      if (this.errorStatus(error) === 401) throw error;
      await this.deps.cases.updateStatus(
        guildId,
        pending.value.id,
        'FAILED',
        this.errorCode(error),
      );
      return err(this.errorCode(error), 'Slowmode failed');
    }
    if (durationSeconds)
      await this.deps.scheduler.schedule({
        guildId,
        targetUserId: null,
        channelId,
        type: 'RESTORE_SLOWMODE',
        executeAt: new Date(this.clock().getTime() + durationSeconds * 1000),
        payload: { guildId, channelId, interval: previous },
        createdByCaseId: null,
      });
    else
      await this.deps.scheduler.cancel({
        guildId,
        targetUserId: null,
        channelId,
        type: 'RESTORE_SLOWMODE',
      });
    const completed = await this.deps.cases.updateStatus(
      guildId,
      pending.value.id,
      'COMPLETED',
    );
    return completed.ok ? ok(completed.value) : ok(pending.value);
  }
}
