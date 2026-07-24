import { err, ok } from '../../domain/result.js';
import { SnowflakeSchema } from '../../repositories/contracts.js';
import type { RaidDependencies, RaidStatusResult } from './contracts.js';
import type { RaidMemberAdd } from './contracts.js';
import {
  TargetIdentitySchema,
  fallbackTargetIdentity,
  type TargetIdentity,
} from '../../services/target-identity.js';
import { t } from '../../i18n/index.js';

const validId = (value: string) => SnowflakeSchema.safeParse(value).success;
const reasonOf = (reason?: string) =>
  reason?.trim() || t('raid:service.reasonNotSpecified');

/** Discord authentication failures (401) must propagate so the runtime can
 * treat them as fatal; every other verification-level failure is non-fatal. */
const isAuthError = (error: unknown): boolean => {
  const source =
    error instanceof Error && 'cause' in error
      ? (error as Error & { cause?: unknown }).cause
      : error;
  const status =
    source && typeof source === 'object' && 'status' in source
      ? (source as { status?: unknown }).status
      : undefined;
  const code =
    source && typeof source === 'object' && 'code' in source
      ? (source as { code?: unknown }).code
      : undefined;
  return status === 401 || code === 401;
};

export class RaidService {
  private readonly clock: () => Date;
  /** Per-guild promise chains serialize the verification raise/ownership claim
   * against manual/scheduled OFF transitions for the same guild, while leaving
   * different guilds fully concurrent. */
  private readonly guildLocks = new Map<string, Promise<unknown>>();
  public constructor(private readonly deps: RaidDependencies) {
    this.clock = deps.clock ?? (() => new Date());
  }

  /** Runs `operation` exclusively for `guildId`. A failing operation does not
   * poison the queue for later waiters, and the chain entry is dropped once it
   * is the tail so idle guilds do not leak memory. */
  private async withGuildLock<T>(
    guildId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.guildLocks.get(guildId) ?? Promise.resolve();
    const current = previous.then(
      () => operation(),
      () => operation(),
    );
    const tail = current.catch(() => undefined);
    this.guildLocks.set(guildId, tail);
    try {
      return await current;
    } finally {
      if (this.guildLocks.get(guildId) === tail)
        this.guildLocks.delete(guildId);
    }
  }

  /** Spec §5.3.12 `/raidmode status`: the raid state plus the AutoRaid
   * settings. A settings read failure short-circuits; the AutoRaid read is the
   * same idempotent get-or-create used on join, so a default configuration
   * always renders. */
  public async status(guildId: string): Promise<RaidStatusResult> {
    const settings = await this.deps.settings.get(guildId);
    if (!settings.ok) return settings;
    return ok({
      settings: settings.value,
      autoRaid: await this.deps.automod.getOrCreate(guildId),
    });
  }

  public async setAutoRaid(
    guildId: string,
    enabled: boolean | undefined,
    joins?: number,
    seconds?: number,
  ) {
    if (!validId(guildId)) return err('INVALID_INPUT', 'Invalid guild ID');
    if (
      joins !== undefined &&
      (!Number.isInteger(joins) || joins < 3 || joins > 100)
    )
      return err('INVALID_INPUT', t('raid:errors.joinsRange'));
    if (
      seconds !== undefined &&
      (!Number.isInteger(seconds) || seconds < 2 || seconds > 300)
    )
      return err('INVALID_INPUT', t('raid:errors.secondsRange'));
    if (enabled === true && joins === undefined && seconds === undefined) {
      joins = 10;
      seconds = 10;
    }
    return ok(
      await this.deps.automod.update(guildId, {
        ...(enabled === undefined ? {} : { autoRaidEnabled: enabled }),
        ...(joins === undefined ? {} : { autoRaidJoinCount: joins }),
        ...(seconds === undefined ? {} : { autoRaidWindowSeconds: seconds }),
      }),
    );
  }

