import { err, ok } from '../../domain/result.js';
import {
  SnowflakeSchema,
  CaseInputSchema,
} from '../../repositories/contracts.js';
import type { RaidDependencies } from './contracts.js';
import type { RaidMemberAdd } from './contracts.js';
import {
  TargetIdentitySchema,
  fallbackTargetIdentity,
  type TargetIdentity,
} from '../../services/target-identity.js';

const validId = (value: string) => SnowflakeSchema.safeParse(value).success;
const reasonOf = (reason?: string) => reason?.trim() || '理由未指定';

export class RaidService {
  private readonly clock: () => Date;
  public constructor(private readonly deps: RaidDependencies) {
    this.clock = deps.clock ?? (() => new Date());
  }

  public status(guildId: string) {
    return this.deps.settings.get(guildId);
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
      return err('INVALID_INPUT', 'joinsは3～100です');
    if (
      seconds !== undefined &&
      (!Number.isInteger(seconds) || seconds < 2 || seconds > 300)
    )
      return err('INVALID_INPUT', 'secondsは2～300です');
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
    const level = await this.deps.discord.getVerificationLevel(guildId);
    const changed = level < 3;
    if (changed)
      await this.deps.discord.setVerificationLevel(
        guildId,
        3,
        reasonOf(reason),
      );
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
    this.deps.settings.invalidate(guildId);
    if (activation.activated && activation.case)
      await this.writeLog(guildId, 'RaidMode ON', activation.case.id);
    return ok({
      settings: activation.settings,
      ...(activation.case ? { case: activation.case } : {}),
    });
  }

  public async off(guildId: string, actorId: string, reason?: string) {
    if (reason === 'AutoRaid自動解除') {
      await this.disableJob(guildId);
      return this.deps.settings.get(guildId);
    }
    const current = await this.deps.settings.get(guildId);
    if (!current.ok) return current;
    if (!current.value.raidModeEnabled) return ok({ settings: current.value });
    if (
      current.value.raidVerificationChanged &&
      current.value.verificationLevelBeforeRaid !== null &&
      current.value.verificationLevelBeforeRaid !== undefined &&
      (await this.deps.discord.getVerificationLevel(guildId)) === 3
    )
      await this.deps.discord.setVerificationLevel(
        guildId,
        current.value.verificationLevelBeforeRaid,
        reasonOf(reason),
      );
    const settings = await this.deps.repository.deactivate(guildId);
    this.deps.settings.invalidate(guildId);
    const created = await this.createCase(
      guildId,
      actorId,
      'RAIDMODE_OFF',
      reasonOf(reason),
    );
    if (created.ok)
      await this.writeLog(guildId, 'RaidMode OFF', created.value.id);
    return ok({ settings, ...(created.ok ? { case: created.value } : {}) });
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
        if (verificationChanged)
          await this.deps.discord.setVerificationLevel(
            member.guildId,
            3,
            'AutoRaid',
          );
        this.deps.settings.invalidate(member.guildId);
        if (result.case)
          await this.writeLog(member.guildId, 'RaidMode ON', result.case.id);
      }
    } else
      await this.deps.repository.recordJoin(member.guildId, member.userId, now);
    const after = await this.deps.settings.get(member.guildId);
    if (!after.ok || !after.value.raidModeEnabled) return;
    try {
      await Promise.race([
        this.deps.discord.sendDm(
          member.userId,
          `${await this.deps.discord.getGuildName(member.guildId)} は現在ロックダウン中です。\n安全確保のため新規参加を一時的に停止しています。\n時間を置いて再度参加してください。`,
        ),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch {
      /* DM failure is non-fatal. */
    }
    const identity = await this.resolveJoinIdentity(member);
    await this.deps.moderation.execute(
      {
        guildId: member.guildId,
        actorId: await this.deps.discord.getBotUserId(member.guildId),
        targets: [{ id: member.userId, identity }],
        reason: 'RaidModeによるロックダウン',
        execution: { source: 'RAIDMODE', sendDm: false, waitForDm: false },
      },
      'KICK',
      { source: 'RAIDMODE', sendDm: false, waitForDm: false },
    );
    if (after.value.raidModeSource === 'AUTO')
      await this.deps.scheduler.schedule({
        guildId: member.guildId,
        targetUserId: null,
        channelId: null,
        type: 'DISABLE_RAIDMODE',
        executeAt: new Date(now.getTime() + 120_000),
        payload: { guildId: member.guildId },
        createdByCaseId: null,
      });
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
   * that received a newer join. */
  public async disableJob(guildId: string, now = this.clock()) {
    const before = await this.deps.settings.get(guildId);
    if (!before.ok) return before;
    const result = await this.deps.repository.disableAutoIfIdle(guildId, now);
    if (result.disabled) {
      if (
        before.value.raidVerificationChanged &&
        before.value.verificationLevelBeforeRaid !== null &&
        before.value.verificationLevelBeforeRaid !== undefined &&
        (await this.deps.discord.getVerificationLevel(guildId)) === 3
      )
        await this.deps.discord.setVerificationLevel(
          guildId,
          before.value.verificationLevelBeforeRaid,
          'AutoRaid自動解除',
        );
      this.deps.settings.invalidate(guildId);
      const actorId = await this.deps.discord.getBotUserId(guildId);
      const created = await this.createCase(
        guildId,
        actorId,
        'RAIDMODE_OFF',
        'AutoRaid自動解除',
      );
      if (created.ok)
        await this.writeLog(guildId, 'RaidMode OFF', created.value.id);
    }
    if (result.nextAt)
      await this.deps.scheduler.schedule({
        guildId,
        targetUserId: null,
        channelId: null,
        type: 'DISABLE_RAIDMODE',
        executeAt: result.nextAt,
        payload: { guildId },
        createdByCaseId: null,
      });
    return result;
  }

  private async createCase(
    guildId: string,
    actorId: string,
    action: 'RAIDMODE_ON' | 'RAIDMODE_OFF',
    reason: string,
  ) {
    const input = CaseInputSchema.parse({
      guildId,
      action,
      targetDisplay: 'raidmode',
      moderatorUserId: actorId,
      reason,
      source: 'RAIDMODE',
      status: 'COMPLETED',
      metadata: {},
    });
    return this.deps.cases.create(input);
  }
  private async writeLog(guildId: string, _title: string, caseId: string) {
    try {
      await this.deps.modlog?.writeCase(guildId, caseId);
    } catch {
      /* logging is non-fatal */
    }
  }
}
