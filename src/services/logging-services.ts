import { DateTime } from 'luxon';
import { z } from 'zod';
import { withDiscordRetry } from '../adapters/discord-retry.js';
import type { CaseService } from './case-service.js';
import {
  formatTargetIdentity,
  fallbackTargetIdentity,
  normalizeTargetDisplay,
  isUserTargetAction,
} from './target-identity.js';
import type { CaseDto } from '../repositories/contracts.js';

export const LogEventSchema = z.object({
  type: z.string().min(1).max(64),
  guildId: z.string().regex(/^\d{17,20}$/u),
  occurredAt: z.date(),
  timezone: z
    .string()
    .refine(
      (zone) => DateTime.now().setZone(zone).isValid,
      'Invalid IANA timezone',
    ),
  embed: z.object({
    title: z.string().max(256),
    description: z.string().max(4096).optional(),
    fields: z
      .array(
        z.object({
          name: z.string().max(256),
          value: z.string().max(1024),
          inline: z.boolean().optional(),
        }),
      )
      .max(25),
  }),
});
export type LogEvent = z.infer<typeof LogEventSchema>;
export interface DiscordLogPort {
  send(channelId: string, event: LogEvent): Promise<void>;
}
export interface LogResult {
  readonly status: 'delivered' | 'skipped' | 'failed';
  readonly errorCode?: 'NOT_CONFIGURED' | 'DISCORD_ERROR';
}
export interface LogSettings {
  getChannel(guildId: string, kind: string): Promise<string | null>;
  clearChannel(guildId: string, kind: string): Promise<void>;
}
export interface GuildTimezonePort {
  getTimezone(guildId: string): Promise<string>;
}

export function renderCaseTarget(caseDto: CaseDto): string {
  if (!isUserTargetAction(caseDto.action) || !caseDto.targetUserId)
    return caseDto.targetDisplay;
  const displayName = normalizeTargetDisplay(caseDto.targetDisplay);
  return formatTargetIdentity(
    displayName
      ? { userId: caseDto.targetUserId, displayName }
      : fallbackTargetIdentity(caseDto.targetUserId),
  );
}

abstract class IsolatedLogService {
  public constructor(
    protected readonly sender: DiscordLogPort,
    private readonly settings?: LogSettings,
    protected readonly cases?: CaseService,
  ) {}
  protected async send(
    guildId: string,
    kind: string,
    event: unknown,
    caseId?: string,
  ): Promise<LogResult> {
    const parsed = LogEventSchema.safeParse(event);
    if (!parsed.success)
      return { status: 'failed', errorCode: 'DISCORD_ERROR' };
    if (parsed.data.guildId !== guildId)
      return { status: 'failed', errorCode: 'DISCORD_ERROR' };
    let channelId: string | null = null;
    try {
      channelId = (await this.settings?.getChannel(guildId, kind)) ?? null;
    } catch {
      return { status: 'failed', errorCode: 'DISCORD_ERROR' };
    }
    if (!channelId) return { status: 'skipped', errorCode: 'NOT_CONFIGURED' };
    try {
      await withDiscordRetry(() => this.sender.send(channelId, parsed.data));
      return { status: 'delivered' };
    } catch (error: unknown) {
      const source =
        error instanceof Error && 'cause' in error
          ? (error as Error & { cause?: unknown }).cause
          : error;
      const status =
        typeof source === 'object' && source !== null && 'status' in source
          ? (source as { status?: number }).status
          : undefined;
      if (status === 401) throw error;
      try {
        if (status === 404) await this.settings?.clearChannel(guildId, kind);
      } catch {
        /* logging is non-fatal */
      }
      try {
        if (caseId)
          await this.cases?.updateMetadata(guildId, caseId, {
            logDeliveryFailed: true,
            errorCode: 'DISCORD_ERROR',
          });
      } catch {
        /* logging is non-fatal */
      }
      return { status: 'failed', errorCode: 'DISCORD_ERROR' };
    }
  }
}
export class MessageLogService extends IsolatedLogService {
  public write(guildId: string, event: unknown): Promise<LogResult> {
    return this.send(guildId, 'message', event);
  }
}
export class ModerationLogService extends IsolatedLogService {
  public constructor(
    sender: DiscordLogPort,
    settings?: LogSettings,
    cases?: CaseService,
    private readonly timezone?: GuildTimezonePort,
  ) {
    super(sender, settings, cases);
  }
  public write(
    guildId: string,
    event: unknown,
    caseId?: string,
  ): Promise<LogResult> {
    return this.send(guildId, 'moderation', event, caseId);
  }
  public async writeCase(guildId: string, caseId: string): Promise<LogResult> {
    if (!this.cases || !this.timezone)
      return { status: 'failed', errorCode: 'DISCORD_ERROR' };
    const result = await this.cases.get(guildId, caseId);
    if (!result.ok || !result.value)
      return { status: 'failed', errorCode: 'DISCORD_ERROR' };
    const current = result.value;
    const timezone = await this.timezone.getTimezone(guildId);
    const localTime = DateTime.fromJSDate(current.createdAt)
      .setZone(timezone)
      .toFormat('yyyy-LL-dd HH:mm:ss ZZZZ');
    const metadata =
      current.metadata &&
      typeof current.metadata === 'object' &&
      !Array.isArray(current.metadata)
        ? (current.metadata as Record<string, unknown>)
        : {};
    const fields = [
      { name: 'Action', value: current.action },
      { name: 'Source', value: current.source },
      { name: 'Status', value: current.status },
      { name: 'Target', value: renderCaseTarget(current) },
      { name: 'Reason', value: current.reason ?? '理由未指定' },
      {
        name: 'Duration',
        value:
          current.durationSeconds === null ||
          current.durationSeconds === undefined
            ? 'Permanent'
            : `${String(current.durationSeconds)}秒`,
      },
      { name: 'Moderator', value: current.moderatorUserId },
      { name: 'Timestamp', value: localTime },
    ];
    fields.push({
      name: 'DM',
      value:
        'dmDelivered' in metadata ? String(metadata.dmDelivered) : '対象外',
    });
    if ('errorCode' in metadata || current.errorCode) {
      const errorValue = metadata.errorCode ?? current.errorCode;
      fields.push({
        name: 'Error',
        value: typeof errorValue === 'string' ? errorValue : 'unknown',
      });
    }
    return this.send(
      guildId,
      'moderation',
      {
        type: `case:${current.action}`,
        guildId,
        occurredAt: current.createdAt,
        timezone,
        embed: {
          title: `ケース #${String(current.caseNumber)}: ${current.action}`,
          description: `発生時刻: ${localTime}`,
          fields,
        },
      },
      caseId,
    );
  }
}
export class ServerLogService extends IsolatedLogService {
  public write(guildId: string, event: unknown): Promise<LogResult> {
    return this.send(guildId, 'server', event);
  }
}
export class VoiceLogService extends IsolatedLogService {
  public write(guildId: string, event: unknown): Promise<LogResult> {
    return this.send(guildId, 'voice', event);
  }
}