  public async on(
    guildId: string,
    actorId: string,
    reason?: string,
  ): Promise<ReturnType<typeof ok> | ReturnType<typeof err>> {
    if (!validId(guildId) || !validId(actorId))
      return err('INVALID_INPUT', 'Invalid ID');
    const current = await this.deps.settings.get(guildId);
    if (!current.ok) return current;
    if (current.value.raidModeEnabled) return ok({ settings: current.value });
    // Serialize activation/raise/ownership-claim against OFF for this guild so
    // an OFF cannot observe the pre-raise (ownership-unconfirmed) state.
    return this.withGuildLock(guildId, async () => {
      const level = await this.deps.discord.getVerificationLevel(guildId);
      const changed = level < 3;
      const activation = await this.deps.repository.activateManual({
        guildId,
        actorUserId: actorId,
        source: 'MANUAL',
        reason: reasonOf(reason),
        verificationLevelBeforeRaid: level,
        changed,
      });
      if (!activation.settings)
        return err('INTERNAL_ERROR', 'RaidMode state was not returned');
      // Invalidate before the Discord verification-level call so joins observe
      // the persisted raid state even if that call fails (no rollback).
      this.deps.settings.invalidate(guildId);
      if (changed)
        await this.raiseAndConfirmOwnership(guildId, reasonOf(reason));
      if (activation.activated && activation.case)
        await this.writeLog(guildId, 'RaidMode ON', activation.case.id);
      return ok({
        settings: activation.settings,
        ...(activation.case ? { case: activation.case } : {}),
      });
    });
  }

  public async off(guildId: string, actorId: string, reason?: string) {
    if (!validId(guildId) || !validId(actorId))
      return err('INVALID_INPUT', 'Invalid ID');
    // Serialize against an in-flight raise/ownership claim for this guild. The
    // conditional transition and the single OFF case are committed atomically
    // under the DB lock, so concurrent OFFs cannot duplicate the case/modlog
    // and a later restore failure cannot lose the case.
    return this.withGuildLock(guildId, async () => {
      const result = await this.deps.repository.deactivateWithCase({
        guildId,
        actorUserId: actorId,
        reason: reasonOf(reason),
      });
      if (!result.changed) return ok({ settings: result.settings });
      // Invalidate before the Discord verification-level call so joins observe
      // the persisted OFF state even if that call fails (no rollback).
      this.deps.settings.invalidate(guildId);
      // Log the durable case before attempting restoration so a propagate-able
      // 401 never leaves an OFF state without its case/modlog.
      if (result.case)
        await this.writeLog(guildId, 'RaidMode OFF', result.case.id);
      if (result.restoreLevel !== null)
        await this.restoreVerificationLevel(
          guildId,
          result.restoreLevel,
          reasonOf(reason),
        );
      return ok({
        settings: result.settings,
        ...(result.case ? { case: result.case } : {}),
      });
    });
  }

