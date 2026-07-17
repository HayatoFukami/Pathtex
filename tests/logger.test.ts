import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logging/logger.js';

const context = {
  event: 'test',
  correlationId: 'correlation-1',
  interactionId: null,
  guildId: null,
  channelId: null,
  userId: null,
  caseId: null,
  durationMs: null,
  errorName: null,
  discordCode: null,
} as const;

describe('logger', () => {
  it('emits ISO timestamps, context, and redacts secrets', async () => {
    let output = '';
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        const data = chunk as string | Uint8Array;
        output +=
          typeof data === 'string' ? data : Buffer.from(data).toString();
        callback();
      },
    });
    createLogger({ LOG_LEVEL: 'info' }, context, stream).info(
      {
        token: 'secret-token',
        password: 'secret-password',
        message: 'private message',
        config: {
          DISCORD_TOKEN: 'nested-token',
          DATABASE_URL: 'nested-url',
          authorization: 'bearer secret',
        },
        request: {
          headers: {
            authorization: 'lower secret',
            Authorization: 'upper secret',
          },
        },
        headers: { Authorization: 'top-level secret' },
      },
      'test',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const entry = JSON.parse(output) as {
      timestamp: string;
      correlationId: string;
      token: string;
      password: string;
      message: string;
      config: {
        DISCORD_TOKEN: string;
        DATABASE_URL: string;
        authorization: string;
      };
      request: { headers: { authorization: string; Authorization: string } };
      headers: { Authorization: string };
    };
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.correlationId).toBe('correlation-1');
    expect(entry.token).toBe('[REDACTED]');
    expect(entry.password).toBe('[REDACTED]');
    expect(entry.message).toBe('[REDACTED]');
    expect(entry.config.DISCORD_TOKEN).toBe('[REDACTED]');
    expect(entry.config.DATABASE_URL).toBe('[REDACTED]');
    expect(entry.config.authorization).toBe('[REDACTED]');
    expect(entry.request.headers.authorization).toBe('[REDACTED]');
    expect(entry.request.headers.Authorization).toBe('[REDACTED]');
    expect(entry.headers.Authorization).toBe('[REDACTED]');
  });
});
