import { err, ok, type Result } from '../../domain/result.js';
import {
  SnowflakeSchema,
  StrikeChangeSchema,
  type StrikeResult,
} from '../../repositories/contracts.js';
import type {
  StrikeChangeInput,
  StrikeCheck,
  StrikeServiceDependencies,
} from './contracts.js';
import { parseDuration } from '../../domain/parsers.js';
import {
  BAN_MAX_DURATION_SECONDS,
  punishmentDurationError,
} from '../../domain/punishment.js';
import {
  TargetIdentitySchema,
  fallbackTargetIdentity,
  type TargetIdentity,
} from '../../services/target-identity.js';
import {
  createCanonicalUserCase,
  type CanonicalUserCaseInput,
} from '../../services/case-service.js';

const valid = (id: string) => SnowflakeSchema.safeParse(id).success;

export function parseAdditionalTargets(
  value: string | null | undefined,
): Result<string[]> {
  if (!value) return ok([]);
  if (Array.from(value).length > 400)
    return err('INVALID_INPUT', 'Too many target IDs');
  const ids = value
    .split(/[\s,]+/u)
    .filter(Boolean)
    .map((item) => item.replace(/^<@!?|>$/gu, ''));
  if (ids.length > 19 || ids.some((id) => !valid(id)))
    return err('INVALID_INPUT', 'Invalid target IDs');
  return ok([...new Set(ids)]);
}

/** Owns strike accounting. The repository performs the locked, atomic mutation. */
export class StrikeService {
  public constructor(private readonly deps: StrikeServiceDependencies) {}

  public async strike(input: StrikeChangeInput): Promise<Result<StrikeResult>> {
    return this.change(input, 'MANUAL_STRIKE');
  }

  public async pardon(input: StrikeChangeInput): Promise<Result<StrikeResult>> {
    return this.change(input, 'PARDON');
  }

  public async autoModStrike(
    input: StrikeChangeInput,
  ): Promise<Result<StrikeResult>> {
    return this.change(input, 'AUTOMOD');
  }

  public async strikeMany(
    input: Omit<StrikeChangeInput, 'userId'> & { userIds: readonly string[] },
  ) {
    if (input.userIds.length === 0 || input.userIds.length > 20)
      return err('INVALID_INPUT', 'Invalid target count');
    return Promise.all(
      input.userIds.map((userId) => this.strike({ ...input, userId })),
    );
  }

  public async pardonMany(
    input: Omit<StrikeChangeInput, 'userId'> & { userIds: readonly string[] },
  ) {
    if (input.userIds.length === 0 || input.userIds.length > 20)
      return err('INVALID_INPUT', 'Invalid target count');
    return Promise.all(
      input.userIds.map((userId) => this.pardon({ ...input, userId })),
    );
  }

