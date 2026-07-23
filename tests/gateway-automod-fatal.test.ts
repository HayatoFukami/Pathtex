import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Client } from 'discord.js';
import { installMessageLoggingListeners } from '../src/index.js';
import { LoggingEventPipeline } from '../src/features/logging/index.js';
import type { LogDeliveryService } from '../src/features/logging/index.js';
import { ok, err } from '../src/domain/result.js';
import type { SettingsService } from '../src/services/settings-service.js';
import type { SnapshotService } from '../src/services/snapshot-service.js';
import type { Logger } from 'pino';
import { AutomodService } from '../src/features/automod/service.js';
import type { AutomodDiscordPort } from '../src/features/automod/contracts.js';
import { isUnauthorized } from '../src/features/logging/adapters.js';

const GUILD = '12345678901234567';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
};

const mockMessage = () => ({
  id: 'msg-1',
  guildId: GUILD,
  channelId: 'chan-1',
  author: {
    id: 'user-1',
    tag: 'user#0',
    bot: false,
    avatarURL: () => null,
  },
  content: 'hello world',
  webhookId: null,
  system: false,
  attachments: { values: () => [] },
  embeds: [],
  flags: { bitfield: 0 },
  mentions: {
    users: { values: () => [] },
    roles: { keys: () => [] },
    everyone: false,
  },
  channel: {},
  createdAt: new Date(),
  url: 'https://discord.com/messages/1',
});

const buildPipeline = (inspectError: Error, logger?: Logger) => {
  const inspect = vi.fn(() => Promise.reject(inspectError));
  const snapshots = {
    saveMessage: vi.fn(() => Promise.resolve(ok(undefined))),
    getMessage: vi.fn(() => Promise.resolve(ok(null))),
    deleteMessage: vi.fn(() => Promise.resolve(ok(undefined))),
    saveMember: vi.fn(() => Promise.resolve(ok(undefined))),
    getMembersForUser: vi.fn(() => Promise.resolve(ok([]))),
  };
  const pipeline = new LoggingEventPipeline({
    snapshots: snapshots as unknown as SnapshotService,
    automod: { inspect },
    events: {} as never,
    delivery: {
      deliver: vi.fn(() => Promise.resolve({ status: 'skipped' as const })),
    } as unknown as LogDeliveryService,
    timezone: () => Promise.resolve('UTC'),
    ...(logger ? { logger } : {}),
  });
  return { pipeline, inspect };
};

const installGateway = (pipeline: LoggingEventPipeline, logger: Logger) => {
  const client = new EventEmitter();
  const fatal = vi.fn();
  const settings = {
    get: () => Promise.resolve(err('INVALID_INPUT', 'not a log channel')),
  } as unknown as SettingsService;
  const snapshots = {
    getMessage: vi.fn(() => Promise.resolve(ok(null))),
    deleteMessage: vi.fn(() => Promise.resolve(ok(undefined))),
  } as unknown as Pick<SnapshotService, 'getMessage' | 'deleteMessage'>;
  installMessageLoggingListeners(
    client as unknown as Client,
    pipeline,
    settings,
    snapshots,
    logger,
    fatal,
  );
  return { client, fatal };
};

const gatewayLogger = () => ({ error: vi.fn() }) as unknown as Logger;
const errorSpy = (logger: Logger) =>
  (logger as unknown as { error: ReturnType<typeof vi.fn> }).error;

