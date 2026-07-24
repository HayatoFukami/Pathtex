import type {
  GeneralRuntimePort,
  GeneralServiceDependencies,
  RoleInfo,
  ServerInfo,
  UserInfo,
} from './contracts.js';
import { t } from '../../i18n/index.js';

export class GeneralService {
  public constructor(private readonly deps: GeneralServiceDependencies) {}

  public get runtime(): GeneralRuntimePort {
    return this.deps.runtime;
  }

  public async about(): Promise<Record<string, string>> {
    let statistics = t('general:about.statisticsFailed');
    try {
      const value = await withDeadlineValue(
        (this.deps.stats ?? this.deps.database)?.getStats(),
        1_500,
      );
      if (value)
        statistics = t('general:about.statistics', {
          cases: value.cases,
          strikes: value.strikes,
        });
    } catch {
      /* safe fallback is part of the public contract */
    }
    const r = this.deps.runtime;
    return {
      Bot: r.botName,
      [t('general:about.fields.version')]: r.version,
      Node: r.nodeVersion,
      'discord.js': r.discordVersion,
      [t('general:about.fields.uptime')]: formatDuration(r.uptimeMs),
      [t('general:about.fields.guildCount')]: String(r.guildCount),
      [t('general:about.fields.cachedUserCount')]: String(
        r.cachedUserCount,
      ),
      [t('general:about.fields.statistics')]: statistics,
      GitHub: 'https://github.com/HayatoFukami/Pathtex',
    };
  }

  public invite(): string {
    const r = this.deps.runtime;
    return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(r.clientId)}&scope=bot%20applications.commands&permissions=${encodeURIComponent(r.invitePermissions)}`;
  }

  public async ping(receivedAt: number): Promise<{
    interactionMs: number;
    gatewayMs: number;
    databaseMs: number | null;
  }> {
    try {
      const ping = this.deps.database
        ? async () => {
            await this.deps.database?.ping();
          }
        : () => this.deps.runtime.dbPing();
      const databaseMs = await withDeadline(ping(), 1_500);
      return {
        interactionMs: Date.now() - receivedAt,
        gatewayMs: this.deps.runtime.gatewayPing,
        databaseMs,
      };
    } catch {
      return {
        interactionMs: Date.now() - receivedAt,
        gatewayMs: this.deps.runtime.gatewayPing,
        databaseMs: null,
      };
    }
  }

  public roleInfo(role: RoleInfo): RoleInfo {
    return role;
  }
  public serverInfo(server: ServerInfo): ServerInfo {
    return server;
  }
  public userInfo(user: UserInfo): UserInfo {
    return user;
  }
}

export const formatDuration = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return t('general:duration', { days, hours, minutes, seconds: rest });
};

const withDeadline = async (
  operation: Promise<void> | Promise<number>,
  milliseconds: number,
): Promise<number> => {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('database deadline exceeded'));
        }, milliseconds);
      }),
    ]);
    return typeof result === 'number' ? result : Date.now() - started;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const withDeadlineValue = async <T>(
  operation: Promise<T> | undefined,
  milliseconds: number,
): Promise<T | undefined> => {
  if (!operation) return undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('database deadline exceeded'));
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const splitList = (values: readonly string[], max = 1024): string[] => {
  const result: string[] = [];
  let current = '';
  for (const value of values) {
    if (
      current &&
      Array.from(current).length + Array.from(value).length + 2 > max
    ) {
      result.push(current);
      current = '';
    }
    current += current ? `, ${value}` : value;
  }
  if (current || result.length === 0) result.push(current);
  return result;
};
