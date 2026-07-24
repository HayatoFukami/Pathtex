import type { SnapshotService } from '../../services/snapshot-service.js';
import { isUnauthorized, type LoggingEventAdapter } from './adapters.js';
import type { LogDeliveryService } from './service.js';
import { serverEmbed, type MessageView } from './events.js';
import type {
  JsonValue,
  MemberSnapshotDto,
  SnapshotDto,
} from '../../repositories/contracts.js';
import type { Logger } from 'pino';

/** Default message-snapshot retention (spec `01-platform-and-data.md §4.17`:
 * Message Snapshot 既定7日). The pipeline writes `expiresAt = now + retention`
 * and the retention purge later removes rows past their `expiresAt`. */
export const DEFAULT_MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Gateway orchestration keeps ordering here; domain services remain Discord agnostic. */
export interface AutomodPort {
  inspect(message: MessageView, previous?: MessageView): Promise<void>;
}
export interface LoggingPipelinePorts {
  snapshots: Pick<
    SnapshotService,
    | 'saveMessage'
    | 'getMessage'
    | 'getMessages'
    | 'deleteMessage'
    | 'deleteMessages'
    | 'saveMember'
    | 'getMembersForUser'
  >;
  automod?: AutomodPort;
  events: LoggingEventAdapter;
  delivery: LogDeliveryService;
  timezone(guildId: string): Promise<string>;
  /** Configurable message-snapshot retention in milliseconds. Defaults to
   * `DEFAULT_MESSAGE_RETENTION_MS` (7 days) when not supplied. */
  messageRetentionMs?: number;
  logger?: Logger;
}
export class LoggingEventPipeline {
  private readonly messageRetentionMs: number;
  public constructor(private readonly ports: LoggingPipelinePorts) {
    this.messageRetentionMs =
      ports.messageRetentionMs ?? DEFAULT_MESSAGE_RETENTION_MS;
  }
  private snapshotExpiry(from = Date.now()): Date {
    return new Date(from + this.messageRetentionMs);
  }
  /** Maps a persisted snapshot back to the gateway-agnostic `MessageView`. */
  private static toMessageView(snapshot: SnapshotDto): MessageView {
    return {
      guildId: snapshot.guildId,
      channelId: snapshot.channelId,
      messageId: snapshot.messageId,
      author: snapshot.authorDisplay,
      authorId: snapshot.authorUserId,
      content: snapshot.content,
      attachments: Array.isArray(snapshot.attachments)
        ? (snapshot.attachments as (string | Record<string, unknown>)[])
        : [],
      embeds: Array.isArray(snapshot.embedsSummary)
        ? (snapshot.embedsSummary as (string | Record<string, unknown>)[])
        : [],
      createdAt: snapshot.createdAt,
    };
  }
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
      expiresAt: this.snapshotExpiry(),
    });
    if (this.ports.automod) {
      try {
        await this.ports.automod.inspect(message);
      } catch (error: unknown) {
        if (isUnauthorized(error)) throw error;
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
        ? LoggingEventPipeline.toMessageView(old.value)
        : before;
    if (this.ports.automod) {
      try {
        await this.ports.automod.inspect(
          { ...after, isEdit: true },
          persistedBefore ?? undefined,
        );
      } catch (error: unknown) {
        if (isUnauthorized(error)) throw error;
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
      // Preserve the original creation time: carry forward the persisted
      // snapshot's `createdAt` when one exists, otherwise fall back to the
      // gateway message's own creation time. The edit must never reset the
      // snapshot's creation time to the edit time.
      createdAt: old.ok && old.value ? old.value.createdAt : after.createdAt,
      editedAt: new Date(),
      expiresAt: this.snapshotExpiry(),
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
        persisted = LoggingEventPipeline.toMessageView(snapshot.value);
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
    // Bulk-load every snapshot the gateway cache does not already hold in a
    // single query instead of one `getMessage` per id.
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length > 0) {
      const result = await this.ports.snapshots.getMessages(missing);
      if (result.ok)
        for (const snapshot of result.value)
          known.set(
            snapshot.messageId,
            LoggingEventPipeline.toMessageView(snapshot),
          );
    }
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
    // Bulk-delete every snapshot in a single query instead of one delete per id.
    if (ids.length > 0) await this.ports.snapshots.deleteMessages([...ids]);
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
