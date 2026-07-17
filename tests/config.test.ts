import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { loadConfig } from '../src/config/env.js';

const validEnvironment = {
  DISCORD_TOKEN: 'not-a-real-token',
  DISCORD_CLIENT_ID: '12345678901234567',
  DATABASE_URL: 'postgresql://user:password@localhost:5432/pathtex',
  COMMAND_SCOPE: 'guild',
  DEV_GUILD_ID: '12345678901234567',
  BOT_VERSION: '0.1.0',
};

describe('environment configuration', () => {
  it('loads defaults and validates a guild configuration', () => {
    const config = loadConfig(validEnvironment);
    expect(config.MESSAGE_RETENTION_DAYS).toBe(7);
    expect(config.MAX_BULK_TARGETS).toBe(20);
    expect(config.OWNER_USER_IDS).toBeUndefined();
  });

  it('normalizes blank optional values to defaults or undefined', () => {
    const config = loadConfig({
      ...validEnvironment,
      SENTRY_DSN: '',
      INVITE_PERMISSIONS: '',
      LOG_LEVEL: '',
      MESSAGE_RETENTION_DAYS: '',
      MAX_BULK_TARGETS: '',
      OWNER_USER_IDS: '',
      INSTANCE_ID: '',
    });
    expect(config.SENTRY_DSN).toBeUndefined();
    expect(config.INVITE_PERMISSIONS).toBeUndefined();
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.MESSAGE_RETENTION_DAYS).toBe(7);
    expect(config.MAX_BULK_TARGETS).toBe(20);
    expect(config.OWNER_USER_IDS).toBeUndefined();
  });

  it('rejects invalid configuration before startup', () => {
    expect(() =>
      loadConfig({ ...validEnvironment, DISCORD_TOKEN: '' }),
    ).toThrow();
    expect(() =>
      loadConfig({ ...validEnvironment, DEV_GUILD_ID: undefined }),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...validEnvironment,
        DATABASE_URL: 'postgresql://user:secret@localhost:5432/pathtex',
        OWNER_USER_IDS: 'bad-id',
      }),
    ).toThrow(/comma-separated Discord Snowflakes/);
    expect(() =>
      loadConfig({ ...validEnvironment, DISCORD_TOKEN: ' token' }),
    ).toThrow();
    expect(() =>
      loadConfig({ ...validEnvironment, BOT_VERSION: 'v1.0.0' }),
    ).toThrow();
    expect(() =>
      loadConfig({ ...validEnvironment, INSTANCE_ID: 'x'.repeat(65) }),
    ).toThrow();
    expect(
      loadConfig({ ...validEnvironment, INSTANCE_ID: 'x'.repeat(64) })
        .INSTANCE_ID,
    ).toHaveLength(64);
    for (const version of ['1.0.0-', '01.0.0', '1.0.0-01', '1.0.0+']) {
      expect(() =>
        loadConfig({ ...validEnvironment, BOT_VERSION: version }),
      ).toThrow();
    }
    expect(
      loadConfig({ ...validEnvironment, BOT_VERSION: '1.2.3-rc.1+build.7' })
        .BOT_VERSION,
    ).toBe('1.2.3-rc.1+build.7');
    expect(
      loadConfig({ ...validEnvironment, BOT_VERSION: '1.0.0-0alpha' })
        .BOT_VERSION,
    ).toBe('1.0.0-0alpha');
    expect(() =>
      loadConfig({ ...validEnvironment, OWNER_USER_IDS: '1234567890123456' }),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...validEnvironment,
        OWNER_USER_IDS: '12345678901234567,,12345678901234567',
      }),
    ).toThrow();
    expect(
      loadConfig({
        ...validEnvironment,
        OWNER_USER_IDS: '12345678901234567,12345678901234567890',
      }).OWNER_USER_IDS,
    ).toHaveLength(2);
    expect(() =>
      loadConfig({ ...validEnvironment, MESSAGE_RETENTION_DAYS: '0' }),
    ).toThrow();
    expect(() =>
      loadConfig({ ...validEnvironment, MESSAGE_RETENTION_DAYS: '31' }),
    ).toThrow();
    for (const value of ['1.5', '1e1', '-1', '+1', 'NaN']) {
      expect(() =>
        loadConfig({ ...validEnvironment, MESSAGE_RETENTION_DAYS: value }),
      ).toThrow();
    }
    expect(() =>
      loadConfig({ ...validEnvironment, MAX_BULK_TARGETS: '0' }),
    ).toThrow();
    expect(() =>
      loadConfig({ ...validEnvironment, MAX_BULK_TARGETS: '21' }),
    ).toThrow();
    expect(
      loadConfig({
        ...validEnvironment,
        MESSAGE_RETENTION_DAYS: '30',
        MAX_BULK_TARGETS: '1',
      }).MAX_BULK_TARGETS,
    ).toBe(1);
  });

  it('parses the example file without treating optional blanks as values', () => {
    const parsed = parse(
      readFileSync(new URL('../.env.example', import.meta.url)),
    );
    expect(parsed.DATABASE_URL).toContain('postgresql://');
    expect(parsed.SENTRY_DSN).toBe('');
    const completed = loadConfig({
      ...parsed,
      DISCORD_TOKEN: 'example-token',
      DISCORD_CLIENT_ID: '12345678901234567',
      DEV_GUILD_ID: '12345678901234567',
    });
    expect(completed.BOT_VERSION).toBe('0.1.0');
  });
});
