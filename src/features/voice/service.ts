import { err, ok } from '../../domain/result.js';
import type {
  VoiceCasePort,
  VoiceMember,
  VoicePort,
  VoiceResult,
  VoiceSession,
  VoiceOutcome,
  VoiceIdentityResolver,
} from './contracts.js';
import {
  fallbackTargetIdentity,
  TargetIdentitySchema,
  type TargetIdentity,
} from '../../services/target-identity.js';
import {
  clampBulkTargetLimit,
  DEFAULT_BULK_TARGET_LIMIT,
} from '../../domain/parsers.js';
import { isUnauthorized } from '../logging/adapters.js';

const limit = async <T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
) => {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      if (item) await fn(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
};

const identityFor = (userId: string, displayName?: unknown): TargetIdentity => {
  const parsed = TargetIdentitySchema.safeParse({ userId, displayName });
  if (parsed.success) return parsed.data;
  try {
    const fallback = TargetIdentitySchema.safeParse(
      fallbackTargetIdentity(userId),
    );
    if (fallback.success) return fallback.data;
  } catch {
    // Legacy unit callers may use short fixture IDs.
  }
  return { userId, displayName: '不明なユーザー' };
};
const outcomeIdentity = (
  outcomes: readonly VoiceOutcome[],
  userId: string,
): TargetIdentity =>
  outcomes.find((outcome) => outcome.userId === userId)?.identity ??
  identityFor(userId);
class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  public constructor(private readonly size: number) {}
  public async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.size)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await operation();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
const caseIdentity = (
  value: unknown,
): { caseId?: string; caseNumber?: number } => {
  if (!value || typeof value !== 'object') return {};
  const record = value as {
    id?: unknown;
    caseId?: unknown;
    caseNumber?: unknown;
    value?: { id?: unknown; caseId?: unknown; caseNumber?: unknown };
  };
  const source =
    record.value && typeof record.value === 'object' ? record.value : record;
  return {
    ...(typeof source.caseId === 'string'
      ? { caseId: source.caseId }
      : typeof source.id === 'string'
        ? { caseId: source.id }
        : {}),
    ...(typeof source.caseNumber === 'number'
      ? { caseNumber: source.caseNumber }
      : {}),
  };
};