  private async change(
    input: StrikeChangeInput,
    source: 'MANUAL_STRIKE' | 'PARDON' | 'AUTOMOD',
  ) {
    const reason = input.reason.trim();
    if (
      !valid(input.guildId) ||
      !valid(input.userId) ||
      !valid(input.actorId) ||
      !Number.isInteger(input.amount) ||
      input.amount < 1 ||
      input.amount > 100 ||
      !reason ||
      Array.from(reason).length > 1000
    )
      return err('INVALID_INPUT', 'Invalid strike input');
    const user = await this.deps.discord.getUser(input.guildId, input.userId);
    if (!user) return err('USER_NOT_FOUND', 'User not found');
    const identityResult = await this.resolveIdentity(input);
    if (!identityResult.ok) return identityResult;
    const identity = identityResult.value;
    if (input.userId === input.actorId)
      return err('TARGET_IS_SELF', 'Cannot target yourself');
    if (
      this.deps.discord.getBotUserId &&
      input.userId === (await this.deps.discord.getBotUserId(input.guildId))
    )
      return err('TARGET_IS_BOT', 'Cannot target the bot');
    const action = source === 'PARDON' ? 'PARDON' : 'STRIKE';
    const caseInput = createCanonicalUserCase({
      guildId: input.guildId,
      action,
      moderatorUserId: input.actorId,
      reason,
      source: source === 'AUTOMOD' ? 'AUTOMOD' : 'COMMAND',
      status: 'PENDING',
      identity,
      metadata: {
        ...(input.evidence === undefined
          ? {}
          : {
              evidence:
                input.evidence as unknown as import('../../repositories/contracts.js').JsonValue,
            }),
        ...(input.warnings === undefined
          ? {}
          : { warnings: [...input.warnings] }),
      },
    });
    const parsed = StrikeChangeSchema.safeParse({
      guildId: input.guildId,
      userId: input.userId,
      requestedDelta: input.amount,
      source,
      actorUserId: input.actorId,
      reason,
      caseInput,
    });
    if (!parsed.success) return err('INVALID_INPUT', 'Invalid strike input');
    const result = await this.deps.strikes.changeLocked(parsed.data);
    if (result.delta === 0) return ok(result);
    const caseId = result.transaction?.modCaseId;
    if (caseId)
      await this.deps.cases.updateStatus(input.guildId, caseId, 'COMPLETED');
    const selectedPunishment =
      source === 'PARDON' ? undefined : result.crossedPunishments[0];
    let dmDelivered = true;
    try {
      const caseResult = caseId
        ? await this.deps.cases.get(input.guildId, caseId)
        : null;
      const caseNumber = caseResult?.ok
        ? caseResult.value?.caseNumber
        : undefined;
      let guildName = this.deps.discord.getGuildName
        ? await this.deps.discord.getGuildName(input.guildId)
        : `${input.guildId}${selectedPunishment ? `\n自動制裁: ${selectedPunishment.action}${selectedPunishment.durationSeconds ? ` (${String(selectedPunishment.durationSeconds)}秒)` : ''}` : ''}`;
      if (selectedPunishment && this.deps.discord.getGuildName)
        guildName += `\n自動制裁: ${selectedPunishment.action}${selectedPunishment.durationSeconds ? ` (${String(selectedPunishment.durationSeconds)}秒)` : ''}`;
      await this.deps.discord.sendDm(
        input.userId,
        `${guildName} で ${source === 'PARDON' ? `${String(Math.abs(result.delta))} ストライクが取り消されました。` : `${String(result.delta)} ストライクが付与されました。`}\n理由: ${reason}\n現在の合計: ${String(result.afterCount)}${caseNumber === undefined ? '' : `\nケース: #${String(caseNumber)}`}`,
      );
    } catch {
      dmDelivered = false;
    }
    if (caseId) {
      await this.deps.cases.updateMetadata(input.guildId, caseId, {
        dmDelivered,
      });
      try {
        await this.deps.modlog?.writeCase(input.guildId, caseId);
      } catch {
        /* non-fatal */
      }
    }
    if (selectedPunishment) {
      const punishment = selectedPunishment;
      const auto = await this.deps.moderation.execute(
        {
          guildId: input.guildId,
          actorId: input.actorId,
          targets: [{ id: identity.userId, identity }],
          reason: `${String(result.afterCount)}ストライクに到達: ${reason}`,
          ...(punishment.durationSeconds === null ||
          punishment.durationSeconds === undefined
            ? {}
            : { durationSeconds: punishment.durationSeconds }),
          execution: {
            source: 'AUTO_PUNISHMENT',
            sendDm: false,
            waitForDm: false,
          },
        },
        punishment.action,
        { source: 'AUTO_PUNISHMENT', sendDm: false, waitForDm: false },
      );
      if (caseId) {
        const metadata: Record<string, string | number | boolean | null> = {
          dmDelivered,
          punishment: punishment.action,
          punishmentDurationSeconds: punishment.durationSeconds ?? null,
          punishmentApplied:
            auto.ok && auto.value.outcomes.every((outcome) => outcome.ok),
        };
        if (!auto.ok) metadata.punishmentError = auto.error.message;
        await this.deps.cases.updateMetadata(input.guildId, caseId, metadata);
      }
      const failedOutcomes = auto.ok
        ? auto.value.outcomes.filter((outcome) => !outcome.ok)
        : [
            {
              targetId: input.userId,
              ok: false,
              code: auto.error.code,
              case: undefined,
            },
          ];
      for (const failedOutcome of failedOutcomes) {
        // ModerationService owns and returns a failed case when it reached
        // the case/operation boundary. Only synthesize a case for failures
        // that occurred before it could create one.
        if (failedOutcome.case) continue;
        const failedCase = await this.createCanonicalCase(
          createCanonicalUserCase({
            guildId: input.guildId,
            action: 'AUTO_PUNISHMENT',
            moderatorUserId: input.actorId,
            reason: `${String(result.afterCount)}ストライクに到達: ${reason}`,
            durationSeconds: punishment.durationSeconds,
            source: 'PUNISHMENT',
            status: 'FAILED',
            metadata: {
              error: failedOutcome.code ?? 'DISCORD_API_ERROR',
              punishment: punishment.action,
            },
            identity,
          }),
        );
        if (failedCase.ok) {
          try {
            await this.deps.modlog?.writeCase(
              input.guildId,
              failedCase.value.id,
            );
          } catch {
            /* non-fatal */
          }
        }
      }
    }
    return ok(result);
  }

