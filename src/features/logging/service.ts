import { DateTime, IANAZone } from 'luxon';
import { z } from 'zod';
import { withDiscordRetry } from '../../adapters/discord-retry.js';
import type { CaseService } from '../../services/case-service.js';
import type {
  ConfigurationService,
  LogKind,
} from '../configuration/service.js';

export const LogEmbedSchema = z.object({
  title: z.string().max(256),
  fields: z
    .array(
      z.object({
        name: z.string().max(256),
        value: z.string().max(1024),
        inline: z.boolean().optional(),
      }),
    )
    .max(25),
  timestamp: z.string().optional(),
});
export type LogEmbed = z.infer<typeof LogEmbedSchema>;
export function normalizeEmbed(embed: LogEmbed): LogEmbed {
  return {
    ...embed,
    title: truncate(embed.title, 256),
    fields: embed.fields.slice(0, 25).map((field) => ({
      ...field,
      name: truncate(field.name, 256),
      value: truncate(field.value, 1024),
    })),
  };
}
export interface LogSender {
  send(channelId: string, embed: LogEmbed): Promise<void>;
}
export interface LogConfiguration {
  getChannel(guildId: string, kind: string): Promise<string | null>;
  clearChannel(guildId: string, kind: string): Promise<void>;
}
export class SettingsLogConfiguration implements LogConfiguration {
  public constructor(private readonly configuration: ConfigurationService) {}
  public async getChannel(
    guildId: string,
    kind: string,
  ): Promise<string | null> {
    const settings = await this.configuration.getWithTimezoneRepair(guildId);
    if (!settings.ok) return null;
    const field: Record<LogKind, keyof typeof settings.value> = {
      message: 'messageLogChannelId',
      moderation: 'modlogChannelId',
      server: 'serverLogChannelId',
      voice: 'voiceLogChannelId',
    };
    if (
      kind !== 'message' &&
      kind !== 'moderation' &&
      kind !== 'server' &&
      kind !== 'voice'
    )
      return null;
    const key = field[kind];
    return (settings.value[key] as string | null | undefined) ?? null;
  }
  public async clearChannel(guildId: string, kind: string): Promise<void> {
    if (
      kind === 'message' ||
      kind === 'moderation' ||
      kind === 'server' ||
      kind === 'voice'
    )
      await this.configuration.disableLog(guildId, kind);
  }
}
export interface DeliveryResult {
  status: 'delivered' | 'skipped' | 'failed';
  errorCode?: string;
  warning?: string;
}

export class LogDeliveryService {
  public constructor(
    private readonly sender: LogSender,
    private readonly config: LogConfiguration,
    private readonly cases?: Pick<CaseService, 'updateMetadata'>,
  ) {}
  public async deliver(
    guildId: string,
    kind: string,
    input: unknown,
    caseId?: string,
  ): Promise<DeliveryResult> {
    const parsed = LogEmbedSchema.safeParse(input);
    const embed = parsed.success
      ? { success: true as const, data: normalizeEmbed(parsed.data) }
      : parsed;
    if (!embed.success) return { status: 'failed', errorCode: 'INVALID_INPUT' };
    let channel: string | null;
    try {
      channel = await this.config.getChannel(guildId, kind);
    } catch {
      return { status: 'failed', errorCode: 'CONFIGURATION_ERROR' };
    }
    if (!channel) return { status: 'skipped', errorCode: 'NOT_CONFIGURED' };
    try {
      await withDiscordRetry(() => this.sender.send(channel, embed.data));
      return { status: 'delivered' };
    } catch (error: unknown) {
      const status =
        error && typeof error === 'object' && 'status' in error
          ? (error as { status?: number }).status
          : undefined;
      if (status === 401) throw error;
      if (status === 404) {
        try {
          await this.config.clearChannel(guildId, kind);
        } catch {
          /* non-fatal */
        }
      }
      if (caseId) {
        try {
          await this.cases?.updateMetadata(guildId, caseId, {
            logDeliveryFailed: true,
            errorCode: 'DISCORD_ERROR',
          });
        } catch {
          /* non-fatal */
        }
      }
      return {
        status: 'failed',
        errorCode: 'DISCORD_ERROR',
        warning: '操作は成功しましたがログ送信に失敗しました',
      };
    }
  }
}

export function timestamp(date: Date, zone: string): string {
  const actual = IANAZone.isValidZone(zone) ? zone : 'UTC';
  return `${DateTime.fromJSDate(date, { zone: actual }).toFormat('yyyy-MM-dd HH:mm:ss ZZZZ')} (<t:${String(Math.floor(date.getTime() / 1000))}:F>)`;
}
export function truncate(value: string, length = 1000): string {
  return value.length <= length
    ? value
    : `${value.slice(0, Math.max(0, length - 1))}…`;
}