export class VoiceService {
  private readonly sessions = new Map<string, VoiceSession>();
  private readonly expiryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly locks = new Map<string, Promise<void>>();
  /** Configurable bulk-target ceiling (`MAX_BULK_TARGETS`, 1..20). Defaults to
   * the static cap of 20 and is clamped so it can never exceed that ceiling. The
   * service enforces it before any Discord access, mirroring ModerationService so
   * a missing or malformed configuration can never weaken the static ceiling. */
  private readonly maxBulkTargets: number;
  public constructor(
    private readonly port: VoicePort,
    private readonly cases?: VoiceCasePort,
    private readonly now = () => new Date(),
    private readonly identityResolver?: VoiceIdentityResolver,
    maxBulkTargets: number = DEFAULT_BULK_TARGET_LIMIT,
  ) {
    this.maxBulkTargets = clampBulkTargetLimit(maxBulkTargets);
  }
  private resolveIdentity(
    guildId: string,
    userId: string,
    displayName?: unknown,
  ) {
    return this.identityResolver
      ? this.identityResolver.resolve(guildId, userId, {
          member: { displayName },
        })
      : Promise.resolve(identityFor(userId, displayName));
  }
  public member(guildId: string, userId: string): Promise<VoiceMember | null> {
    return this.port.member(guildId, userId);
  }
  /** Best-effort modlog write for a completed case: a Discord authentication
   * failure (401) is fatal and propagates; any other delivery failure is
   * swallowed so it never blocks the voice operation result. */
  private async writeCaseBestEffort(
    guildId: string,
    caseId: string,
  ): Promise<void> {
    try {
      await this.port.writeCase(guildId, caseId);
    } catch (error) {
      if (isUnauthorized(error)) throw error;
      /* non-auth modlog delivery is non-fatal */
    }
  }
  public async voiceKickTargets(
    guildId: string,
    actorId: string,
    ids: readonly string[],
  ): Promise<
    VoiceResult<{
      success: string[];
      failed: string[];
      outcomes: readonly VoiceOutcome[];
    }>
  > {
    const uniqueIds = [...new Set(ids)];
    // Reject an empty batch before any Discord access so a targetless call can
    // never reach the API, mirroring the all-or-nothing over-limit guard below.
    if (uniqueIds.length === 0)
      return err('INVALID_INPUT', '対象を1件以上指定してください');
    // Enforce the injected configured ceiling before any Discord access so an
    // over-limit batch is rejected all-or-nothing without touching the API.
    if (uniqueIds.length > this.maxBulkTargets)
      return err(
        'INVALID_INPUT',
        `対象は最大${String(this.maxBulkTargets)}件です`,
      );
    const resolved = await Promise.all(
      uniqueIds.map(async (id) => ({
        id,
        member: await Promise.resolve(this.port.member(guildId, id)).catch(
          (error: unknown) => {
            // A Discord authentication failure (401, direct or cause-wrapped) is
            // fatal and must propagate; any other lookup failure is absence.
            if (isUnauthorized(error)) throw error;
            return null;
          },
        ),
      })),
    );
    const missing = resolved
      .filter((item) => item.member == null)
      .map((item) => item.id);
    const result = await this.voiceKick(
      guildId,
      actorId,
      resolved.flatMap((item) => (item.member ? [item.member] : [])),
    );
    if (!result.ok) return result;
    const missingOutcomes: VoiceOutcome[] = await Promise.all(
      missing.map(async (userId) => ({
        userId,
        identity: await this.resolveIdentity(guildId, userId),
        ok: false,
        code: 'MEMBER_NOT_FOUND' as const,
      })),
    );
    await Promise.all(
      missing.map(async (targetUserId) => {
        const created = await Promise.resolve(
          this.cases?.create({
            guildId,
            action: 'VOICEKICK',
            targetUserId,
            identity:
              missingOutcomes.find((item) => item.userId === targetUserId)
                ?.identity ?? identityFor(targetUserId),
            moderatorUserId: actorId,
            status: 'FAILED',
            errorCode: 'MEMBER_NOT_FOUND',
          }),
        ).catch(() => undefined);
        const outcome = missingOutcomes.find(
          (item) => item.userId === targetUserId,
        );
        if (outcome) Object.assign(outcome, caseIdentity(created));
      }),
    );
    const allOutcomes = [...result.value.outcomes, ...missingOutcomes];
    await Promise.all(
      missingOutcomes.map((outcome) =>
        outcome.caseId
          ? this.writeCaseBestEffort(guildId, outcome.caseId)
          : Promise.resolve(),
      ),
    );
    return ok({
      success: result.value.success,
      failed: [...missing, ...result.value.failed],
      outcomes: allOutcomes,
    });
  }
  private async locked<T>(
    guildId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.locks.get(guildId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(guildId, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(guildId) === current) this.locks.delete(guildId);
    }
  }
  public async voiceKick(
    guildId: string,
    actorId: string,
    members: readonly VoiceMember[],
  ): Promise<
    VoiceResult<{
      success: string[];
      failed: string[];
      outcomes: readonly VoiceOutcome[];
    }>
  > {
    return this.locked(guildId, async () => {
      const success: string[] = [],
        failed: string[] = [];
      const outcomes: VoiceOutcome[] = [];
      const mover = new Semaphore(5);
      const groups = new Map<string, VoiceMember[]>();
      for (const member of members) {
        if (!member.channelId) {
          failed.push(member.id);
          outcomes.push({
            userId: member.id,
            ok: false,
            code: 'VOICE_NOT_CONNECTED',
          });
          continue;
        }
        const group = groups.get(member.channelId) ?? [];
        group.push(member);
        groups.set(member.channelId, group);
      }
      await limit([...groups.values()], 5, async (group) => {
        const sourceChannel = group[0]?.channelId;
        if (
          sourceChannel &&
          this.port.canKickFromChannel &&
          !(await this.port.canKickFromChannel(guildId, sourceChannel, actorId))
        ) {
          for (const member of group) {
            failed.push(member.id);
            outcomes.push({
              userId: member.id,
              ok: false,
              code: 'BOT_PERMISSION_MISSING',
            });
          }
          return;
        }
        const categoryId = group[0]?.categoryId ?? null;
        if (
          this.port.canCreateTemporaryChannel &&
          !(await this.port.canCreateTemporaryChannel(
            guildId,
            categoryId,
            actorId,
          ))
        ) {
          for (const member of group) {
            failed.push(member.id);
            outcomes.push({
              userId: member.id,
              ok: false,
              code: 'BOT_PERMISSION_MISSING',
            });
          }
          return;
        }
        let temporary: string | undefined;
        let cleanupAuthError: unknown;
        try {
          temporary = await this.port.createTemporaryChannel(
            guildId,
            group[0]?.categoryId ?? null,
          );
          const targetChannel = temporary;
          await limit(group, 5, async (member) => {
            try {
              await mover.run(() =>
                this.port.move(guildId, member.id, targetChannel),
              );
              success.push(member.id);
              outcomes.push({ userId: member.id, ok: true });
            } catch (error) {
              // A 401 is a fatal authentication failure, not a per-target move
              // failure; propagate it instead of recording DISCORD_API_ERROR.
              if (isUnauthorized(error)) throw error;
              failed.push(member.id);
              outcomes.push({
                userId: member.id,
                ok: false,
                code: 'DISCORD_API_ERROR',
              });
            }
          });
        } catch (error) {
          // A 401 from creating the temporary channel (or a propagated move 401)
          // is fatal; abort rather than recording per-target failures.
          if (isUnauthorized(error)) throw error;
          failed.push(
            ...group.filter((m) => !success.includes(m.id)).map((m) => m.id),
          );
          for (const member of group)
            if (
              !success.includes(member.id) &&
              !outcomes.some((outcome) => outcome.userId === member.id)
            )
              outcomes.push({
                userId: member.id,
                ok: false,
                code: 'DISCORD_API_ERROR',
              });
        } finally {
          // Cleanup must not throw inside `finally` (that would mask the try
          // result); capture a fatal 401 and re-raise it after the block.
          if (temporary) {
            try {
              await this.port.deleteChannel(temporary);
            } catch (error) {
              if (isUnauthorized(error)) cleanupAuthError = error;
              else {
                try {
                  await this.port.deleteChannel(temporary);
                } catch (retryError) {
                  if (isUnauthorized(retryError)) cleanupAuthError = retryError;
                  /* best effort */
                }
              }
            }
          }
        }
        if (cleanupAuthError !== undefined) throw cleanupAuthError as Error;
      });
      const identities = new Map<string, TargetIdentity>();
      await Promise.all(
        [...new Set(outcomes.map((outcome) => outcome.userId))].map(
          async (userId) => {
            const member = members.find((item) => item.id === userId);
            const identity = await this.resolveIdentity(
              guildId,
              userId,
              member?.displayName,
            );
            identities.set(userId, identity);
          },
        ),
      );
      for (const outcome of outcomes)
        Object.assign(outcome, { identity: identities.get(outcome.userId) });
      await Promise.all(
        [
          ...success.map((targetUserId) => ({
            targetUserId,
            status: 'COMPLETED' as const,
          })),
          ...failed.map((targetUserId) => ({
            targetUserId,
            status: 'FAILED' as const,
          })),
        ].map(async ({ targetUserId, status }) => {
          try {
            const created = await this.cases?.create({
              guildId,
              action: 'VOICEKICK',
              targetUserId,
              identity: outcomeIdentity(outcomes, targetUserId),
              moderatorUserId: actorId,
              status,
            });
            const outcome = outcomes.find(
              (item) => item.userId === targetUserId,
            );
            if (outcome) Object.assign(outcome, caseIdentity(created));
          } catch {
            /* operation remains successful */
          }
        }),
      );
      await Promise.resolve(
        this.port.log?.(guildId, {
          action: 'VOICEKICK',
          moderatorUserId: actorId,
          success,
          failed,
        }),
      ).catch(() => undefined);
      await Promise.all(
        outcomes.map((outcome) =>
          outcome.caseId
            ? this.writeCaseBestEffort(guildId, outcome.caseId)
            : Promise.resolve(),
        ),
      );
      return ok({ success, failed, outcomes });
    });
  }
  public async start(
    guildId: string,
    actorId: string,
    channelId?: string,
  ): Promise<VoiceResult<VoiceSession>> {
    return this.locked(guildId, async () => {
      const resolvedChannel =
        channelId ?? (await this.port.actorChannel?.(guildId, actorId))?.id;
      if (!resolvedChannel)
        return err(
          'INVALID_INPUT',
          '接続先VCを指定するか、実行者がVCに接続してください',
        );
      if (
        this.port.validateTargetChannel &&
        !(await this.port.validateTargetChannel(guildId, resolvedChannel))
      )
        return err(
          'INVALID_INPUT',
          '接続先は同じギルドのVoiceチャンネルでなければなりません',
        );
      if (
        this.port.canViewChannel &&
        !(await this.port.canViewChannel(guildId, resolvedChannel, actorId))
      )
        return err('BOT_PERMISSION_MISSING', '接続先VCを閲覧できません');
      if (
        this.port.canMoveToChannel &&
        !(await this.port.canMoveToChannel(guildId, resolvedChannel, actorId))
      )
        return err(
          'BOT_PERMISSION_MISSING',
          '接続先VCでConnect/Move Members権限がありません',
        );
      if (this.sessions.has(guildId))
        return err(
          'ALREADY_APPLIED',
          '既存のVoiceMoveセッションを先に停止してください',
        );
      await this.port.connect(guildId, resolvedChannel);
      const startedAt = this.now();
      const session = {
        controllerUserId: actorId,
        botCurrentChannelId: resolvedChannel,
        startedAt,
        expiresAt: new Date(startedAt.getTime() + 21600000),
      };
      this.sessions.set(guildId, session);
      this.expiryTimers.set(
        guildId,
        setTimeout(() => {
          void this.expire();
        }, 21600000),
      );
      return ok(session);
    });
  }
  public async stop(
    guildId: string,
    actorId: string,
    moderator?: boolean,
  ): Promise<VoiceResult<boolean>> {
    const session = this.sessions.get(guildId);
    if (!session) return err('NOT_APPLIED', 'VoiceMoveセッションはありません');
    const allowedModerator =
      moderator ??
      (this.port.isModerator
        ? await this.port.isModerator(guildId, actorId)
        : false);
    if (session.controllerUserId !== actorId && !allowedModerator)
      return err('NOT_AUTHORIZED', 'セッション開始者またはModeratorのみ');
    return this.locked(guildId, async () => {
      await this.port.disconnect(guildId);
      this.sessions.delete(guildId);
      const timer = this.expiryTimers.get(guildId);
      if (timer) clearTimeout(timer);
      this.expiryTimers.delete(guildId);
      return ok(true);
    });
  }
  public status(guildId: string): VoiceResult<VoiceSession | null> {
    const session = this.sessions.get(guildId);
    if (session && session.expiresAt.getTime() <= this.now().getTime()) {
      this.sessions.delete(guildId);
      const timer = this.expiryTimers.get(guildId);
      if (timer) clearTimeout(timer);
      this.expiryTimers.delete(guildId);
      void Promise.resolve(this.port.disconnect(guildId)).catch(
        () => undefined,
      );
      return ok(null);
    }
    return ok(session ?? null);
  }
  public async onBotMoved(
    guildId: string,
    oldChannelId: string,
    newChannelId: string,
  ): Promise<VoiceResult<{ success: number; failed: number }>> {
    return this.locked(guildId, async () => {
      const session = this.sessions.get(guildId);
      if (session && session.expiresAt <= this.now()) {
        this.sessions.delete(guildId);
        const timer = this.expiryTimers.get(guildId);
        if (timer) clearTimeout(timer);
        this.expiryTimers.delete(guildId);
        await Promise.resolve(this.port.disconnect(guildId)).catch(
          () => undefined,
        );
        return ok({ success: 0, failed: 0 });
      }
      if (!session || session.botCurrentChannelId !== oldChannelId)
        return ok({ success: 0, failed: 0 });
      const members = (await this.port.members(oldChannelId)).filter(
        (m) => !m.bot,
      );
      let success = 0;
      let failed = 0;
      const mover = new Semaphore(5);
      await limit(members, 5, async (m) => {
        try {
          await mover.run(() => this.port.move(guildId, m.id, newChannelId));
          success++;
        } catch (error) {
          // A 401 is a fatal authentication failure; propagate it rather than
          // counting it as an ordinary failed move.
          if (isUnauthorized(error)) throw error;
          failed++;
        }
      });
      this.sessions.set(guildId, {
        ...session,
        botCurrentChannelId: newChannelId,
      });
      let dmDelivered = true;
      try {
        await this.port.dm(
          session.controllerUserId,
          `VoiceMove完了: 成功 ${String(success)} / 失敗 ${String(failed)}`,
        );
      } catch (error) {
        // DM delivery is non-fatal, but a 401 is a fatal authentication failure
        // and must propagate.
        if (isUnauthorized(error)) throw error;
        dmDelivered = false;
      }
      await Promise.resolve(
        this.port.log?.(guildId, {
          action: 'VOICEMOVE',
          controllerUserId: session.controllerUserId,
          oldChannelId,
          newChannelId,
          success,
          failed,
          dmDelivered,
        }),
      ).catch(() => undefined);
      return ok({ success, failed });
    });
  }
  public onBotDisconnected(guildId: string): void {
    this.sessions.delete(guildId);
    const timer = this.expiryTimers.get(guildId);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(guildId);
  }
  public async expire(now = this.now()): Promise<void> {
    for (const [guildId, session] of this.sessions)
      if (session.expiresAt <= now) {
        this.sessions.delete(guildId);
        const timer = this.expiryTimers.get(guildId);
        if (timer) clearTimeout(timer);
        this.expiryTimers.delete(guildId);
        await Promise.resolve(this.port.disconnect(guildId)).catch(
          () => undefined,
        );
      }
  }
  public async shutdown(): Promise<void> {
    for (const guildId of [...this.sessions.keys()])
      await Promise.resolve(this.port.disconnect(guildId)).catch(
        () => undefined,
      );
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    this.sessions.clear();
  }
  public async onVoiceState(
    guildId: string,
    userId: string,
    botUserId: string,
    oldChannelId: string | null,
    newChannelId: string | null,
  ): Promise<VoiceResult<{ success: number; failed: number }>> {
    if (userId !== botUserId) return ok({ success: 0, failed: 0 });
    if (!newChannelId) {
      this.onBotDisconnected(guildId);
      return ok({ success: 0, failed: 0 });
    }
    if (!oldChannelId) return ok({ success: 0, failed: 0 });
    return this.onBotMoved(guildId, oldChannelId, newChannelId);
  }
}
