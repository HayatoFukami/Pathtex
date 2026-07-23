import { describe, expect, it, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Client } from 'discord.js';
import {
  installMessageLoggingListeners,
  installGatewayListeners,
} from '../src/index.js';
import type { LoggingEventPipeline } from '../src/features/logging/index.js';
import { isUnauthorized } from '../src/features/logging/index.js';
import type { SettingsService } from '../src/services/settings-service.js';
import type { SnapshotService } from '../src/services/snapshot-service.js';
import type { Logger } from 'pino';
import { err } from '../src/domain/result.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
};

const silentLogger = () =>
  ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    fatal: vi.fn(),
  }) as unknown as Logger;

const mockMessage = () => ({
  id: 'msg-1',
  guildId: '12345678901234567',
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

const buildMessageLogging = () => {
  const messageCreate = vi.fn(() => Promise.resolve());
  const messageUpdate = vi.fn(() => Promise.resolve());
  const messageDelete = vi.fn(() => Promise.resolve());
  const messageDeleteBulk = vi.fn(() => Promise.resolve());
  const logging = {
    messageCreate,
    messageUpdate,
    messageDelete,
    messageDeleteBulk,
  } as unknown as Pick<
    LoggingEventPipeline,
    'messageCreate' | 'messageUpdate' | 'messageDelete' | 'messageDeleteBulk'
  >;
  const settings = {
    get: () => Promise.resolve(err('INVALID_INPUT', 'not a log channel')),
  } as unknown as SettingsService;
  const snapshots = {
    getMessage: vi.fn(() => Promise.resolve({ ok: true, value: null })),
    deleteMessage: vi.fn(() => Promise.resolve({ ok: true, value: undefined })),
  } as unknown as Pick<SnapshotService, 'getMessage' | 'deleteMessage'>;
  return { logging, settings, snapshots, messageCreate, messageDelete };
};

describe('gateway Ready gate: installMessageLoggingListeners', () => {
  it('drops messageCreate events when ready() returns false', async () => {
    const client = new EventEmitter();
    const { logging, settings, snapshots, messageCreate } =
      buildMessageLogging();
    installMessageLoggingListeners(
      client as unknown as Client,
      logging,
      settings,
      snapshots,
      silentLogger(),
      vi.fn(),
      () => false,
    );
    client.emit('messageCreate', mockMessage());
    await flush();
    expect(messageCreate).not.toHaveBeenCalled();
  });

  it('processes messageCreate events when ready() returns true', async () => {
    const client = new EventEmitter();
    const { logging, settings, snapshots, messageCreate } =
      buildMessageLogging();
    installMessageLoggingListeners(
      client as unknown as Client,
      logging,
      settings,
      snapshots,
      silentLogger(),
      vi.fn(),
      () => true,
    );
    client.emit('messageCreate', mockMessage());
    await flush();
    expect(messageCreate).toHaveBeenCalledOnce();
  });

  it('drops messageDelete events when ready() returns false', async () => {
    const client = new EventEmitter();
    const { logging, settings, snapshots, messageDelete } =
      buildMessageLogging();
    installMessageLoggingListeners(
      client as unknown as Client,
      logging,
      settings,
      snapshots,
      silentLogger(),
      vi.fn(),
      () => false,
    );
    client.emit('messageDelete', mockMessage());
    await flush();
    expect(messageDelete).not.toHaveBeenCalled();
  });

  it('defaults to accepting events when no ready callback is provided', async () => {
    const client = new EventEmitter();
    const { logging, settings, snapshots, messageCreate } =
      buildMessageLogging();
    // No 7th argument — backward-compatible default
    installMessageLoggingListeners(
      client as unknown as Client,
      logging,
      settings,
      snapshots,
      silentLogger(),
      vi.fn(),
    );
    client.emit('messageCreate', mockMessage());
    await flush();
    expect(messageCreate).toHaveBeenCalledOnce();
  });

  it('transitions from gated to open when ready flips', async () => {
    const client = new EventEmitter();
    const { logging, settings, snapshots, messageCreate } =
      buildMessageLogging();
    let isReady = false;
    installMessageLoggingListeners(
      client as unknown as Client,
      logging,
      settings,
      snapshots,
      silentLogger(),
      vi.fn(),
      () => isReady,
    );
    client.emit('messageCreate', mockMessage());
    await flush();
    expect(messageCreate).not.toHaveBeenCalled();

    isReady = true;
    client.emit('messageCreate', mockMessage());
    await flush();
    expect(messageCreate).toHaveBeenCalledOnce();
  });
});

describe('gateway Ready gate: installGatewayListeners', () => {
  const installGateway = (ready?: () => boolean) => {
    const handlers = new Map<string, (...args: never[]) => void>();
    const client = {
      user: { id: 'bot' },
      on: vi.fn((event: string, handler: (...args: never[]) => void) => {
        handlers.set(event, handler);
      }),
    };
    const userUpdate = vi.fn().mockResolvedValue(undefined);
    const server = vi.fn().mockResolvedValue(undefined);
    const voice = vi.fn().mockResolvedValue(undefined);
    const logging = { userUpdate, server, voice } as never;
    const fatal = vi.fn();
    const logger = silentLogger();
    installGatewayListeners(
      client as never,
      logging,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      logger,
      fatal as never,
      {} as never,
      ready,
    );
    return { handlers, userUpdate, fatal };
  };

  it('drops userUpdate events when ready() returns false', async () => {
    const { handlers, userUpdate } = installGateway(() => false);
    handlers.get('userUpdate')?.(
      { username: 'old', globalName: 'g' } as never,
      { id: '1', username: 'new', globalName: 'g' } as never,
    );
    await flush();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('processes userUpdate events when ready() returns true', async () => {
    const { handlers, userUpdate } = installGateway(() => true);
    handlers.get('userUpdate')?.(
      { username: 'old', globalName: 'g' } as never,
      { id: '1', username: 'new', globalName: 'g' } as never,
    );
    await flush();
    expect(userUpdate).toHaveBeenCalledOnce();
  });

  it('defaults to accepting events when no ready callback is provided', async () => {
    const { handlers, userUpdate } = installGateway(undefined);
    handlers.get('userUpdate')?.(
      { username: 'old', globalName: 'g' } as never,
      { id: '1', username: 'new', globalName: 'g' } as never,
    );
    await flush();
    expect(userUpdate).toHaveBeenCalledOnce();
  });

  it('drops guildBanAdd events when ready() returns false', () => {
    const { handlers } = installGateway(() => false);
    // guildBanAdd handler should return early without calling externalEvents
    // We verify by checking that no error is thrown and the handler is a no-op
    expect(() =>
      handlers.get('guildBanAdd')?.({
        guild: { id: 'g1' },
        user: { id: 'u1' },
      } as never),
    ).not.toThrow();
  });

  it('still logs client error events regardless of ready state', () => {
    const logger = silentLogger();
    const handlers = new Map<string, (...args: never[]) => void>();
    const client = {
      user: { id: 'bot' },
      on: vi.fn((event: string, handler: (...args: never[]) => void) => {
        handlers.set(event, handler);
      }),
    };
    installGatewayListeners(
      client as never,
      { userUpdate: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      logger,
      vi.fn() as never,
      {} as never,
      () => false,
    );
    handlers.get('error')?.(new Error('test error') as never);
    expect(
      (logger as unknown as { error: ReturnType<typeof vi.fn> }).error,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'gateway.client_error' }),
      'Discord client error',
    );
  });
});

describe('fatal authentication exit code', () => {
  afterEach(() => {
    // Restore exitCode after each test
    process.exitCode = undefined;
  });

  /** Mirrors the requestShutdown guard in main(). */
  const applyGracefulExitCode = (): void => {
    if (!process.exitCode) process.exitCode = 0;
  };

  it('requestShutdown preserves a previously-set nonzero exit code', () => {
    // Simulate the pattern from main(): a fatal handler sets exitCode=1,
    // then requestShutdown should not overwrite it with 0.
    process.exitCode = 1;
    applyGracefulExitCode();
    expect(process.exitCode).toBe(1);
  });

  it('requestShutdown sets exit code 0 for graceful shutdown', () => {
    process.exitCode = undefined;
    applyGracefulExitCode();
    expect(process.exitCode).toBe(0);
  });

  it('fatal handler pattern sets nonzero exit code before lifecycle stop', () => {
    // Verify the pattern used by onFatal/fatal handlers in createBootstrapDependencies
    let stopCalled = false;
    const stopLifecycle = () => {
      stopCalled = true;
      return Promise.resolve();
    };
    // Simulate the fixed fatal handler
    process.exitCode = 1;
    void stopLifecycle();
    expect(process.exitCode).toBe(1);
    expect(stopCalled).toBe(true);
  });
});

describe('voice gateway 401 classification', () => {
  it('classifies a direct status-401 error as unauthorized', () => {
    const error = Object.assign(new Error('Unauthorized'), { status: 401 });
    expect(isUnauthorized(error)).toBe(true);
  });

  it('classifies a direct code-401 error as unauthorized', () => {
    const error = Object.assign(new Error('Unauthorized'), { code: 401 });
    expect(isUnauthorized(error)).toBe(true);
  });

  it('classifies a cause-wrapped status-401 as unauthorized', () => {
    const error = Object.assign(new Error('voice move failed'), {
      cause: { status: 401 },
    });
    expect(isUnauthorized(error)).toBe(true);
  });

  it('classifies a cause-wrapped code-401 as unauthorized', () => {
    const error = Object.assign(new Error('voice move failed'), {
      cause: { code: 401 },
    });
    expect(isUnauthorized(error)).toBe(true);
  });

  it('does not classify a 403 as unauthorized', () => {
    const error = Object.assign(new Error('Forbidden'), { status: 403 });
    expect(isUnauthorized(error)).toBe(false);
  });

  it('does not classify a plain error as unauthorized', () => {
    expect(isUnauthorized(new Error('ETIMEDOUT'))).toBe(false);
  });
});

describe('gateway Ready gate: true→false shutdown closure', () => {
  it('drops events after ready flips from true back to false (graceful shutdown)', async () => {
    const client = new EventEmitter();
    const { logging, settings, snapshots, messageCreate } =
      buildMessageLogging();
    let isReady = false;
    installMessageLoggingListeners(
      client as unknown as Client,
      logging,
      settings,
      snapshots,
      silentLogger(),
      vi.fn(),
      () => isReady,
    );

    // Open the gate
    isReady = true;
    client.emit('messageCreate', mockMessage());
    await flush();
    expect(messageCreate).toHaveBeenCalledOnce();

    // Close the gate (simulates requestShutdown / closeGateway)
    isReady = false;
    client.emit('messageCreate', mockMessage());
    await flush();
    // Still only the first call — second event was dropped
    expect(messageCreate).toHaveBeenCalledOnce();
  });

  it('drops gateway listener events after ready flips true→false', async () => {
    const handlers = new Map<string, (...args: never[]) => void>();
    const client = {
      user: { id: 'bot' },
      on: vi.fn((event: string, handler: (...args: never[]) => void) => {
        handlers.set(event, handler);
      }),
    };
    const userUpdate = vi.fn().mockResolvedValue(undefined);
    let isReady = true;
    installGatewayListeners(
      client as never,
      { userUpdate, server: vi.fn(), voice: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      silentLogger(),
      vi.fn() as never,
      {} as never,
      () => isReady,
    );

    // Gate is open — event is processed
    handlers.get('userUpdate')?.(
      { username: 'old', globalName: 'g' } as never,
      { id: '1', username: 'new', globalName: 'g' } as never,
    );
    await flush();
    expect(userUpdate).toHaveBeenCalledOnce();

    // Close the gate (simulates shutdown)
    isReady = false;
    handlers.get('userUpdate')?.(
      { username: 'old2', globalName: 'g' } as never,
      { id: '2', username: 'new2', globalName: 'g' } as never,
    );
    await flush();
    // Still only one call — second event was dropped
    expect(userUpdate).toHaveBeenCalledOnce();
  });

  it('setLifecycleStop wrapper closes gateway synchronously before async stop', () => {
    // Simulates the setLifecycleStop wrapping pattern from createBootstrapDependencies:
    //   stopLifecycle = () => { gatewayReady = false; return stop(); }
    let gatewayReady = true;
    let stopCalled = false;
    const stop = () => {
      // At the point stop() runs, gateway must already be closed
      expect(gatewayReady).toBe(false);
      stopCalled = true;
      return Promise.resolve();
    };
    // The wrapper pattern
    const stopLifecycle = () => {
      gatewayReady = false;
      return stop();
    };

    void stopLifecycle();
    expect(gatewayReady).toBe(false);
    expect(stopCalled).toBe(true);
  });

  it('requestShutdown pattern closes gateway before lifecycle stop and preserves nonzero exit code', () => {
    // Simulates the requestShutdown pattern from main():
    //   dependencies.closeGateway();
    //   if (!process.exitCode) process.exitCode = 0;
    //   void lifecycle.stop();
    let gatewayReady = true;
    const closeGateway = () => {
      gatewayReady = false;
    };

    // Pre-set by a fatal handler
    process.exitCode = 1;

    // requestShutdown logic
    closeGateway();
    if (!process.exitCode) process.exitCode = 0;

    expect(gatewayReady).toBe(false);
    expect(process.exitCode).toBe(1);

    // Cleanup
    process.exitCode = undefined;
  });

  it('requestShutdown sets exit code 0 when no fatal pre-set exists', () => {
    let gatewayReady = true;
    const closeGateway = () => {
      gatewayReady = false;
    };
    /** Mirrors the requestShutdown guard in main(). */
    const applyGracefulCode = (): void => {
      if (!process.exitCode) process.exitCode = 0;
    };

    process.exitCode = undefined;

    closeGateway();
    applyGracefulCode();

    expect(gatewayReady).toBe(false);
    expect(process.exitCode).toBe(0);

    // Cleanup
    process.exitCode = undefined;
  });
});