describe('gateway AutoMod fatal-401 propagation', () => {
  it('routes an AutoMod 401 from messageCreate to fatal, not merely logs', async () => {
    const unauthorized = Object.assign(new Error('unauthorized'), {
      status: 401,
    });
    const logger = gatewayLogger();
    const { pipeline, inspect } = buildPipeline(unauthorized, logger);
    const { client, fatal } = installGateway(pipeline, logger);
    client.emit('messageCreate', mockMessage());
    await flush();
    expect(inspect).toHaveBeenCalledOnce();
    expect(fatal).toHaveBeenCalledOnce();
    expect(fatal).toHaveBeenCalledWith(unauthorized);
    // The auth failure must reach fatal instead of being logged as a routine
    // gateway/pipeline failure.
    expect(errorSpy(logger)).not.toHaveBeenCalled();
  });

  it('routes an AutoMod 401 from messageUpdate to fatal, not merely logs', async () => {
    const unauthorized = Object.assign(new Error('unauthorized'), {
      status: 401,
    });
    const logger = gatewayLogger();
    const { pipeline, inspect } = buildPipeline(unauthorized, logger);
    const { client, fatal } = installGateway(pipeline, logger);
    const after = mockMessage();
    client.emit('messageUpdate', mockMessage(), after);
    await flush();
    expect(inspect).toHaveBeenCalledOnce();
    expect(fatal).toHaveBeenCalledOnce();
    expect(fatal).toHaveBeenCalledWith(unauthorized);
    expect(errorSpy(logger)).not.toHaveBeenCalled();
  });

  it('propagates a shared-classifier wrapped 401 (cause) to fatal', async () => {
    const wrapped = Object.assign(new Error('wrapper'), {
      cause: { status: 401 },
    });
    const logger = gatewayLogger();
    const { pipeline } = buildPipeline(wrapped, logger);
    const { client, fatal } = installGateway(pipeline, logger);
    client.emit('messageCreate', mockMessage());
    await flush();
    expect(fatal).toHaveBeenCalledOnce();
    expect(fatal).toHaveBeenCalledWith(wrapped);
  });

  it('retains expected 404 handling: logged as a pipeline failure, never fatal', async () => {
    const notFound = Object.assign(new Error('not found'), { status: 404 });
    const logger = gatewayLogger();
    const { pipeline, inspect } = buildPipeline(notFound, logger);
    const { client, fatal } = installGateway(pipeline, logger);
    client.emit('messageCreate', mockMessage());
    await flush();
    expect(inspect).toHaveBeenCalledOnce();
    expect(fatal).not.toHaveBeenCalled();
    // The non-auth failure is surfaced through structured logging only.
    expect(errorSpy(logger)).toHaveBeenCalled();
  });

  it('routes a cause-wrapped code 401 from automod to fatal', async () => {
    const wrapped = Object.assign(new Error('wrapper'), {
      cause: { code: 401 },
    });
    const logger = gatewayLogger();
    const { pipeline } = buildPipeline(wrapped, logger);
    const { client, fatal } = installGateway(pipeline, logger);
    client.emit('messageCreate', mockMessage());
    await flush();
    expect(fatal).toHaveBeenCalledOnce();
    expect(fatal).toHaveBeenCalledWith(wrapped);
    expect(errorSpy(logger)).not.toHaveBeenCalled();
  });

  it('routes a 403 from automod to the warning path (error log), never fatal', async () => {
    const forbidden = Object.assign(new Error('forbidden'), { status: 403 });
    const logger = gatewayLogger();
    const { pipeline, inspect } = buildPipeline(forbidden, logger);
    const { client, fatal } = installGateway(pipeline, logger);
    client.emit('messageCreate', mockMessage());
    await flush();
    expect(inspect).toHaveBeenCalledOnce();
    expect(fatal).not.toHaveBeenCalled();
    expect(errorSpy(logger)).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'logging.pipeline.automod_create_failed',
        errorName: 'Error',
      }),
      expect.any(String),
    );
  });

  it('routes a 500 from automod to the warning path (error log), never fatal', async () => {
    const serverError = Object.assign(new Error('server error'), {
      status: 500,
    });
    const logger = gatewayLogger();
    const { pipeline, inspect } = buildPipeline(serverError, logger);
    const { client, fatal } = installGateway(pipeline, logger);
    client.emit('messageCreate', mockMessage());
    await flush();
    expect(inspect).toHaveBeenCalledOnce();
    expect(fatal).not.toHaveBeenCalled();
    expect(errorSpy(logger)).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'logging.pipeline.automod_create_failed',
        errorName: 'Error',
      }),
      expect.any(String),
    );
  });

  it('routes a cause-wrapped 401 originating from getMember to fatal via pipeline', async () => {
    // Simulates: runtime getMember rethrows wrapped 401 → evaluate propagates →
    // pipeline isUnauthorized → gateway fatal.
    const wrapped = Object.assign(new Error('member fetch failed'), {
      cause: { status: 401 },
    });
    const logger = gatewayLogger();
    const { pipeline } = buildPipeline(wrapped, logger);
    const { client, fatal } = installGateway(pipeline, logger);
    client.emit('messageCreate', mockMessage());
    await flush();
    expect(fatal).toHaveBeenCalledOnce();
    expect(fatal).toHaveBeenCalledWith(wrapped);
    expect(errorSpy(logger)).not.toHaveBeenCalled();
  });

  it('routes a cause-wrapped code-401 originating from getInvite to fatal via pipeline', async () => {
    const wrapped = Object.assign(new Error('invite fetch failed'), {
      cause: { code: 401 },
    });
    const logger = gatewayLogger();
    const { pipeline } = buildPipeline(wrapped, logger);
    const { client, fatal } = installGateway(pipeline, logger);
    client.emit('messageCreate', mockMessage());
    await flush();
    expect(fatal).toHaveBeenCalledOnce();
    expect(fatal).toHaveBeenCalledWith(wrapped);
    expect(errorSpy(logger)).not.toHaveBeenCalled();
  });
});

