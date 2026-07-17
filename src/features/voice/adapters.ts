import { joinVoiceChannel } from '@discordjs/voice';
import { ChannelType, type Client, type GuildMember } from 'discord.js';
import type { VoiceMember, VoicePort } from './contracts.js';
export class DiscordVoiceAdapter implements VoicePort {
  private readonly connections = new Map<
    string,
    ReturnType<typeof joinVoiceChannel>
  >();
  public constructor(private readonly client: Client) {}
  public async disconnectAll(): Promise<void> {
    for (const guildId of this.connections.keys())
      await this.disconnect(guildId);
  }
  public async connect(guildId: string, channelId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice)
      throw new Error('VOICE_CHANNEL_REQUIRED');
    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });
    this.connections.set(guildId, connection);
  }
  public disconnect(guildId: string): Promise<void> {
    const connection = this.connections.get(guildId);
    connection?.destroy();
    this.connections.delete(guildId);
    return Promise.resolve();
  }
  public async move(
    guildId: string,
    userId: string,
    channelId: string,
  ): Promise<void> {
    const member = await (
      await this.client.guilds.fetch(guildId)
    ).members.fetch(userId);
    await member.voice.setChannel(channelId);
  }
  public async createTemporaryChannel(
    guildId: string,
    categoryId: string | null,
  ): Promise<string> {
    const g = await this.client.guilds.fetch(guildId);
    return (
      await g.channels.create({
        name: 'Pathtex VoiceKick',
        type: ChannelType.GuildVoice,
        ...(categoryId ? { parent: categoryId } : {}),
      })
    ).id;
  }
  public async deleteChannel(channelId: string): Promise<void> {
    const c = await this.client.channels.fetch(channelId);
    await c?.delete();
  }
  public async members(channelId: string): Promise<readonly VoiceMember[]> {
    const c = await this.client.channels.fetch(channelId);
    if (!c || !c.isVoiceBased()) return [];
    return [...c.members.values()].map((m: GuildMember) => ({
      id: m.id,
      bot: m.user.bot,
      channelId,
      displayName: m.displayName,
      categoryId: c.parentId,
    }));
  }
  public async dm(userId: string, content: string): Promise<void> {
    await (await this.client.users.fetch(userId)).send(content);
  }
  public async member(
    guildId: string,
    userId: string,
  ): Promise<VoiceMember | null> {
    const member = await (
      await this.client.guilds.fetch(guildId)
    ).members
      .fetch(userId)
      .catch(() => null);
    if (!member) return null;
    return {
      id: member.id,
      bot: member.user.bot,
      channelId: member.voice.channelId,
      displayName: member.displayName,
      ...(member.voice.channel
        ? { categoryId: member.voice.channel.parentId }
        : {}),
    };
  }
  public async actorChannel(
    guildId: string,
    userId: string,
  ): Promise<{ id: string } | null> {
    const member = await (
      await this.client.guilds.fetch(guildId)
    ).members
      .fetch(userId)
      .catch(() => null);
    return member?.voice.channel ? { id: member.voice.channel.id } : null;
  }
  public async canViewChannel(
    guildId: string,
    channelId: string,
    actorId: string,
  ): Promise<boolean> {
    const guild = await this.client.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(channelId);
    const me = guild.members.me;
    const actor = await guild.members.fetch(actorId).catch(() => null);
    if (!channel || !me || !('permissionsFor' in channel) || !actor)
      return false;
    const permissionsFor = channel.permissionsFor.bind(channel) as (
      subject: unknown,
    ) => { has(permission: string): boolean };
    return (
      permissionsFor(me).has('ViewChannel') &&
      permissionsFor(actor).has('ViewChannel')
    );
  }
  public async validateTargetChannel(
    guildId: string,
    channelId: string,
  ): Promise<boolean> {
    const guild = await this.client.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(channelId);
    return Boolean(
      channel && channel.guildId === guildId && channel.isVoiceBased(),
    );
  }
  public async canMoveToChannel(
    guildId: string,
    channelId: string,
    actorId: string,
  ): Promise<boolean> {
    const guild = await this.client.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(channelId);
    const bot = guild.members.me;
    const actor = await guild.members.fetch(actorId).catch(() => null);
    if (!channel || !bot || !actor || !('permissionsFor' in channel))
      return false;
    return (
      channel
        .permissionsFor(bot)
        .has(['ViewChannel', 'Connect', 'MoveMembers']) &&
      channel.permissionsFor(actor).has('ViewChannel')
    );
  }
  public async canKickFromChannel(
    guildId: string,
    channelId: string,
    actorId: string,
  ): Promise<boolean> {
    const guild = await this.client.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(channelId);
    const bot = guild.members.me;
    const actor = await guild.members.fetch(actorId).catch(() => null);
    if (!channel || !bot || !actor || !('permissionsFor' in channel))
      return false;
    return (
      channel.permissionsFor(bot).has(['ViewChannel', 'MoveMembers']) &&
      channel.permissionsFor(actor).has('ViewChannel')
    );
  }
  public async canCreateTemporaryChannel(
    guildId: string,
    categoryId: string | null,
    actorId: string,
  ): Promise<boolean> {
    const guild = await this.client.guilds.fetch(guildId);
    const bot = guild.members.me;
    const actor = await guild.members.fetch(actorId).catch(() => null);
    if (!bot || !actor) return false;
    const category = categoryId ? await guild.channels.fetch(categoryId) : null;
    const botPermissions =
      category && 'permissionsFor' in category
        ? category.permissionsFor(bot)
        : bot.permissions;
    const actorPermissions =
      category && 'permissionsFor' in category
        ? category.permissionsFor(actor)
        : actor.permissions;
    return (
      botPermissions.has('ManageChannels') &&
      actorPermissions.has('ViewChannel')
    );
  }
}
