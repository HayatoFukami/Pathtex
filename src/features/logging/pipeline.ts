import type { SnapshotService } from '../../services/snapshot-service.js';
import { isUnauthorized, type LoggingEventAdapter } from './adapters.js';
import type { LogDeliveryService } from './service.js';
import { serverEmbed, type MessageView } from './events.js';
import type {
  JsonValue,
  MemberSnapshotDto,
} from '../../repositories/contracts.js';
import type { Logger } from 'pino';

/** Gateway orchestration keeps ordering here; domain services remain Discord agnostic. */
export interface AutomodPort {
  inspect(message: MessageView, previous?: MessageView): Promise<void>;
}
export interface LoggingPipelinePorts {
  snapshots: Pick<
    SnapshotService,
    | 'saveMessage'
    | 'getMessage'
    | 'deleteMessage'
    | 'saveMember'
    | 'getMembersForUser'
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
    occurredAt: Date,
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
      occurredAt,
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
    messageId: string | undefined,
    occurredAt: Date,
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
    const embed = await this.ports.events.messageDelete(persisted, occurredAt);
    await this.ports.delivery.deliver(guildId, 'message', embed);
    const deletedId = persisted?.messageId ?? messageId;
    if (deletedId) await this.ports.snapshots.deleteMessage(deletedId);
  }
  public async messageDeleteBulk(
    guildId: string,
    channelId: string,
    ids: readonly string[],
    cached: readonly MessageView[],
    occurredAt: Date,
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
      occurredAt,
    );
    await this.ports.delivery.deliver(guildId, 'message', embed);
    await Promise.all(ids.map((id) => this.ports.snapshots.deleteMessage(id)));
  }
  public async server(
    guildId: string,
    title: string,
    fields: ReadonlyArray<{ name: string; value: string }>,
    occurredAt: Date,
    color?: number,
  ): Promise<void> {
    await this.ports.delivery.deliver(
      guildId,
      'server',
      serverEmbed(title, fields, occurredAt, color),
    );
  }
  public async voice(
    guildId: string,
    user: string,
    userId: string,
    oldChannel: string | null,
    newChannel: string | null,
    occurredAt: Date,
  ): Promise<void> {
    const embed = this.ports.events.voice(
      user,
      userId,
      oldChannel,
      newChannel,
      occurredAt,
    );
    if (embed) await this.ports.delivery.deliver(guildId, 'voice', embed);
  }
  public async userUpdate(
    userId: string,
    username: string,
    globalName: string | null,
    occurredAt: Date,
  ): Promise<void> {
    const result = await this.ports.snapshots.getMembersForUser(userId);
    if (!result.ok) return;
    const members = result.value;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < members.length) {
        const member = members[cursor];
        cursor += 1;
        if (member === undefined) continue;
        try {
          await this.applyUserUpdateToMember(
            member,
            username,
            globalName,
            occurredAt,
          );
        } catch (error: unknown) {
          if (isUnauthorized(error)) throw error;
          this.ports.logger?.error(
            {
              event: 'logging.pipeline.user_update_guild_failed',
              guildId: member.guildId,
              userId,
              errorName: error instanceof Error ? error.name : 'unknown',
            },
            'userUpdate fanout failed for guild',
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(5, members.length) }, () => worker()),
    );
  }
  private async applyUserUpdateToMember(
    member: MemberSnapshotDto,
    username: string,
    globalName: string | null,
    occurredAt: Date,
  ): Promise<void> {
    const usernameChanged = member.username !== username;
    const globalNameChanged = (member.globalName ?? null) !== globalName;
    if (!usernameChanged && !globalNameChanged) return;
    const user = `${username} (${member.userId})`;
    if (usernameChanged)
      await this.server(
        member.guildId,
        'ユーザー名変更',
        [
          { name: 'ユーザー', value: user },
          { name: '変更前', value: member.username },
          { name: '変更後', value: username },
        ],
        occurredAt,
        0x3498db,
      );
    if (globalNameChanged)
      await this.server(
        member.guildId,
        'グローバル表示名変更',
        [
          { name: 'ユーザー', value: user },
          { name: '変更前', value: member.globalName ?? 'なし' },
          { name: '変更後', value: globalName ?? 'なし' },
        ],
        occurredAt,
        0x3498db,
      );
    const saved = await this.ports.snapshots.saveMember({
      guildId: member.guildId,
      userId: member.userId,
      username,
      globalName,
      nickname: member.nickname ?? null,
      joinedAt: member.joinedAt ?? null,
    });
    if (!saved.ok)
      throw new Error(`Member snapshot save failed: ${saved.error.code}`);
  }
}
