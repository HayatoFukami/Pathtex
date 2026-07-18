import { describe, expect, it, vi } from 'vitest';
import { createJobScheduler } from '../src/runtime/scheduler.js';
import type {
  JobDto,
  SchedulerRepository,
} from '../src/repositories/contracts.js';
import { createPermissionPolicy } from '../src/runtime/policy.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { createPingCommand } from '../src/commands/ping.js';
import { installInteractionIntake } from '../src/runtime/intake.js';
import type { Logger } from 'pino';
import { EventEmitter } from 'node:events';
import { ConfigurationOverviewError } from '../src/features/configuration/service.js';

const job = {
  id: '00000000-0000-4000-8000-000000000001',
  guildId: '12345678901234567',
  type: 'UNBAN',
  payload: {},
  executeAt: new Date(),
  status: 'RUNNING',
  attempts: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
} as JobDto;
const repository = (): SchedulerRepository => ({
  scheduleReplacing: vi.fn(),
  cancelTarget: vi.fn(),
  findPending: vi.fn(),
  getStatus: vi.fn(),
  recoverStale: vi.fn(() => Promise.resolve(2)),
  claimDue: vi.fn(() => Promise.resolve([job])),
  complete: vi.fn(() => Promise.resolve(true)),
  fail: vi.fn(() => Promise.resolve(true)),
});

