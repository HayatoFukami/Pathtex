import type { CommandDefinition } from '../../commands/contract.js';
import type { GeneralRepository } from '../../repositories/contracts.js';

export type GeneralDatabasePort = GeneralRepository;

export interface GeneralUserFetcher {
  fetch(userId: string): Promise<import('discord.js').User>;
}

export interface GeneralStatsPort {
  getStats(): Promise<{ cases: number; strikes: number }>;
}

export interface GeneralRuntimePort {
  readonly botName: string;
  readonly avatarUrl: string | undefined;
  readonly version: string;
  readonly nodeVersion: string;
  readonly discordVersion: string;
  readonly uptimeMs: number;
  readonly guildCount: number;
  readonly cachedUserCount: number;
  readonly clientId: string;
  readonly invitePermissions: string;
  readonly gatewayPing: number;
  dbPing(): Promise<number>;
}

export interface GeneralServiceDependencies {
  readonly runtime: GeneralRuntimePort;
  readonly database?: GeneralDatabasePort;
  readonly stats?: GeneralStatsPort;
}

export interface GeneralDiscordPort {
  readonly runtime: GeneralRuntimePort;
}

export interface GeneralManifest {
  readonly commands: readonly CommandDefinition[];
}

export interface RoleInfo {
  name: string;
  id: string;
  color: string;
  createdAt: string;
  position: number | null;
  members: number | null;
  memberCountApproximate: boolean;
  mentionable: boolean;
  hoist: boolean;
  managed: boolean;
  icon: string;
  permissions: readonly string[];
  botComparison: string;
}

export interface UserInfo {
  username: string;
  globalName: string;
  id: string;
  bot: boolean;
  system: boolean;
  createdAt: string;
  joinedAt: string;
  nickname: string;
  highestRole: string;
  roles: readonly string[];
  avatar: string;
  guildAvatar: string;
  guildAvatarAvailable: boolean;
  banner: string;
  accent: string;
  timeout: string;
}

export interface ServerInfo {
  name: string;
  id: string;
  icon: string;
  owner: string;
  createdAt: string;
  memberCount: number;
  userCount: number;
  botCount: number;
  textChannels: number;
  voiceChannels: number;
  categories: number;
  threads: number;
  roles: number;
  boosts: number;
  tier: string;
  verification: string;
  filter: string;
  locale: string;
  features: readonly string[];
  vanity: string;
  approximate: boolean;
}
