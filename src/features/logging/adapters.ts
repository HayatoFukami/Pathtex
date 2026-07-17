import type { LogEmbed } from './service.js';
import {
  messageEditEmbed,
  messageDeleteEmbed,
  bulkDeleteEmbed,
  voiceEmbed,
  type MessageView,
} from './events.js';

export interface AuditPort {
  findMessageDelete(
    guildId: string,
    channelId: string,
    messageIds: readonly string[],
    authorId?: string,
  ): Promise<{ executor: string; reason: string } | null>;
}
export interface MessageDeleteCorrelation {
  peek?(
    guildId: string,
    messageId: string,
  ): { executor: string; reason: string } | null;
  consume(
    guildId: string,
    messageId: string,
  ): { executor: string; reason: string } | null;
}
export function classifyVoice(
  oldChannel: string | null,
  newChannel: string | null,
): 'Join' | 'Leave' | 'Move' | null {
  if (!oldChannel && newChannel) return 'Join';
  if (oldChannel && !newChannel) return 'Leave';
  if (oldChannel && newChannel && oldChannel !== newChannel) return 'Move';
  return null;
}
export class LoggingEventAdapter {
  public constructor(
    private readonly audit: AuditPort,
    private readonly wait: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly correlation?: MessageDeleteCorrelation,
  ) {}
  public async messageDelete(
    message: MessageView | null,
    zone: string,
    now = new Date(),
  ): Promise<LogEmbed> {
    const internal =
      message && this.correlation?.consume(message.guildId, message.messageId);
    if (internal)
      return messageDeleteEmbed(
        message,
        now,
        zone,
        internal.executor,
        internal.reason,
      );
    await this.wait(2000);
    const audit = message
      ? await this.audit.findMessageDelete(
          message.guildId,
          message.channelId,
          [message.messageId],
          message.authorId,
        )
      : null;
    return messageDeleteEmbed(
      message,
      now,
      zone,
      audit?.executor,
      audit?.reason,
    );
  }
  public messageEdit(
    before: MessageView | null,
    after: MessageView,
    zone: string,
  ): LogEmbed | null {
    return messageEditEmbed(before, after, zone);
  }
  public async bulkDelete(
    guildId: string,
    channelId: string,
    ids: readonly string[],
    cached: readonly MessageView[],
    zone: string,
    now = new Date(),
  ): Promise<LogEmbed> {
    const peeked = this.correlation
      ? ids.map((id) => this.correlation?.peek?.(guildId, id) ?? null)
      : [];
    if (
      peeked.length === ids.length &&
      peeked.every((value) => value !== null)
    ) {
      const internal = ids.map((id) => this.correlation?.consume(guildId, id));
      return bulkDeleteEmbed(
        channelId,
        ids.length,
        cached,
        now,
        zone,
        internal[0]?.executor,
        internal[0]?.reason,
      );
    }
    await this.wait(2000);
    const audit = await this.audit.findMessageDelete(guildId, channelId, ids);
    return bulkDeleteEmbed(
      channelId,
      ids.length,
      cached,
      now,
      zone,
      audit?.executor,
      audit?.reason,
    );
  }
  public voice(
    user: string,
    userId: string,
    oldChannel: string | null,
    newChannel: string | null,
    zone: string,
    now = new Date(),
  ): LogEmbed | null {
    const kind = classifyVoice(oldChannel, newChannel);
    return kind
      ? voiceEmbed(user, userId, kind, oldChannel, newChannel, now, zone)
      : null;
  }
}
