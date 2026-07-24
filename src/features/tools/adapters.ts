import type { Client, Guild, Invite, Role, TextBasedChannel } from 'discord.js';
import type {
  AnnouncementPort,
  AuditEntry,
  AuditPort,
  MemberTool,
  ToolsPort,
} from './contracts.js';
import { isUnauthorized } from '../logging/adapters.js';
const auditActions: Record<string, number> = {
  CREATE_INSTANT_INVITE: 1,
  KICK: 20,
  BAN: 22,
  MEMBER_UPDATE: 24,
  MESSAGE_DELETE: 72,
  MESSAGE_BULK_DELETE: 73,
};
export function paginateAuditEntries<T>(
  entries: readonly T[],
  pageSize: number,
  remainingLimit: number,
): { entries: readonly T[]; hasMore: boolean } {
  const display = entries.slice(0, Math.min(pageSize, remainingLimit));
  return {
    entries: display,
    hasMore: display.length < remainingLimit && entries.length > display.length,
  };
}

const guild = async (client: Client, id: string): Promise<Guild> =>
  client.guilds.fetch(id);
export class DiscordToolsAdapter
  implements ToolsPort, AnnouncementPort, AuditPort
{
  public constructor(private readonly client: Client) {}
  public async members(guildId: string): Promise<readonly MemberTool[]> {
    const g = await guild(this.client, guildId);
    const all = await g.members.fetch();
    return [...all.values()].map((m) => ({
      id: m.id,
      displayName: m.displayName,
      bot: m.user.bot,
      owner: m.id === g.ownerId,
      rolePosition: m.roles.highest.position,
      manageable: m.manageable,
      nickname: m.nickname,
    }));
  }
  public async setNickname(
    guildId: string,
    userId: string,
    nickname: string,
  ): Promise<void> {
    const m = await (await guild(this.client, guildId)).members.fetch(userId);
    await m.setNickname(nickname);
  }
  public async invites(guildId: string): Promise<
    readonly {
      code: string;
      uses: number;
      creator?: string;
      vanity?: boolean;
    }[]
  > {
    const values = await (await guild(this.client, guildId)).invites.fetch();
    return [...values.values()].map((i) => ({
      code: i.code,
      uses: i.uses ?? 0,
      ...(i.inviter ? { creator: i.inviter.tag } : {}),
    }));
  }
  public async deleteInvite(code: string): Promise<void> {
    await this.client.fetchInvite(code).then((i) => i.delete());
  }
  public async user(id: string) {
    return this.client.users
      .fetch(id)
      .then((u) => {
        const avatarUrl = u.avatarURL();
        return {
          id: u.id,
          username: u.username,
          ...(u.globalName ? { globalName: u.globalName } : {}),
          bot: u.bot,
          createdAt: u.createdAt,
          ...(avatarUrl ? { avatarUrl } : {}),
        };
      })
      .catch((error: unknown) => {
        // A Discord authentication failure (401, direct or cause-wrapped) is
        // fatal and must propagate; any other lookup failure stays best-effort
        // and resolves to null.
        if (isUnauthorized(error)) throw error;
        return null;
      });
  }
  public async invite(code: string) {
    return this.client
      .fetchInvite(code)
      .then((i) => {
        const raw = i as Invite & {
          approximateMemberCount?: number;
          approximatePresenceCount?: number;
        };
        return {
          code: i.code,
          guildName: i.guild?.name ?? '不明',
          guildId: i.guild?.id ?? '',
          ...(i.guild?.description ? { description: i.guild.description } : {}),
          ...(i.channel?.name ? { channelName: i.channel.name } : {}),
          ...(raw.approximateMemberCount === undefined
            ? {}
            : { memberCount: raw.approximateMemberCount }),
          ...(raw.approximatePresenceCount === undefined
            ? {}
            : { onlineCount: raw.approximatePresenceCount }),
          ...(i.guild
            ? { verification: String(i.guild.verificationLevel) }
            : {}),
          ...(!('premiumTier' in (i.guild ?? {}))
            ? {}
            : {
                boost: Number(
                  (i.guild as { premiumTier?: number }).premiumTier,
                ),
              }),
          features: i.guild?.features ?? [],
          ...((i.guild as { icon?: string | null } | undefined)?.icon
            ? {
                icon: `https://cdn.discordapp.com/icons/${i.guild?.id ?? 'unknown'}/${(i.guild as { icon: string }).icon}.png`,
              }
            : {}),
        };
      })
      .catch((error: unknown) => {
        // A Discord authentication failure (401, direct or cause-wrapped) is
        // fatal and must propagate; any other lookup failure stays best-effort
        // and resolves to null.
        if (isUnauthorized(error)) throw error;
        return null;
      });
  }
  public async preview(guildId: string) {
    return this.client
      .fetchGuildPreview(guildId)
      .then((g) => {
        const icon = g.iconURL();
        return {
          guildName: g.name,
          guildId: g.id,
          ...(g.description ? { description: g.description } : {}),
          memberCount: g.approximateMemberCount,
          onlineCount: g.approximatePresenceCount,
          ...(icon ? { icon } : {}),
        };
      })
      .catch((error: unknown) => {
        // A Discord authentication failure (401, direct or cause-wrapped) is
        // fatal and must propagate; any other lookup failure stays best-effort
        // and resolves to null.
        if (isUnauthorized(error)) throw error;
        return null;
      });
  }
  public async getRole(
    id: string,
  ): Promise<{ id: string; mentionable: boolean; position: number }> {
    const role = await this.client.guilds.cache.reduce<Promise<Role | null>>(
      async (found, g) =>
        (await found) ??
        g.roles.fetch(id).catch((error: unknown) => {
          // A 401 (direct or cause-wrapped) is a fatal authentication failure
          // and must propagate; any other per-guild fetch failure stays
          // best-effort and resolves to null so the search continues.
          if (isUnauthorized(error)) throw error;
          return null;
        }),
      Promise.resolve(null),
    );
    if (!role) throw new Error('ROLE_NOT_FOUND');
    return {
      id: role.id,
      mentionable: role.mentionable,
      position: role.position,
    };
  }
  public botPosition(): Promise<number> {
    const me = this.client.user;
    if (!me) return Promise.resolve(-1);
    const member = this.client.guilds.cache.first()?.members.me;
    return Promise.resolve(member?.roles.highest.position ?? -1);
  }
  public async botPositionFor(channelId: string): Promise<number> {
    const channel = await this.client.channels.fetch(channelId);
    const me = channel && 'guild' in channel ? channel.guild.members.me : null;
    return me?.roles.highest.position ?? -1;
  }
  public async setMentionable(id: string, value: boolean): Promise<void> {
    for (const g of this.client.guilds.cache.values()) {
      const role = g.roles.cache.get(id);
      if (role) {
        await role.setMentionable(value);
        return;
      }
    }
    throw new Error('ROLE_NOT_FOUND');
  }
  public async send(
    channelId: string,
    content: string,
    allowedMentions: {
      roles: readonly string[];
      users: readonly string[];
      everyone: boolean;
    },
  ): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased())
      throw new Error('CHANNEL_NOT_FOUND');
    if (!('send' in channel)) throw new Error('CHANNEL_NOT_FOUND');
    await (
      channel as TextBasedChannel & { send(payload: unknown): Promise<unknown> }
    ).send({ content, allowedMentions });
  }
  public async channelPermissions(
    channelId: string,
  ): Promise<ReadonlySet<string>> {
    const channel = await this.client.channels.fetch(channelId);
    const guildChannel = channel && 'guild' in channel ? channel.guild : null;
    const me = guildChannel?.members.me ?? null;
    if (!channel || !me) return new Set<string>();
    const permissionSource = channel as unknown as {
      permissionsFor(subject: unknown): { toArray(): string[] } | null;
    };
    return new Set(permissionSource.permissionsFor(me)?.toArray() ?? []);
  }
  public async sameGuild(channelId: string, roleId: string): Promise<boolean> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('guild' in channel)) return false;
    return (
      channel.guild.roles.cache.has(roleId) ||
      (await channel.guild.roles.fetch(roleId).catch((error: unknown) => {
        // A 401 (direct or cause-wrapped) is a fatal authentication failure and
        // must propagate; any other fetch failure stays best-effort and resolves
        // to null so the probe reports "not same guild".
        if (isUnauthorized(error)) throw error;
        return null;
      })) !== null
    );
  }
  public canMentionEveryone(): Promise<boolean> {
    return Promise.resolve(
      this.client.guilds.cache.some(
        (g) => g.members.me?.permissions.has('MentionEveryone') ?? false,
      ),
    );
  }
  public async list(
    guildId: string,
    options: {
      userId?: string;
      action?: string;
      limit: number;
      before?: string;
      after?: string;
      totalLimit?: number;
    },
  ): Promise<readonly AuditEntry[]> {
    const g = await guild(this.client, guildId);
    const logs = await g.fetchAuditLogs({
      limit: Math.min(100, (options.totalLimit ?? options.limit) + 1),
      ...(options.before ? { before: options.before } : {}),
      ...(options.after ? { after: options.after } : {}),
      ...(options.userId ? { user: options.userId } : {}),
      ...(options.action
        ? {
            type: (auditActions[options.action] ??
              Number(options.action)) as never,
          }
        : {}),
    });
    return [...logs.entries.values()].map((entry) => {
      const rawEntry = entry as unknown as { targetType?: string };
      return {
        id: entry.id,
        action: String(entry.action),
        createdAt: entry.createdAt,
        userId: entry.executor?.id ?? '不明',
        userName: entry.executor?.tag ?? '不明',
        target: `${(entry.target as { name?: string; username?: string }).name ?? (entry.target as { username?: string }).username ?? '不明'} (${(entry.target as { id?: string }).id ?? '不明'})`,
        targetType: rawEntry.targetType ?? 'Discord target',
        ...(entry.reason ? { reason: entry.reason } : {}),
        ...(entry.changes.length
          ? {
              changes: Object.fromEntries(
                entry.changes.map((change) => [
                  change.key,
                  `${JSON.stringify(change.old ?? 'なし')} → ${JSON.stringify(change.new ?? 'なし')}`,
                ]),
              ),
            }
          : {}),
      };
    });
  }
  public async listPage(
    guildId: string,
    options: {
      userId?: string;
      action?: string;
      limit: number;
      before?: string;
      after?: string;
      totalLimit?: number;
    },
  ): Promise<{
    entries: readonly AuditEntry[];
    nextBefore?: string;
    previousAfter?: string;
    total: number;
    hasMore: boolean;
  }> {
    if ((options.totalLimit ?? options.limit) === 0)
      return { entries: [], total: 0, hasMore: false };
    const allEntries = await this.list(guildId, options);
    const remainingLimit = options.totalLimit ?? options.limit;
    const page = paginateAuditEntries(
      allEntries,
      options.limit,
      remainingLimit,
    );
    const entries = page.entries;
    const last = entries.at(-1);
    return {
      entries,
      ...(last ? { nextBefore: last.id } : {}),
      ...((options.before || options.after) && entries[0]
        ? { previousAfter: entries[0].id }
        : {}),
      total: Math.min(allEntries.length, options.totalLimit ?? options.limit),
      hasMore: page.hasMore,
    };
  }
}
