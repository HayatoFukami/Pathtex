import pino, { type DestinationStream, type Logger } from 'pino';
import type { AppConfig } from '../config/env.js';

export interface AppLogContext {
  event: string;
  correlationId: string;
  interactionId: string | null;
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  caseId: string | null;
  durationMs: number | null;
  errorName: string | null;
  discordCode: string | null;
}

export function createLogger(
  config: Pick<AppConfig, 'LOG_LEVEL'>,
  context: AppLogContext,
  stream?: DestinationStream,
): Logger {
  return pino(
    {
      level: config.LOG_LEVEL,
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
      base: context,
      redact: {
        paths: [
          '*.token',
          '*.password',
          '*.secret',
          '*.authorization',
          'token',
          'password',
          'secret',
          'authorization',
          'Authorization',
          'headers.authorization',
          'headers.Authorization',
          'request.headers.authorization',
          'request.headers.Authorization',
          'config.authorization',
          'config.*.authorization',
          'env.authorization',
          'env.*.authorization',
          'config.*.token',
          'config.*.password',
          'config.*.secret',
          'config.DISCORD_TOKEN',
          'config.DATABASE_URL',
          'env.*.token',
          'env.*.password',
          'env.*.secret',
          'env.DISCORD_TOKEN',
          'env.DATABASE_URL',
          'reason',
          'message',
        ],
        censor: '[REDACTED]',
      },
    },
    stream,
  );
}

export function logEvent(
  logger: Logger,
  context: AppLogContext,
  message: string,
  data: Record<string, unknown> = {},
): void {
  logger.info({ ...data, ...context }, message);
}