describe('isUnauthorized shared classifier', () => {
  it('detects direct status 401', () => {
    expect(isUnauthorized(Object.assign(new Error('x'), { status: 401 }))).toBe(
      true,
    );
  });
  it('detects direct code 401', () => {
    expect(isUnauthorized(Object.assign(new Error('x'), { code: 401 }))).toBe(
      true,
    );
  });
  it('detects cause-wrapped status 401', () => {
    expect(
      isUnauthorized(Object.assign(new Error('x'), { cause: { status: 401 } })),
    ).toBe(true);
  });
  it('detects cause-wrapped code 401', () => {
    expect(
      isUnauthorized(Object.assign(new Error('x'), { cause: { code: 401 } })),
    ).toBe(true);
  });
  it('rejects 403', () => {
    expect(isUnauthorized(Object.assign(new Error('x'), { status: 403 }))).toBe(
      false,
    );
  });
  it('rejects 500', () => {
    expect(isUnauthorized(Object.assign(new Error('x'), { status: 500 }))).toBe(
      false,
    );
  });
  it('rejects plain errors', () => {
    expect(isUnauthorized(new Error('plain'))).toBe(false);
  });
  it('rejects non-object values', () => {
    expect(isUnauthorized('string')).toBe(false);
    expect(isUnauthorized(null)).toBe(false);
    expect(isUnauthorized(undefined)).toBe(false);
  });
});