  private async resolveIdentity(
    input: StrikeChangeInput,
  ): Promise<Result<TargetIdentity>> {
    if (input.identity) {
      const parsed = TargetIdentitySchema.safeParse(input.identity);
      return parsed.success && parsed.data.userId === input.userId
        ? ok(parsed.data)
        : err('INVALID_INPUT', 'Invalid target identity');
    }
    if (input.display !== undefined) {
      const parsed = TargetIdentitySchema.safeParse({
        userId: input.userId,
        displayName: input.display,
      });
      return parsed.success
        ? ok(parsed.data)
        : err('INVALID_INPUT', 'Invalid target identity');
    }
    try {
      if (this.deps.targetIdentityResolver) {
        const member = await this.deps.discord.getMember(
          input.guildId,
          input.userId,
        );
        const resolved = await this.deps.targetIdentityResolver.resolve(
          input.guildId,
          input.userId,
          member ? { member: { displayName: member.displayName } } : {},
        );
        const parsed = TargetIdentitySchema.safeParse(resolved);
        return parsed.success && parsed.data.userId === input.userId
          ? ok(parsed.data)
          : err('INVALID_INPUT', 'Invalid target identity');
      }
      return ok(fallbackTargetIdentity(input.userId));
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        (error as { status?: unknown }).status === 401
      )
        throw error;
      return err('INVALID_INPUT', 'Unable to resolve target identity');
    }
  }

  private async createCanonicalCase(input: CanonicalUserCaseInput) {
    if (typeof this.deps.cases.createCanonical === 'function')
      return this.deps.cases.createCanonical(input);
    return this.deps.cases.create(input);
  }

  public async check(
    guildId: string,
    userId: string,
  ): Promise<Result<StrikeCheck>> {
    if (!valid(guildId) || !valid(userId))
      return err('INVALID_INPUT', 'Invalid user');
    const rows = await this.deps.strikes.history(guildId, userId);
    const count = rows[0]?.afterCount ?? 0;
    const settings = await this.deps.settings?.get(guildId);
    const roleId = settings?.ok ? settings.value.mutedRoleId : null;
    const member = await this.deps.discord.getMember(guildId, userId);
    const muted = Boolean(
      member &&
      roleId &&
      this.deps.discord.hasMutedRole &&
      (await this.deps.discord.hasMutedRole(guildId, userId, roleId)),
    );
    let banned: boolean | null = null;
    try {
      banned = await this.deps.discord.isBanned(guildId, userId);
    } catch {
      /* partial result */
    }
    const punishments = await this.deps.punishments.list(guildId);
    const activeMute = this.deps.activeMutes
      ? await this.deps.activeMutes.getActive(guildId, userId)
      : null;
    const banExpiresAt = this.deps.discord.getBanExpiresAt
      ? await this.deps.discord.getBanExpiresAt(guildId, userId)
      : null;
    return ok({
      count,
      muted,
      banned,
      history: rows.slice(0, 5),
      next: punishments.find((p) => p.threshold > count) ?? null,
      muteExpiresAt: activeMute?.expiresAt ?? null,
      banExpiresAt,
    });
  }

  public async setPunishment(input: {
    guildId: string;
    actorId: string;
    threshold: number;
    action: 'MUTE' | 'KICK' | 'SOFTBAN' | 'BAN' | 'NONE';
    durationSeconds?: number | string | null;
  }) {
    let durationSeconds: number | string | null =
      input.durationSeconds === null || input.durationSeconds === undefined
        ? null
        : input.durationSeconds;
    if (typeof durationSeconds === 'string') {
      const parsedDuration = parseDuration(
        durationSeconds,
        BAN_MAX_DURATION_SECONDS,
      );
      if (!parsedDuration.ok) return parsedDuration;
      durationSeconds = parsedDuration.value;
    }
    const numericDuration: number | null =
      typeof durationSeconds === 'number' ? durationSeconds : null;
    if (
      !valid(input.guildId) ||
      !valid(input.actorId) ||
      !Number.isInteger(input.threshold) ||
      input.threshold < 1 ||
      input.threshold > 1_000_000
    )
      return err('INVALID_INPUT', 'Invalid punishment');
    if (input.action === 'NONE') {
      if (!this.deps.punishments.remove)
        return err('INTERNAL_ERROR', 'Punishment repository unavailable');
      const removed = await this.deps.punishments.remove(
        input.guildId,
        input.threshold,
      );
      return removed
        ? ok({ applied: true })
        : err('NOT_APPLIED', 'Punishment is not configured');
    }
    const durationError = punishmentDurationError(
      input.action,
      numericDuration,
    );
    if (durationError) return err('INVALID_INPUT', durationError);
    if (!this.deps.punishments.set)
      return err('INTERNAL_ERROR', 'Punishment repository unavailable');
    return ok({
      punishment: await this.deps.punishments.set(
        input.guildId,
        input.threshold,
        input.action,
        numericDuration,
        input.actorId,
      ),
    });
  }

  public async removePunishment(guildId: string, threshold: number) {
    if (
      !valid(guildId) ||
      !Number.isInteger(threshold) ||
      threshold < 1 ||
      threshold > 1_000_000
    )
      return err('INVALID_INPUT', 'Invalid threshold');
    if (!this.deps.punishments.remove)
      return err('INTERNAL_ERROR', 'Punishment repository unavailable');
    const removed = await this.deps.punishments.remove(guildId, threshold);
    return removed
      ? ok({ applied: true })
      : err('NOT_APPLIED', 'Punishment is not configured');
  }

  public async listPunishments(guildId: string) {
    if (!valid(guildId)) return err('INVALID_INPUT', 'Invalid guild');
    return ok(await this.deps.punishments.list(guildId));
  }
}