describe('runtime recovery and scheduler', () => {
  it('recovers stale jobs and completes successfully dispatched due work', async () => {
    const repo = repository();
    const dispatch = vi.fn(() => Promise.resolve());
    const scheduler = createJobScheduler(
      repo,
      { available: true, supports: () => true, dispatch },
      'worker',
      60_000,
    );
    expect(await scheduler.recover()).toBe(2);
    await scheduler.start();
    await scheduler.stop();
    expect(dispatch).toHaveBeenCalledWith(job);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repo.complete).toHaveBeenCalledWith(job.id, 'worker');
  });

  it('marks dispatch failures retryable without losing the claimed job', async () => {
    const repo = repository();
    const scheduler = createJobScheduler(
      repo,
      {
        available: true,
        supports: () => true,
        dispatch: () => Promise.reject(new Error('network')),
      },
      'worker',
      60_000,
    );
    await scheduler.start();
    await scheduler.stop();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repo.fail).toHaveBeenCalledWith(job.id, 'worker', 'network', true);
  });

  it('does not claim while the dispatcher is unavailable', async () => {
    const repo = repository();
    const scheduler = createJobScheduler(
      repo,
      {
        available: false,
        supports: () => false,
        dispatch: () => Promise.resolve(),
      },
      'worker',
    );
    await scheduler.start();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repo.claimDue).not.toHaveBeenCalled();
  });

  it('releases unsupported work without retrying it', async () => {
    const repo = repository();
    const scheduler = createJobScheduler(
      repo,
      {
        available: true,
        supports: () => false,
        dispatch: () => Promise.resolve(),
      },
      'worker',
    );
    await scheduler.start();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repo.fail).toHaveBeenCalledWith(
      job.id,
      'worker',
      expect.stringContaining('Unsupported'),
      false,
    );
  });

  it('bounds scheduler stop while dispatch ignores cancellation', async () => {
    const repo = repository();
    const scheduler = createJobScheduler(
      repo,
      {
        available: true,
        supports: () => true,
        dispatch: () => new Promise<void>(() => undefined),
      },
      'worker',
      60_000,
      undefined,
      5,
    );
    void scheduler.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await scheduler.stop();
  });

  it('requires native permission and verifies the MOD role before fallback', async () => {
    const roleExists = vi.fn(() => Promise.resolve(true));
    const clear = vi.fn(() => Promise.resolve());
    const policy = createPermissionPolicy({
      getModRoleId: () => Promise.resolve('role'),
      roleExists,
      clearDeletedModRole: clear,
    });
    const interaction = {
      guildId: '12345678901234567',
      member: { roles: ['role'] },
      memberPermissions: {
        has: (permission: string) => permission === 'KickMembers',
      },
    } as unknown as ChatInputCommandInteraction;
    const command = {
      authorizationPolicy: 'MODERATOR',
      actorNativePermissions: ['BanMembers'],
      requiredBotPermissions: [],
    } as unknown as import('../src/commands/contract.js').CommandDefinition;
    expect(await policy.authorize(interaction, command)).toBe(true);
    expect(roleExists).toHaveBeenCalledOnce();
    const deleted = createPermissionPolicy({
      getModRoleId: () => Promise.resolve('role'),
      roleExists: () => Promise.resolve(false),
      clearDeletedModRole: clear,
    });
    expect(await deleted.authorize(interaction, command)).toBe(false);
    expect(clear).toHaveBeenCalledWith('12345678901234567', 'role');
  });

  it('reports a successful ping and fails closed at the database deadline', async () => {
    const reply = vi.fn((response: { content?: string }) => {
      void response;
      return Promise.resolve();
    });
    const interaction = { reply } as unknown as ChatInputCommandInteraction;
    await createPingCommand({
      health: () => Promise.resolve(true),
      gatewayPing: () => 12,
    }).execute({ interaction, receivedAt: Date.now() });
    const successResponse = reply.mock.calls[0]?.[0] as
      { content?: string } | undefined;
    expect(successResponse?.content).toContain('データベース: 正常');

    vi.useFakeTimers();
    try {
      const timedReply = vi.fn((response: { content?: string }) => {
        void response;
        return Promise.resolve();
      });
      const pending = createPingCommand({
        health: () => new Promise<boolean>(() => undefined),
      }).execute({
        interaction: {
          reply: timedReply,
        } as unknown as ChatInputCommandInteraction,
        receivedAt: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(1_500);
      await pending;
      const timeoutResponse = timedReply.mock.calls[0]?.[0] as
        { content?: string } | undefined;
      expect(timeoutResponse?.content).toContain(
        'データベース: 利用できません',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs expired interaction tokens without attempting a second response', async () => {
    const client = new EventEmitter();
    const reply = vi.fn(() => Promise.resolve());
    const errorLog = vi.fn();
    const logger = { error: errorLog } as unknown as Logger;
    const policy = {
      authorize: () => Promise.resolve(true),
      missingBotPermissions: () => [],
    };
    const command = {
      name: 'test',
      guildOnly: true,
      data: {
        type: 1,
        name: 'test',
        description: 'test',
        contexts: [0],
        integration_types: [0],
      },
      requiredBotPermissions: [],
      actorNativePermissions: [],
      authorizationPolicy: 'PUBLIC',
      deferMode: 'NONE',
      execute: () =>
        Promise.reject(Object.assign(new Error('expired'), { code: 10062 })),
    } as unknown as import('../src/commands/contract.js').CommandDefinition;
    installInteractionIntake(
      client as unknown as import('discord.js').Client,
      [command],
      { ready: () => true, permissionPolicy: policy, logger },
    );
    client.emit('interactionCreate', {
      id: 'interaction',
      commandName: 'test',
      guildId: 'guild',
      channelId: 'channel',
      user: { id: 'user' },
      isChatInputCommand: () => true,
      inGuild: () => true,
      replied: false,
      deferred: false,
      reply,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reply).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({ errorName: 'expired_interaction_token' }),
      'Interaction failed',
    );
  });

  it('logs safe overview failure diagnostics while preserving the error response', async () => {
    const client = new EventEmitter();
    const reply = vi.fn(() => Promise.resolve());
    const errorLog = vi.fn();
    const logger = { error: errorLog } as unknown as Logger;
    const policy = {
      authorize: () => Promise.resolve(true),
      missingBotPermissions: () => [],
    };
    const cause = new Error('database password=top-secret');
    const command = {
      name: 'settings',
      guildOnly: true,
      data: {
        type: 1,
        name: 'settings',
        description: 'settings',
        contexts: [0],
        integration_types: [0],
      },
      requiredBotPermissions: [],
      actorNativePermissions: [],
      authorizationPolicy: 'PUBLIC',
      deferMode: 'NONE',
      execute: () =>
        Promise.reject(new ConfigurationOverviewError('automod', cause)),
    } as unknown as import('../src/commands/contract.js').CommandDefinition;
    installInteractionIntake(
      client as unknown as import('discord.js').Client,
      [command],
      { ready: () => true, permissionPolicy: policy, logger },
    );
    client.emit('interactionCreate', {
      id: 'interaction-settings',
      commandName: 'settings',
      guildId: 'guild',
      channelId: 'channel',
      user: { id: 'user' },
      isChatInputCommand: () => true,
      inGuild: () => true,
      replied: false,
      deferred: false,
      reply,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(reply).toHaveBeenCalledOnce();
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        errorName: 'ConfigurationOverviewError',
        errorMessage: 'Settings overview dependency failed: automod',
        dependency: 'automod',
        causeName: 'Error',
        causeMessage: 'database [REDACTED]',
      }),
      'Interaction failed',
    );
    expect(JSON.stringify(errorLog.mock.calls[0]?.[0])).not.toContain(
      'top-secret',
    );
  });

  it('routes cfg1 buttons to configuration without changing audit routing', async () => {
    const client = new EventEmitter();
    const reply = vi.fn(() => Promise.resolve());
    const configuration = vi.fn(() => Promise.resolve(true));
    const modal = vi.fn(() => Promise.resolve(true));
    const tools = vi.fn(() => Promise.resolve(true));
    const policy = {
      authorize: () => Promise.resolve(true),
      missingBotPermissions: () => [],
    };
    installInteractionIntake(
      client as unknown as import('discord.js').Client,
      [],
      {
        ready: () => true,
        permissionPolicy: policy,
        onConfigurationComponent: configuration,
        onConfigurationModal: modal,
        onComponent: tools,
      },
    );
    const component = (customId: string) => ({
      id: customId,
      customId,
      guildId: 'guild',
      user: { id: 'user' },
      isMessageComponent: () => true,
      isModalSubmit: () => false,
      isButton: () => true,
      isChatInputCommand: () => false,
      inGuild: () => true,
      reply,
      message: { createdTimestamp: Date.now() },
    });
    const select = {
      ...component('cfg1.channel-message.any'),
      isButton: () => false,
      isAnySelectMenu: () => true,
      values: ['channel'],
    };
    const invalidSelect = {
      ...select,
      customId: 'other.channel-message.any',
    };
    const modalInteraction = {
      ...component('cfg1.timezone-submit.any'),
      isMessageComponent: () => false,
      isModalSubmit: () => true,
      fields: { getTextInputValue: () => 'UTC' },
    };
    client.emit('interactionCreate', component('cfg1.refresh.any'));
    client.emit('interactionCreate', select);
    client.emit('interactionCreate', invalidSelect);
    client.emit('interactionCreate', modalInteraction);
    client.emit('interactionCreate', component('audit:next:token:user'));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(configuration).toHaveBeenCalledTimes(2);
    expect(modal).toHaveBeenCalledOnce();
    expect(tools).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
  });

  it('treats Discord HTTP 401 as fatal intake shutdown', async () => {
    const client = new EventEmitter();
    const onFatal = vi.fn();
    const reply = vi.fn((response: { content?: string }) => {
      void response;
      return Promise.resolve();
    });
    const policy = {
      authorize: () => Promise.resolve(true),
      missingBotPermissions: () => [],
    };
    const command = {
      name: 'test401',
      guildOnly: true,
      data: {
        type: 1,
        name: 'test401',
        description: 'test',
        contexts: [0],
        integration_types: [0],
      },
      requiredBotPermissions: [],
      actorNativePermissions: [],
      authorizationPolicy: 'PUBLIC',
      deferMode: 'NONE',
      execute: () =>
        Promise.reject(
          Object.assign(new Error('unauthorized'), { status: 401 }),
        ),
    } as unknown as import('../src/commands/contract.js').CommandDefinition;
    installInteractionIntake(
      client as unknown as import('discord.js').Client,
      [command],
      { ready: () => true, permissionPolicy: policy, onFatal },
    );
    client.emit('interactionCreate', {
      id: 'interaction401',
      commandName: 'test401',
      guildId: 'guild',
      channelId: 'channel',
      user: { id: 'user' },
      isChatInputCommand: () => true,
      inGuild: () => true,
      replied: false,
      deferred: false,
      reply,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onFatal).toHaveBeenCalledWith(expect.any(Error));
    expect(reply).not.toHaveBeenCalled();
  });

  it('uses matching native permission without looking up MOD role, rejects mismatches, and never substitutes MOD for MANAGE_GUILD', async () => {
    const getModRoleId = vi.fn(() => Promise.resolve('mod'));
    const settings = {
      getModRoleId,
      roleExists: vi.fn(() => Promise.resolve(true)),
      clearDeletedModRole: vi.fn(() => Promise.resolve()),
    };
    const policy = createPermissionPolicy(settings);
    const interaction = (permission: string, roles: string[] = ['mod']) =>
      ({
        guildId: '12345678901234567',
        member: { roles },
        memberPermissions: { has: (value: string) => value === permission },
      }) as unknown as ChatInputCommandInteraction;
    const command = (
      authorizationPolicy: 'MODERATOR' | 'MANAGE_GUILD',
      native: string[],
    ) =>
      ({
        authorizationPolicy,
        actorNativePermissions: native,
        requiredBotPermissions: [],
      }) as unknown as import('../src/commands/contract.js').CommandDefinition;
    expect(
      await policy.authorize(
        interaction('KickMembers'),
        command('MODERATOR', ['KickMembers']),
      ),
    ).toBe(true);
    expect(getModRoleId).not.toHaveBeenCalled();
    getModRoleId.mockClear();
    expect(
      await policy.authorize(
        interaction('BanMembers', []),
        command('MODERATOR', ['KickMembers']),
      ),
    ).toBe(false);
    expect(getModRoleId).toHaveBeenCalledOnce();
    getModRoleId.mockClear();
    expect(
      await policy.authorize(
        interaction('None'),
        command('MANAGE_GUILD', ['ManageGuild']),
      ),
    ).toBe(false);
    expect(getModRoleId).not.toHaveBeenCalled();
  });
});
