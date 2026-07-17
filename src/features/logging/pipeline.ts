import type { SnapshotService } from '../../services/snapshot-service.js';
import type { LoggingEventAdapter } from './adapters.js';
import type { LogDeliveryService } from './service.js';
import { serverEmbed, type MessageView } from './events.js';
import type { JsonValue } from '../../repositories/contracts.js';
import type { Logger } from 'pino';

/** Gateway orchestration keeps ordering here; domain services remain Discord agnostic. */
export interface AutomodPort {
  inspect(message: MessageView, previous?: MessageView): Promise<void>;
}
export interface LoggingPipelinePorts {
  snapshots: Pick<
    SnapshotService,
    'saveMessage' | 'getMessage' | 'deleteMessage'
  >;
  automod?: AutomodPort;
  events: LoggingEventAdapter;
  delivery: LogDeliveryService;
  timezone(guildId: string): Promise<string>;
  logger?: Logger;
}
export class LoggingEventPipeline {
  public constructor(private readonly ports: LoggingPipelinePorts) {}
  private failure(event: string, error: unknown, message: MessageView): void {
    this.ports.logger?.error(
      {
        event,
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.authorId,
        errorName: error instanceof Error ? error.name : 'unknown',
      },
      'Logging pipeline stage failed',
    );
  }
  public async messageCreate(message: MessageView): Promise<void> {
    await this.ports.snapshots.saveMessage({
      messageId: message.messageId,
      guildId: message.guildId,
      channelId: message.channelId,
      authorUserId: message.authorId,
      authorDisplay: message.author,
      content: message.content.slice(0, 4000),
      attachments: [
        ...(message.attachments ?? []).slice(0, 25),
      ] as unknown as JsonValue,
      embedsSummary: [
        ...(message.embeds ?? []).slice(0, 10),
      ] as unknown as JsonValue,
      expiresAt: new Date(Date.now() + 604800000),
    });
    if (this.ports.automod) {
      try {
        await this.ports.automod.inspect(message);
      } catch (error: unknown) {
        this.failure('logging.pipeline.automod_create_failed', error, message);
      }
    }
  }
  public async messageUpdate(
    before: MessageView | null,
    after: MessageView,
  ): Promise<void> {
    const old = await this.ports.snapshots.getMessage(
      before?.messageId ?? after.messageId,
    );
    const persistedBefore =
      old.ok && old.value
        ? {
            guildId: old.value.guildId,
            channelId: old.value.channelId,
            messageId: old.value.messageId,
            author: old.value.authorDisplay,
            authorId: old.value.authorUserId,
            content: old.value.content,
            attachments: Array.isArray(old.value.attachments)
              ? (old.value.attachments as (string | Record<string, unknown>)[])
              : [],
            embeds: Array.isArray(old.value.embedsSummary)
              ? (old.value.embedsSummary as (
                  string | Record<string, unknown>
                )[])
              : [],
            createdAt: old.value.createdAt,
          }
        : before;
    if (this.ports.automod) {
      try {
        await this.ports.automod.inspect(
          { ...after, isEdit: true },
          persistedBefore ?? undefined,
        );
      } catch (error: unknown) {
        this.failure('logging.pipeline.automod_update_failed', error, after);
      }
    }
    const embed = this.ports.events.messageEdit(
      persistedBefore,
      after,
      await this.ports.timezone(after.guildId),
    );
    if (embed)
      await this.ports.delivery.deliver(after.guildId, 'message', embed);
    await this.ports.snapshots.saveMessage({
      messageId: after.messageId,
      guildId: after.guildId,
      channelId: after.channelId,
      authorUserId: after.authorId,
      authorDisplay: after.author,
      content: after.content.slice(0, 4000),
      attachments: [
        ...(after.attachments ?? []).slice(0, 25),
      ] as unknown as JsonValue,
      embedsSummary: [
        ...(after.embeds ?? []).slice(0, 10),
      ] as unknown as JsonValue,
      editedAt: new Date(),
      expiresAt: new Date(Date.now() + 604800000),
    });
  }
  public async messageDelete(
    message: MessageView | null,
    guildId: string,
    messageId?: string,
  ): Promise<void> {
    let persisted = message;
    if (!persisted && messageId) {
      const snapshot = await this.ports.snapshots.getMessage(messageId);
      if (snapshot.ok && snapshot.value)
        persisted = {
          guildId: snapshot.value.guildId,
          channelId: snapshot.value.channelId,
          messageId: snapshot.value.messageId,
          author: snapshot.value.authorDisplay,
          authorId: snapshot.value.authorUserId,
          content: snapshot.value.content,
          attachments: Array.isArray(snapshot.value.attachments)
            ? (snapshot.value.attachments as (
                string | Record<string, unknown>
              )[])
            : [],
          embeds: Array.isArray(snapshot.value.embedsSummary)
            ? (snapshot.value.embedsSummary as (
                string | Record<string, unknown>
              )[])
            : [],
          createdAt: snapshot.value.createdAt,
        };
    }
    const embed = await this.ports.events.messageDelete(
      persisted,
      await this.ports.timezone(guildId),
    );
    await this.ports.delivery.deliver(guildId, 'message', embed);
    const deletedId = persisted?.messageId ?? messageId;
    if (deletedId) await this.ports.snapshots.deleteMessage(deletedId);
  }
  public async messageDeleteBulk(
    guildId: string,
    channelId: string,
    ids: readonly string[],
    cached: readonly MessageView[],
  ): Promise<void> {
    const known = new Map(
      cached.map((message) => [message.messageId, message]),
    );
    await Promise.all(
      ids.map(async (id) => {
        if (known.has(id)) return;
        const result = await this.ports.snapshots.getMessage(id);
        if (result.ok && result.value)
          known.set(id, {
            guildId: result.value.guildId,
            channelId: result.value.channelId,
            messageId: result.value.messageId,
            author: result.value.authorDisplay,
            authorId: result.value.authorUserId,
            content: result.value.content,
            attachments: Array.isArray(result.value.attachments)
              ? (result.value.attachments as (
                  string | Record<string, unknown>
                )[])
              : [],
            embeds: Array.isArray(result.value.embedsSummary)
              ? (result.value.embedsSummary as (
                  string | Record<string, unknown>
                )[])
              : [],
            createdAt: result.value.createdAt,
          });
      }),
    );
    const merged = ids
      .map((id) => known.get(id))
      .filter((message): message is MessageView => message !== undefined);
    const embed = await this.ports.events.bulkDelete(
      guildId,
      channelId,
      ids,
      merged,
      await this.ports.timezone(guildId),
    );
    await this.ports.delivery.deliver(guildId, 'message', embed);
    await Promise.all(ids.map((id) => this.ports.snapshots.deleteMessage(id)));
  }
  public async server(
    guildId: string,
    title: string,
    fields: ReadonlyArray<{ name: string; value: string }>,
    date = new Date(),
  ): Promise<void> {
    await this.ports.delivery.deliver(
      guildId,
      'server',
      serverEmbed(title, fields, date, await this.ports.timezone(guildId)),
    );
  }
  public async voice(
    guildId: string,
    user: string,
    userId: string,
    oldChannel: string | null,
    newChannel: string | null,
    date = new Date(),
  ): Promise<void> {
    const embed = this.ports.events.voice(
      user,
      userId,
      oldChannel,
      newChannel,
      await this.ports.timezone(guildId),
      date,
    );
    if (embed) await this.ports.delivery.deliver(guildId, 'voice', embed);
  }
}
