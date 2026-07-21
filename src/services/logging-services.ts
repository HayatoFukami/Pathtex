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

// ---------------------------------------------------------------
// Japanese render helpers — maps internal enums to display labels
// per docs/40 §8.9.0
// ---------------------------------------------------------------
const ACTION_JA: Record<string, string> = {
  KICK: 'キック',
  BAN: 'BAN',
  SOFTBAN: 'ソフトBAN',
  SILENTBAN: 'サイレントBAN',
  UNBAN: 'BAN解除',
  MUTE: 'ミュート',
  UNMUTE: 'ミュート解除',
  STRIKE: 'ストライク',
  PARDON: 'ストライク取消',
  RAIDMODE_ON: 'レイドモード有効',
  RAIDMODE_OFF: 'レイドモード解除',
  VOICEKICK: 'ボイスキック',
  SLOWMODE: 'スローモード',
  AUTO_PUNISHMENT: '自動制裁',
};
export function translateAction(a: string): string {
  return ACTION_JA[a] ?? a;
}

const SOURCE_JA: Record<string, string> = {
  COMMAND: 'コマンド',
  AUTOMOD: 'AutoMod',
  PUNISHMENT: '自動制裁',
  RAIDMODE: 'レイドモード',
  EXTERNAL: '外部',
  SCHEDULED: '予約実行',
};
function translateSource(s: string): string {
  return SOURCE_JA[s] ?? s;
}

const STATUS_JA: Record<string, string> = {
  PENDING: '保留',
  COMPLETED: '成功',
  FAILED: '失敗',
  PARTIAL: '一部失敗',
};
function translateStatus(s: string): string {
  return STATUS_JA[s] ?? s;
}

const ACTION_COLOR: Record<string, number> = {
  KICK: 0xe67e22,
  MUTE: 0xe67e22,
  STRIKE: 0xe67e22,
  VOICEKICK: 0xe67e22,
  AUTO_PUNISHMENT: 0xe67e22,
  BAN: 0xe74c3c,
  SOFTBAN: 0xe74c3c,
  SILENTBAN: 0xe74c3c,
  RAIDMODE_ON: 0xe74c3c,
  UNBAN: 0x2ecc71,
  UNMUTE: 0x2ecc71,
  PARDON: 0x2ecc71,
  RAIDMODE_OFF: 0x2ecc71,
  SLOWMODE: 0x3498db,
};
const FAILED_COLOR = 0x95a5a6;

function actionColor(action: string, status: string): number | undefined {
  if (status === 'FAILED') return FAILED_COLOR;
  return ACTION_COLOR[action];
}

function translateDm(d: string): string {
  return d === 'true' ? '成功' : d === 'false' ? '失敗' : d;
}

function humanDuration(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}秒`;
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}分`;
  if (seconds < 86400)
    return `${String(Math.floor(seconds / 3600))}時間${seconds % 3600 >= 60 ? `${String(Math.floor((seconds % 3600) / 60))}分` : ''}`;
  return `${String(Math.floor(seconds / 86400))}日`;
}

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
    timestamp: z.string().optional(),
    color: z.number().int().min(0).max(0xffffff).optional(),
    author: z
      .object({
        name: z.string().max(256),
        icon_url: z.string().optional(),
      })
      .optional(),
    footer: z
      .object({
        text: z.string().max(2048),
      })
      .optional(),
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
    if (!this.cases) return { status: 'failed', errorCode: 'DISCORD_ERROR' };
    const result = await this.cases.get(guildId, caseId);
    if (!result.ok || !result.value)
      return { status: 'failed', errorCode: 'DISCORD_ERROR' };
    const current = result.value;
    const metadata =
      current.metadata &&
      typeof current.metadata === 'object' &&
      !Array.isArray(current.metadata)
        ? (current.metadata as Record<string, unknown>)
        : {};
    const fields: Array<{ name: string; value: string; inline?: boolean }> = [
      { name: '対象', value: renderCaseTarget(current), inline: true },
      { name: '実行者', value: current.moderatorUserId, inline: true },
      {
        name: '理由',
        value: current.reason ?? '理由未指定',
        inline: false,
      },
      {
        name: '期間',
        value:
          current.durationSeconds === null ||
          current.durationSeconds === undefined
            ? '永続'
            : humanDuration(current.durationSeconds),
        inline: true,
      },
      { name: '発生元', value: translateSource(current.source), inline: true },
      { name: '状態', value: translateStatus(current.status), inline: true },
    ];
    fields.push({
      name: 'DM',
      value:
        'dmDelivered' in metadata
          ? translateDm(String(metadata.dmDelivered))
          : '対象外',
      inline: true,
    });
    if ('errorCode' in metadata || current.errorCode) {
      const errorValue = metadata.errorCode ?? current.errorCode;
      fields.push({
        name: 'エラー',
        value: typeof errorValue === 'string' ? errorValue : 'unknown',
        inline: true,
      });
    }
    return this.send(
      guildId,
      'moderation',
      {
        type: `case:${current.action}`,
        guildId,
        occurredAt: current.createdAt,
        timezone: 'UTC',
        embed: {
          title: `ケース #${String(current.caseNumber)} — ${translateAction(current.action)}`,
          timestamp: current.createdAt.toISOString(),
          color: actionColor(current.action, current.status),
          footer: { text: current.id },
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
