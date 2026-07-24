import type {
  Client,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { AppConfig } from '../config/env.js';
import type { JobDispatcher } from './scheduler.js';

export interface DiscordRestPort {
  putGlobal(
    applicationId: string,
    commands: readonly RESTPostAPIChatInputApplicationCommandsJSONBody[],
  ): Promise<void>;
  putGuild(
    applicationId: string,
    guildId: string,
    commands: readonly RESTPostAPIChatInputApplicationCommandsJSONBody[],
  ): Promise<void>;
}

export interface DiscordClientPort {
  readonly client: Client;
  login(token: string, signal?: AbortSignal): Promise<void>;
  destroy(): Promise<void>;
}

export interface RuntimeResources {
  readonly commands: readonly RESTPostAPIChatInputApplicationCommandsJSONBody[];
}

export interface RuntimePorts {
  validateDatabase(): Promise<void>;
  applyMigrations(): Promise<void>;
  loadResources(): Promise<RuntimeResources>;
  registerCommands?: (
    commands: readonly RESTPostAPIChatInputApplicationCommandsJSONBody[],
  ) => Promise<void>;
  createClient(): Promise<DiscordClientPort>;
  readonly rest?: DiscordRestPort;
  recoverStaleJobs(): Promise<void>;
  schedulerDispatcher: JobDispatcher;
  startScheduler(): Promise<void>;
  startIntake(): Promise<void>;
  stopIntake(): Promise<void>;
  drainIntake(): Promise<void>;
  stopScheduler(): Promise<void>;
  stopVoice(): Promise<void>;
  /** Optional periodic retention sweep lifecycle. */
  startRetention?(): Promise<void>;
  stopRetention?(): Promise<void>;
  /** Optional bounded gateway-work drain, awaited before Prisma disconnect. */
  drainGateway?(): Promise<void>;
  disconnectDatabase(): Promise<void>;
}

export type RuntimeConfig = Pick<
  AppConfig,
  'DISCORD_TOKEN' | 'DISCORD_CLIENT_ID' | 'COMMAND_SCOPE' | 'DEV_GUILD_ID'
>;
