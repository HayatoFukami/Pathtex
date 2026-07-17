import type { Result } from '../../domain/result.js';
export interface AnnouncementPort {
  getRole(
    id: string,
  ): Promise<{ id: string; mentionable: boolean; position: number }>;
  botPosition(): Promise<number>;
  botPositionFor?(channelId: string): Promise<number>;
  setMentionable(id: string, value: boolean): Promise<void>;
  send(
    channelId: string,
    content: string,
    allowedMentions: {
      roles: readonly string[];
      users: readonly string[];
      everyone: boolean;
    },
  ): Promise<void>;
  channelPermissions?(channelId: string): Promise<ReadonlySet<string>>;
  sameGuild?(channelId: string, roleId: string): Promise<boolean>;
  canMentionEveryone?(): Promise<boolean>;
}
export interface AuditEntry {
  readonly id: string;
  readonly action: string;
  readonly createdAt: Date;
  readonly userId: string;
  readonly userName: string;
  readonly target?: string;
  readonly targetType?: string;
  readonly reason?: string;
  readonly changes?: Readonly<Record<string, string>>;
}
export interface AuditPort {
  list(
    guildId: string,
    options: {
      userId?: string;
      action?: string;
      limit: number;
      before?: string;
      after?: string;
      totalLimit?: number;
    },
  ): Promise<readonly AuditEntry[]>;
  listPage?(
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
  }>;
}
export interface MemberTool {
  readonly id: string;
  readonly displayName: string;
  readonly bot: boolean;
  readonly owner: boolean;
  readonly rolePosition: number;
  readonly manageable: boolean;
  readonly nickname: string | null;
}
export interface ToolsPort {
  members(guildId: string): Promise<readonly MemberTool[]>;
  setNickname(guildId: string, userId: string, nickname: string): Promise<void>;
  invites(guildId: string): Promise<
    readonly {
      code: string;
      uses: number;
      creator?: string;
      vanity?: boolean;
    }[]
  >;
  deleteInvite(code: string): Promise<void>;
  user(id: string): Promise<{
    id: string;
    username: string;
    globalName?: string;
    bot: boolean;
    createdAt: Date;
    avatarUrl?: string;
  } | null>;
  invite(code: string): Promise<{
    code: string;
    guildName: string;
    guildId: string;
    description?: string;
    channelName?: string;
    memberCount?: number;
    onlineCount?: number;
    verification?: string;
    boost?: number;
    features: readonly string[];
    icon?: string;
  } | null>;
  preview(guildId: string): Promise<{
    guildName: string;
    guildId: string;
    description?: string;
    memberCount?: number;
    onlineCount?: number;
    icon?: string;
  } | null>;
}
export type ToolResult<T> = Result<T>;
export type LookupResult =
  | {
      kind: 'user';
      id: string;
      username: string;
      globalName?: string;
      bot: boolean;
      createdAt: Date;
      avatarUrl?: string;
    }
  | {
      kind: 'invite';
      code: string;
      guildName: string;
      guildId: string;
      description?: string;
      channelName?: string;
      memberCount?: number;
      onlineCount?: number;
      verification?: string;
      boost?: number;
      features: readonly string[];
      icon?: string;
    }
  | {
      kind: 'preview';
      guildName: string;
      guildId: string;
      description?: string;
      memberCount?: number;
      onlineCount?: number;
      icon?: string;
    };
