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
    authorId: string | undefined,
    occurredAt: Date,
  ): Promise<{ executor: string; reason: string } | null>;
}
function hasUnauthorizedMarker(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const status =
    'status' in value ? (value as { status?: unknown }).status : undefined;
  const code = 'code' in value ? (value as { code?: unknown }).code : undefined;
  return status === 401 || code === 401;
}
export function isUnauthorized(error: unknown): boolean {
  if (hasUnauthorizedMarker(error)) return true;
  if (typeof error === 'object' && error !== null && 'cause' in error)
    return hasUnauthorizedMarker((error as { cause?: unknown }).cause);
  return false;
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
  private async lookupAudit(
    guildId: string,
    channelId: string,
    messageIds: readonly string[],
    authorId: string | undefined,
    occurredAt: Date,
  ): Promise<{ executor: string; reason: string } | null> {
    try {
      return await this.audit.findMessageDelete(
        guildId,
        channelId,
        messageIds,
        authorId,
        occurredAt,
      );
    } catch (error: unknown) {
      if (isUnauthorized(error)) throw error;
      return null;
    }
  }
  public async messageDelete(
    message: MessageView | null,
    occurredAt: Date,
  ): Promise<LogEmbed> {
    const internal =
      message && this.correlation?.consume(message.guildId, message.messageId);
    if (internal)
      return messageDeleteEmbed(
        message,
        internal.executor,
        internal.reason,
        occurredAt,
      );
    await this.wait(2000);
    const audit = message
      ? await this.lookupAudit(
          message.guildId,
          message.channelId,
          [message.messageId],
          message.authorId,
          occurredAt,
        )
      : null;
    return messageDeleteEmbed(
      message,
      audit?.executor,
      audit?.reason,
      occurredAt,
    );
  }
  public messageEdit(
    before: MessageView | null,
    after: MessageView,
    occurredAt: Date,
  ): LogEmbed | null {
    return messageEditEmbed(before, after, occurredAt);
  }
  public async bulkDelete(
    guildId: string,
    channelId: string,
    ids: readonly string[],
    cached: readonly MessageView[],
    occurredAt: Date,
  ): Promise<LogEmbed> {
    const peeked = this.correlation
      ? ids.map((id) => this.correlation?.peek?.(guildId, id) ?? null)
      : [];
    if (
      peeked.length === ids.length &&
      peeked.every((value) => value !== null)
    ) {
      ids.map((id) => this.correlation?.consume(guildId, id));
      return bulkDeleteEmbed(
        channelId,
        ids.length,
        cached,
        peeked[0]?.executor,
        occurredAt,
        peeked[0]?.reason,
      );
    }
    await this.wait(2000);
    const audit = await this.lookupAudit(
      guildId,
      channelId,
      ids,
      undefined,
      occurredAt,
    );
    return bulkDeleteEmbed(
      channelId,
      ids.length,
      cached,
      audit?.executor,
      occurredAt,
      audit?.reason,
    );
  }
  public voice(
    user: string,
    userId: string,
    oldChannel: string | null,
    newChannel: string | null,
    occurredAt: Date,
  ): LogEmbed | null {
    const kind = classifyVoice(oldChannel, newChannel);
    return kind
      ? voiceEmbed(user, userId, kind, oldChannel, newChannel, occurredAt)
      : null;
  }
}
