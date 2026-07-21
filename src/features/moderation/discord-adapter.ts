import type { Client } from 'discord.js';
import type {
  MemberSnapshot,
  ModerationDiscordPort,
  ModerationMessage,
  ModerationTarget,
} from './contracts.js';

export class DiscordModerationAdapter implements ModerationDiscordPort {
  private readonly roleLocks = new Map<string, Promise<void>>();
  public constructor(private readonly getClient: () => Client | undefined) {}
  private client(): Client {
    const client = this.getClient();
    if (!client) throw new Error('Discord client is not ready');
    return client;
  }
  private rethrowFatal(error: unknown): void {
    const status =
      typeof error === 'object' && error !== null && 'status' in error
        ? (error as { status?: unknown }).status
        : undefined;
    const code = (error as { code?: unknown }).code;
    if (status === 404 || code === 10007 || code === 10013) return;
    throw error;
  }
  public async getUser(
    guildId: string,
    userId: string,
  ): Promise<ModerationTarget | null> {
    try {
      const user = await this.client().users.fetch(userId);
      return {
        id: user.id,
        display: user.tag,
        globalName: user.globalName,
        username: user.username,
      };
    } catch (error: unknown) {
      this.rethrowFatal(error);
      return null;
    }
  }
  public async getMember(
    guildId: string,
    userId: string,
  ): Promise<MemberSnapshot | null> {
    try {
      const guild = await this.client().guilds.fetch(guildId);
      const member = await guild.members.fetch(userId);
      return {
        id: member.id,
        displayName: member.displayName,
        isOwner: member.id === guild.ownerId,
        isBot: member.user.bot,
        rolePosition: member.roles.highest.position,
        isMember: true,
      };
    } catch (error: unknown) {
      this.rethrowFatal(error);
      return null;
    }
  }
  public async getBotRolePosition(guildId: string): Promise<number> {
    const guild = await this.client().guilds.fetch(guildId);
    return guild.members.me?.roles.highest.position ?? -1;
  }
  public getBotUserId(guildId: string): Promise<string> {
    void guildId;
    return Promise.resolve(this.client().user?.id ?? '');
  }
  public async getActorRolePosition(
    guildId: string,
    userId: string,
  ): Promise<number> {
    const guild = await this.client().guilds.fetch(guildId);
    return (await guild.members.fetch(userId)).roles.highest.position;
  }
  public async getActorIsOwner(
    guildId: string,
    userId: string,
  ): Promise<boolean> {
    const guild = await this.client().guilds.fetch(guildId);
    return guild.ownerId === userId;
  }
  public async kick(
    guildId: string,
    userId: string,
    auditReason: string,
  ): Promise<void> {
    await (
      await this.client().guilds.fetch(guildId)
    ).members.kick(userId, auditReason);
  }
  public async ban(
    guildId: string,
    userId: string,
    deleteMessageSeconds: number,
    auditReason: string,
  ): Promise<void> {
    await (
      await this.client().guilds.fetch(guildId)
    ).bans.create(userId, { deleteMessageSeconds, reason: auditReason });
  }
  public async unban(
    guildId: string,
    userId: string,
    auditReason: string,
  ): Promise<void> {
    await (
      await this.client().guilds.fetch(guildId)
    ).bans.remove(userId, auditReason);
  }
  public async isBanned(guildId: string, userId: string): Promise<boolean> {
    try {
      await (await this.client().guilds.fetch(guildId)).bans.fetch(userId);
      return true;
    } catch (error: unknown) {
      this.rethrowFatal(error);
      return false;
    }
  }
  public async hasRole(
    guildId: string,
    userId: string,
    roleId: string,
  ): Promise<boolean> {
    try {
      const guild = await this.client().guilds.fetch(guildId);
      const member = await guild.members.fetch(userId);
      return member.roles.cache.has(roleId);
    } catch (error: unknown) {
      this.rethrowFatal(error);
      return false;
    }
  }
  public async addRole(
    guildId: string,
    userId: string,
    roleId: string,
    auditReason: string,
  ): Promise<void> {
    await this.withRoleMutationLock(guildId, userId, () =>
      this.addRoleUnlocked(guildId, userId, roleId, auditReason),
    );
  }
  /** Caller must already hold withRoleMutationLock. */
  public async addRoleUnlocked(
    guildId: string,
    userId: string,
    roleId: string,
    auditReason: string,
  ): Promise<void> {
    await (
      await this.client().guilds.fetch(guildId)
    ).members.addRole({ user: userId, role: roleId, reason: auditReason });
  }
  public async removeRole(
    guildId: string,
    userId: string,
    roleId: string,
    auditReason: string,
  ): Promise<void> {
    await this.withRoleMutationLock(guildId, userId, () =>
      this.removeRoleUnlocked(guildId, userId, roleId, auditReason),
    );
  }
  /** Caller must already hold withRoleMutationLock. */
  public async removeRoleUnlocked(
    guildId: string,
    userId: string,
    roleId: string,
    auditReason: string,
  ): Promise<void> {
    await (
      await this.client().guilds.fetch(guildId)
    ).members
      .fetch(userId)
      .then((m) => m.roles.remove(roleId, auditReason));
  }
  public async withRoleMutationLock<T>(
    guildId: string,
    userId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${guildId}:${userId}`;
    const previous = this.roleLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.roleLocks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.roleLocks.get(key) === queued) this.roleLocks.delete(key);
    }
  }
  public async sendDm(userId: string, content: string): Promise<void> {
    await (await this.client().users.fetch(userId)).send(content);
  }
  public async setSlowmode(
    channelId: string,
    interval: number,
    auditReason: string,
  ): Promise<void> {
    const channel = await this.client().channels.fetch(channelId);
    if (!channel || !('setRateLimitPerUser' in channel))
      throw new Error('Channel is not text');
    await channel.setRateLimitPerUser(interval, auditReason);
  }
  public async getSlowmode(channelId: string): Promise<number> {
    const channel = await this.client().channels.fetch(channelId);
    if (!channel || !('rateLimitPerUser' in channel))
      throw new Error('Channel is not text');
    return channel.rateLimitPerUser ?? 0;
  }
  public async fetchMessages(
    channelId: string,
    before?: string,
    limit = 100,
  ): Promise<ReadonlyArray<ModerationMessage>> {
    const channel = await this.client().channels.fetch(channelId);
    if (!channel || !('messages' in channel))
      throw new Error('Channel is not text');
    const collection = await channel.messages.fetch({
      limit,
      ...(before ? { before } : {}),
    });
    return [...collection.values()].map((m) => ({
      id: m.id,
      authorId: m.author.id,
      authorIsBot: m.author.bot,
      webhook: m.webhookId !== null,
      content: m.content,
      embeds: m.embeds.length,
      embedMedia: m.embeds.some((embed) =>
        Boolean(embed.image?.url || embed.video?.url),
      ),
      attachments: [...m.attachments.values()].map((a) => ({
        contentType: a.contentType,
      })),
      createdAt: m.createdAt,
    }));
  }
  public async deleteMessages(
    channelId: string,
    messageIds: readonly string[],
  ): Promise<void> {
    const channel = await this.client().channels.fetch(channelId);
    if (!channel || !('bulkDelete' in channel))
      throw new Error('Channel is not text');
    await channel.bulkDelete(messageIds);
  }
  public async deleteMessage(
    channelId: string,
    messageId: string,
  ): Promise<void> {
    const channel = await this.client().channels.fetch(channelId);
    if (!channel || !('messages' in channel))
      throw new Error('Channel is not text');
    await channel.messages.delete(messageId);
  }
}