  public async memberAdd(member: RaidMemberAdd): Promise<void> {
    if (member.isBot) return;
    const now = this.clock();
    const auto = await this.deps.automod.getOrCreate(member.guildId);
    const current = await this.deps.settings.get(member.guildId);
    if (!current.ok) return;
    if (auto.autoRaidEnabled) {
      const verificationLevel = await this.deps.discord.getVerificationLevel(
        member.guildId,
      );
      const verificationChanged = verificationLevel < 3;
      // Serialize record/evaluate + raise + ownership claim against OFF for
      // this guild. The Kick/DM below stays outside the lock.
      await this.withGuildLock(member.guildId, async () => {
        const result = await this.deps.repository.recordJoinAndEvaluate(
          member.guildId,
          member.userId,
          now,
          auto.autoRaidJoinCount,
          auto.autoRaidWindowSeconds,
          {
            guildId: member.guildId,
            actorUserId: await this.deps.discord.getBotUserId(member.guildId),
            source: 'AUTO',
            reason: `AutoRaid: ${String(auto.autoRaidJoinCount)} joins in ${String(auto.autoRaidWindowSeconds)} seconds`,
            verificationLevelBeforeRaid: verificationLevel,
            changed: verificationChanged,
          },
        );
        if (result.activated) {
          // Invalidate before the Discord verification-level call so concurrent
          // joins observe the persisted raid state and still get kicked even if
          // that call fails (no rollback).
          this.deps.settings.invalidate(member.guildId);
          if (verificationChanged)
            await this.raiseAndConfirmOwnership(member.guildId, 'AutoRaid');
          if (result.case)
            await this.writeLog(member.guildId, 'RaidMode ON', result.case.id);
        }
      });
    } else
      await this.deps.repository.recordJoin(member.guildId, member.userId, now);
    const after = await this.deps.settings.get(member.guildId);
    if (!after.ok || !after.value.raidModeEnabled) return;
    // DM the joining member that the guild is locked down. DM delivery is
    // non-fatal (§8.2), but a Discord authentication failure (401) is fatal and
    // must propagate (§8.5). The send is bounded by a 2s timeout, and the send
    // promise keeps an attached handler so a rejection that settles after the
    // timeout wins the race cannot become an unhandled rejection.
    let dmError: unknown;
    let dmRaceDone = false;
    const dmSettled = this.deps.discord
      .getGuildName(member.guildId)
      .then((guildName) =>
        this.deps.discord.sendDm(
          member.userId,
          t('raid:service.lockdownDm', { guildName }),
        ),
      )
      .then(
        () => undefined,
        (error: unknown) => {
          dmError = error;
          // A 401 that settles after the timeout already won the race cannot be
          // thrown (memberAdd has moved on); escalate it explicitly so a late
          // authentication failure is not lost.
          if (dmRaceDone && isAuthError(error)) this.escalateFatalAuth(error);
        },
      );
    let dmTimeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      dmSettled,
      new Promise<void>((resolve) => {
        dmTimeout = setTimeout(resolve, 2000);
      }),
    ]);
    if (dmTimeout !== undefined) clearTimeout(dmTimeout);
    dmRaceDone = true;
    if (isAuthError(dmError)) throw dmError;
    /* Any other DM failure is non-fatal. */
    const identity = await this.resolveJoinIdentity(member);
    await this.deps.moderation.execute(
      {
        guildId: member.guildId,
        actorId: await this.deps.discord.getBotUserId(member.guildId),
        targets: [{ id: member.userId, identity }],
        reason: t('raid:service.lockdownKickReason'),
        execution: { source: 'RAIDMODE', sendDm: false, waitForDm: false },
      },
      'KICK',
      { source: 'RAIDMODE', sendDm: false, waitForDm: false },
    );
    // Automatic disable-deadline extension lives in the locked repository path
    // (recordJoinAndEvaluate); the service never replaces the job from a local
    // clock reading.
  }

  private async resolveJoinIdentity(
    member: RaidMemberAdd,
  ): Promise<TargetIdentity> {
    const supplied = TargetIdentitySchema.safeParse(member.identity);
    if (supplied.success && supplied.data.userId === member.userId)
      return supplied.data;
    if (this.deps.targetIdentityResolver) {
      try {
        const resolved = await this.deps.targetIdentityResolver.resolve(
          member.guildId,
          member.userId,
          { member: { displayName: member.displayName } },
        );
        const parsed = TargetIdentitySchema.safeParse(resolved);
        if (parsed.success && parsed.data.userId === member.userId)
          return parsed.data;
      } catch (error: unknown) {
        const status =
          error && typeof error === 'object' && 'status' in error
            ? (error as { status?: unknown }).status
            : undefined;
        const code =
          error && typeof error === 'object' && 'code' in error
            ? (error as { code?: unknown }).code
            : undefined;
        if (status === 401 || code === 401) throw error;
        /* Identity lookup failure must not prevent the lockdown kick. */
      }
    }
    return fallbackTargetIdentity(member.userId);
  }

  /** Scheduler entry point: stale jobs cannot disable manual raids or a raid
   * that received a newer join. The conditional OFF transition, the single OFF
   * case, and any idle-not-yet-disable deadline write are all committed
   * atomically in the repository; the service performs no deadline
   * replacement. */
  public async disableJob(guildId: string, now = this.clock()) {
    const actorId = await this.deps.discord.getBotUserId(guildId);
    return this.withGuildLock(guildId, async () => {
      const result = await this.deps.repository.disableAutoIfIdle(
        guildId,
        now,
        actorId,
      );
      if (result.disabled) {
        // Invalidate before the Discord verification-level call so joins
        // observe the persisted OFF state even if that call fails (no
        // rollback).
        this.deps.settings.invalidate(guildId);
        // Log the durable case before attempting restoration so a
        // propagate-able 401 never leaves an OFF state without its
        // case/modlog.
        if (result.case)
          await this.writeLog(guildId, 'RaidMode OFF', result.case.id);
        if (result.restoreLevel !== null && result.restoreLevel !== undefined)
          await this.restoreVerificationLevel(
            guildId,
            result.restoreLevel,
            t('raid:service.autoDisableReason'),
          );
      }
      return result;
    });
  }

  /** Raises the verification level after the raid transition is persisted.
   *
   * Crash-safe intent/ownership protocol: the ownership intent
   * (`raidVerificationChanged`) is recorded durably at activation, BEFORE this
   * Discord call, so a crash after the raise succeeds can still restore the
   * pre-raid level on a later OFF. On success the intent is re-asserted
   * (`markVerificationRaised`, idempotent). On a definitive non-auth failure the
   * intent is relinquished (`revokeVerificationRaised`) so a later OFF does not
   * restore a level the bot never raised. A crash before that revoke is still
   * safe: the OFF restore is guarded by the live "still HIGH" check, so an
   * unrevoked intent for a guild that is not at HIGH never restores. A 401 is
   * propagated as fatal without relinquishing (the process is going down, and
   * the live guard reconciles the intent on recovery). */
  private async raiseAndConfirmOwnership(
    guildId: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.deps.discord.setVerificationLevel(guildId, 3, reason);
    } catch (error: unknown) {
      if (isAuthError(error)) throw error;
      await this.deps.repository.revokeVerificationRaised(guildId);
      this.deps.logger?.warn(
        { event: 'raid.verification_raise_failed', guildId },
        'Verification raise failed; raid verification ownership relinquished',
      );
      return;
    }
    await this.deps.repository.markVerificationRaised(guildId);
  }

  /** Restores the pre-raid verification level when the bot raised it and the
   * guild is still at HIGH. A non-auth Discord failure must not block OFF
   * processing; a 401 is propagated as fatal. */
  private async restoreVerificationLevel(
    guildId: string,
    before: number,
    reason: string,
  ): Promise<void> {
    try {
      if ((await this.deps.discord.getVerificationLevel(guildId)) !== 3) return;
      await this.deps.discord.setVerificationLevel(guildId, before, reason);
    } catch (error: unknown) {
      if (isAuthError(error)) throw error;
    }
  }

  /** Modlog delivery is best-effort, but a Discord authentication failure (401)
   * is fatal and must propagate; every other delivery failure stays non-fatal. */
  private async writeLog(guildId: string, _title: string, caseId: string) {
    try {
      await this.deps.modlog?.writeCase(guildId, caseId);
    } catch (error: unknown) {
      if (isAuthError(error)) throw error;
      /* non-auth logging is non-fatal */
    }
  }

  /** Escalates a fatal Discord authentication failure discovered asynchronously
   * (e.g. a lockdown DM 401 that settles after its timeout) when there is no
   * awaiting caller to throw to. Mirrors the scheduler runtime's fatal
   * mechanism: log fatally, mark a nonzero exit status, and request shutdown. */
  private escalateFatalAuth(error: unknown): void {
    this.deps.logger?.fatal(
      {
        event: 'raid.fatal_discord_authentication',
        errorName: error instanceof Error ? error.name : 'unknown',
      },
      'Fatal Discord authentication failure; requesting runtime shutdown',
    );
    process.exitCode = 1;
    process.emit('SIGTERM');
  }
}
