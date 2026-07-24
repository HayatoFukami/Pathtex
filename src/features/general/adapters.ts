import {
  PermissionsBitField,
  SnowflakeUtil,
  version as discordJsVersion,
  type APIRole,
  type Client,
  type Guild,
  type Role,
  type User,
  type GuildMember,
} from 'discord.js';
import type { GeneralDatabasePort, GeneralUserFetcher } from './contracts.js';
import type {
  GeneralRuntimePort,
  RoleInfo,
  ServerInfo,
  UserInfo,
} from './contracts.js';
import { t } from '../../i18n/index.js';

export class DiscordGeneralAdapter {
  public constructor(
    private readonly client: Client,
    private readonly config: {
      version: string;
      clientId: string;
      invitePermissions?: string;
      database?: GeneralDatabasePort;
      userFetcher?: GeneralUserFetcher;
    },
  ) {}
  public runtime(): GeneralRuntimePort {
    const client = this.client;
    return {
      get botName() {
        return client.user?.username ?? 'Pathtex';
      },
      get avatarUrl() {
        return client.user?.displayAvatarURL();
      },
      version: this.config.version,
      nodeVersion: process.version,
      discordVersion: discordJsVersion,
      get uptimeMs() {
        return client.uptime ?? 0;
      },
      get guildCount() {
        return client.guilds.cache.size;
      },
      get cachedUserCount() {
        return client.users.cache.size;
      },
      clientId: this.config.clientId,
      invitePermissions: this.config.invitePermissions ?? '0',
      get gatewayPing() {
        return client.ws.ping;
      },
      dbPing: async () => {
        const started = Date.now();
        if (!this.config.database) throw new Error('database adapter required');
        await this.config.database.ping();
        return Date.now() - started;
      },
    };
  }
  public role(role: Role | APIRole, botRole?: Role): RoleInfo {
    const cached = 'guild' in role ? role : undefined;
    const permissions =
      'permissions' in role
        ? (typeof role.permissions === 'string'
            ? new PermissionsBitField(BigInt(role.permissions))
            : role.permissions
          ).toArray()
        : [];
    const position =
      cached?.position ?? ('position' in role ? role.position : null);
    const apiColor =
      'colors' in role
        ? 'primary_color' in role.colors
          ? role.colors.primary_color
          : role.colors.primaryColor
        : 0;
    const color =
      cached?.hexColor ?? `#${apiColor.toString(16).padStart(6, '0')}`;
    const createdAt =
      cached?.createdAt ?? new Date(SnowflakeUtil.timestampFrom(role.id));
    return {
      name: role.name,
      id: role.id,
      color,
      createdAt: createdAt.toISOString(),
      position,
      members: cached?.members.size ?? null,
      memberCountApproximate: true,
      mentionable: role.mentionable,
      hoist: role.hoist,
      managed: role.managed,
      icon:
        cached?.iconURL() ??
        cached?.unicodeEmoji ??
        ('icon' in role && role.icon
          ? `https://cdn.discordapp.com/role-icons/${role.id}/${role.icon}.png`
          : 'unicode_emoji' in role && role.unicode_emoji
            ? role.unicode_emoji
            : t('general:common.none')),
      permissions,
      botComparison:
        botRole && position !== null
          ? comparison(position, botRole.position)
          : t('general:common.unavailable'),
    };
  }
  public async roleWithMemberCount(
    role: Role | APIRole,
    guild: Guild,
    botRole?: Role,
  ): Promise<RoleInfo> {
    const base = this.role(role, botRole);
    try {
      const members = await guild.members.fetch();
      return {
        ...base,
        members: members.filter((member) => member.roles.cache.has(role.id))
          .size,
        memberCountApproximate: false,
      };
    } catch {
      return base;
    }
  }
  public user(user: User, member?: GuildMember): UserInfo {
    return {
      username: user.username,
      globalName: user.globalName ?? t('general:common.none'),
      id: user.id,
      bot: user.bot,
      system: user.system,
      createdAt: user.createdAt.toISOString(),
      joinedAt:
        member?.joinedAt?.toISOString() ?? t('general:common.unavailable'),
      nickname: member?.nickname ?? t('general:common.none'),
      highestRole: member?.roles.highest.name ?? '@everyone',
      roles:
        member?.roles.cache
          .filter((r) => r.id !== member.guild.id)
          .map((r) => r.name)
          .slice(0, 30) ?? [],
      avatar: user.displayAvatarURL(),
      guildAvatar: member?.avatar
        ? member.displayAvatarURL()
        : t('general:common.none'),
      guildAvatarAvailable:
        member?.avatar !== null && member?.avatar !== undefined,
      banner: user.bannerURL() ?? t('general:common.unavailable'),
      accent: user.hexAccentColor ?? t('general:common.unavailable'),
      timeout:
        member?.communicationDisabledUntil?.toISOString() ??
        t('general:common.none'),
    };
  }
  public async resolveMember(
    guild: Guild,
    userId: string,
    cached?: GuildMember,
  ): Promise<GuildMember | undefined> {
    if (cached) return cached;
    try {
      return await guild.members.fetch(userId);
    } catch {
      return undefined;
    }
  }
  public async userWithDetails(
    user: User,
    member?: GuildMember,
  ): Promise<UserInfo> {
    try {
      const fetched = this.config.userFetcher
        ? await this.config.userFetcher.fetch(user.id)
        : await user.fetch();
      return this.user(fetched, member);
    } catch {
      return this.user(user, member);
    }
  }
  public server(guild: Guild): ServerInfo {
    const channels = [...guild.channels.cache.values()];
    const members = [...guild.members.cache.values()];
    return {
      name: guild.name,
      id: guild.id,
      icon: guild.iconURL() ?? t('general:common.none'),
      owner: guild.ownerId,
      createdAt: guild.createdAt.toISOString(),
      memberCount: guild.memberCount,
      userCount: members.filter((m) => !m.user.bot).length,
      botCount: members.filter((m) => m.user.bot).length,
      textChannels: channels.filter(
        (c) => c.isTextBased() && !c.isVoiceBased() && !c.isThread(),
      ).length,
      voiceChannels: channels.filter((c) => c.isVoiceBased()).length,
      categories: channels.filter((c) => String(c.type) === '4').length,
      threads: channels.filter((c) => c.isThread()).length,
      roles: guild.roles.cache.size,
      boosts: guild.premiumSubscriptionCount ?? 0,
      tier: String(guild.premiumTier),
      verification: String(guild.verificationLevel),
      filter: String(guild.explicitContentFilter),
      locale: guild.preferredLocale,
      features: guild.features,
      vanity: guild.vanityURLCode
        ? `https://discord.gg/${guild.vanityURLCode}`
        : t('general:common.none'),
      approximate: members.length < guild.memberCount,
    };
  }
}

const comparison = (position: number, botPosition: number): string =>
  position > botPosition
    ? t('general:roleComparison.higher')
    : position === botPosition
      ? t('general:roleComparison.equal')
      : t('general:roleComparison.lower');