describe('runtime getMember/getInvite absence vs error contract', () => {
  const automodSettings = {
    guildId: '1',
    antiInviteStrikes: 1,
    antiReferralStrikes: 0,
    antiEveryoneStrikes: 0,
    antiCopypastaStrikes: 0,
    duplicateEnabled: false,
    duplicateStrikes: 1,
  } as never;

  const makeService = (
    getMember: AutomodDiscordPort['getMember'],
    getInvite?: AutomodDiscordPort['getInvite'],
  ) =>
    new AutomodService({
      settings: {
        getOrCreate: vi.fn().mockResolvedValue(automodSettings),
        update: vi.fn(),
      },
      punishments: { list: vi.fn().mockResolvedValue([{ threshold: 1 }]) },
      strikes: { autoModStrike: vi.fn().mockResolvedValue({ ok: true }) },
      discord: {
        deleteMessage: vi.fn().mockResolvedValue(undefined),
        getMember,
        getEffectiveMemberPermissions: vi.fn().mockResolvedValue([]),
        getBotUserId: vi.fn().mockResolvedValue('bot'),
        ...(getInvite ? { getInvite } : {}),
      },
    });

  it('getMember 10007 thrown by adapter propagates (runtime converts to null)', async () => {
    const service = makeService(() =>
      Promise.reject(
        Object.assign(new Error('Unknown Member'), { code: 10007 }),
      ),
    );
    // The service does not catch getMember errors; the runtime adapter is
    // responsible for converting 10007 → null before the service sees it.
    // If a raw 10007 leaks through, it propagates as an error.
    await expect(
      service.evaluate({
        id: 'm',
        guildId: 'g',
        channelId: 'c',
        authorId: 'u',
        content: 'discord.gg/abc',
      }),
    ).rejects.toMatchObject({ code: 10007 });
  });

  it('getMember null (absence) causes automod to skip without error', async () => {
    const service = makeService(() => Promise.resolve(null));
    const result = await service.evaluate({
      id: 'm',
      guildId: 'g',
      channelId: 'c',
      authorId: 'u',
      content: 'discord.gg/abc',
    });
    expect(result).toMatchObject({ value: { strikes: 0, deleted: false } });
  });

  it('getMember 401 propagates through evaluate to the pipeline', async () => {
    const service = makeService(() =>
      Promise.reject(Object.assign(new Error('unauthorized'), { status: 401 })),
    );
    await expect(
      service.evaluate({
        id: 'm',
        guildId: 'g',
        channelId: 'c',
        authorId: 'u',
        content: 'discord.gg/abc',
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('getInvite 10006 (Unknown Invite) → null means foreign invite violation', async () => {
    const service = makeService(
      () => Promise.resolve({ roleIds: [], canMentionEveryone: false }),
      () => {
        // Runtime adapter converts 10006 → null; simulate that contract
        return Promise.resolve(null);
      },
    );
    const result = await service.evaluate({
      id: 'm',
      guildId: 'g',
      channelId: 'c',
      authorId: 'u',
      content: 'discord.gg/abc',
    });
    // null invite = foreign/invalid → violation
    expect(result).toMatchObject({ value: { strikes: 1, deleted: true } });
  });

  it('getInvite 401 propagates through evaluate', async () => {
    const service = makeService(
      () => Promise.resolve({ roleIds: [], canMentionEveryone: false }),
      () =>
        Promise.reject(
          Object.assign(new Error('unauthorized'), { status: 401 }),
        ),
    );
    await expect(
      service.evaluate({
        id: 'm',
        guildId: 'g',
        channelId: 'c',
        authorId: 'u',
        content: 'discord.gg/abc',
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('getInvite cause-wrapped 401 propagates through evaluate', async () => {
    const service = makeService(
      () => Promise.resolve({ roleIds: [], canMentionEveryone: false }),
      () =>
        Promise.reject(
          Object.assign(new Error('wrapper'), {
            cause: { status: 401 },
          }),
        ),
    );
    await expect(
      service.evaluate({
        id: 'm',
        guildId: 'g',
        channelId: 'c',
        authorId: 'u',
        content: 'discord.gg/abc',
      }),
    ).rejects.toMatchObject({ cause: { status: 401 } });
  });

  it('getMember 403 is NOT collapsed to null — propagates as error', async () => {
    const service = makeService(() =>
      Promise.reject(Object.assign(new Error('forbidden'), { status: 403 })),
    );
    await expect(
      service.evaluate({
        id: 'm',
        guildId: 'g',
        channelId: 'c',
        authorId: 'u',
        content: 'discord.gg/abc',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('getMember 500 is NOT collapsed to null — propagates as error', async () => {
    const service = makeService(() =>
      Promise.reject(Object.assign(new Error('server error'), { status: 500 })),
    );
    await expect(
      service.evaluate({
        id: 'm',
        guildId: 'g',
        channelId: 'c',
        authorId: 'u',
        content: 'discord.gg/abc',
      }),
    ).rejects.toMatchObject({ status: 500 });
  });

  it('getMember cause-wrapped 401 propagates (not collapsed to null)', async () => {
    const service = makeService(() =>
      Promise.reject(
        Object.assign(new Error('wrapper'), { cause: { status: 401 } }),
      ),
    );
    await expect(
      service.evaluate({
        id: 'm',
        guildId: 'g',
        channelId: 'c',
        authorId: 'u',
        content: 'discord.gg/abc',
      }),
    ).rejects.toMatchObject({ cause: { status: 401 } });
  });

  it('getInvite 403 is NOT collapsed to null — propagates as error', async () => {
    const service = makeService(
      () => Promise.resolve({ roleIds: [], canMentionEveryone: false }),
      () =>
        Promise.reject(Object.assign(new Error('forbidden'), { status: 403 })),
    );
    await expect(
      service.evaluate({
        id: 'm',
        guildId: 'g',
        channelId: 'c',
        authorId: 'u',
        content: 'discord.gg/abc',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('getInvite 500 is NOT collapsed to null — propagates as error', async () => {
    const service = makeService(
      () => Promise.resolve({ roleIds: [], canMentionEveryone: false }),
      () =>
        Promise.reject(
          Object.assign(new Error('server error'), { status: 500 }),
        ),
    );
    await expect(
      service.evaluate({
        id: 'm',
        guildId: 'g',
        channelId: 'c',
        authorId: 'u',
        content: 'discord.gg/abc',
      }),
    ).rejects.toMatchObject({ status: 500 });
  });
});
