import { describe, expect, it, vi } from 'vitest';
import {
  raidDisableAt,
  raidWindowCount,
  shouldActivateRaid,
} from '../src/domain/raid.js';
import { RaidService } from '../src/features/raid/service.js';
import { raidCommands } from '../src/features/raid/commands.js';
import { SettingsService } from '../src/services/settings-service.js';

describe('raid sliding window', () => {
  it('counts the inclusive rolling window', () => {
    expect(
      raidWindowCount({
        timestamps: [0, 9_999, 10_000, 10_001],
        now: 10_001,
        windowSeconds: 10,
      }),
    ).toEqual({ ok: true, value: 3 });
    expect(shouldActivateRaid(3, 3)).toEqual({ ok: true, value: true });
  });

  it('uses the last join plus the fixed idle period', () => {
    expect(raidDisableAt(5_000)).toEqual({ ok: true, value: 125_000 });
  });

  it('preserves enabled state when changing thresholds', async () => {
    const update = vi.fn((_guild: string, patch: Record<string, unknown>) =>
      Promise.resolve(patch),
    );
    const service = new RaidService({
      automod: { getOrCreate: vi.fn(), update },
      settings: {},
      repository: {
        recordJoin: vi.fn(() => Promise.resolve()),
      },
      scheduler: {},
      moderation: {},
      cases: {},
      discord: {},
    } as never);
    await service.setAutoRaid('12345678901234567', undefined, 20, 30);
    expect(update).toHaveBeenCalledWith('12345678901234567', {
      autoRaidJoinCount: 20,
      autoRaidWindowSeconds: 30,
    });
  });

  it('restores verification and records/logs automatic OFF', async () => {
    const settings = {
      get: vi.fn(() =>
        Promise.resolve({
          ok: true,
          value: { raidModeEnabled: true, raidModeSource: 'AUTO' },
        }),
      ),
      invalidate: vi.fn(),
    };
    const modlog = {
      write: vi.fn(() => Promise.resolve(undefined)),
      writeCase: vi.fn(() => Promise.resolve(undefined)),
    };
    const discord = {
      getVerificationLevel: vi.fn(() => Promise.resolve(3)),
      setVerificationLevel: vi.fn(() => Promise.resolve(undefined)),
      getBotUserId: vi.fn(() => Promise.resolve('12345678901234567')),
    };
    const service = new RaidService({
      settings,
      repository: {
        disableAutoIfIdle: vi.fn(() =>
          Promise.resolve({
            disabled: true,
            nextAt: null,
            case: { id: 'case-id' },
            restoreLevel: 1,
          }),
        ),
      },
      discord,
      modlog,
      automod: {},
      scheduler: {},
      moderation: {},
    } as never);
    await service.disableJob('12345678901234567', new Date());
    expect(discord.setVerificationLevel).toHaveBeenCalledWith(
      '12345678901234567',
      1,
      'AutoRaid自動解除',
    );
    expect(modlog.writeCase).toHaveBeenCalledWith(
      expect.any(String),
      'case-id',
    );
  });

  it('declares Manage Guild for AutoRaid configuration', () => {
    const auto = raidCommands({} as never).find(
      (command) => command.name === 'autoraidmode',
    );
    expect(auto?.authorizationPolicy).toBe('MANAGE_GUILD');
    expect(auto?.actorNativePermissions).toEqual([1n << 5n]);
    expect(
      (auto?.data as { default_member_permissions?: string })
        .default_member_permissions,
    ).toBe('32');
    expect(auto?.requiredBotPermissions).toEqual([]);
    const raid = raidCommands({} as never).find(
      (command) => command.name === 'raidmode',
    );
    expect(raid?.requiredBotPermissions).toEqual([]);
  });

  it('passes no enabled flag for autoraid set and checks action permissions at runtime', async () => {
    const setAutoRaid = vi.fn(() => Promise.resolve({ ok: true, value: {} }));
    const service = { setAutoRaid, status: vi.fn() };
    const command = raidCommands(service as never).find(
      (item) => item.name === 'autoraidmode',
    );
    const interaction = {
      guildId: '12345678901234567',
      options: {
        getSubcommand: () => 'set',
        getInteger: (name: string) => (name === 'joins' ? 20 : 30),
      },
      editReply: vi.fn(),
      user: { id: '12345678901234567' },
    };
    await command?.execute({ interaction } as never);
    expect(setAutoRaid).toHaveBeenCalledWith(
      '12345678901234567',
      undefined,
      20,
      30,
    );
  });

  const lockdownService = (overrides: Record<string, unknown> = {}) => {
    const execute = vi.fn(() =>
      Promise.resolve({
        ok: true,
        value: {
          action: 'KICK',
          outcomes: [{ targetId: '22345678901234567', ok: true }],
        },
      }),
    );
    const service = new RaidService({
      automod: {
        getOrCreate: vi.fn(() =>
          Promise.resolve({
            autoRaidEnabled: false,
            autoRaidJoinCount: 10,
            autoRaidWindowSeconds: 10,
          }),
        ),
      },
      settings: {
        get: vi.fn(() =>
          Promise.resolve({
            ok: true,
            value: { raidModeEnabled: true, raidModeSource: 'MANUAL' },
          }),
        ),
      },
      repository: {
        recordJoin: vi.fn(() => Promise.resolve()),
      },
      scheduler: {},
      moderation: { execute },
      cases: {},
      discord: {
        getBotUserId: vi.fn(() => Promise.resolve('12345678901234567')),
        getGuildName: vi.fn(() => Promise.resolve('guild')),
        sendDm: vi.fn(() => Promise.resolve()),
      },
      ...overrides,
    } as never);
    return { service, execute };
  };

  it('passes the joining member identity resolved from event context to Kick', async () => {
    const resolver = {
      resolve: vi.fn((_guild: string, userId: string) =>
        Promise.resolve({ userId, displayName: 'joined member' }),
      ),
    };
    const { service, execute } = lockdownService({
      targetIdentityResolver: resolver,
    });
    await service.memberAdd({
      guildId: '12345678901234567',
      userId: '22345678901234567',
      isBot: false,
      displayName: 'joined member',
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [
          {
            id: '22345678901234567',
            identity: {
              userId: '22345678901234567',
              displayName: 'joined member',
            },
          },
        ],
      }),
      'KICK',
      expect.anything(),
    );
  });

  it('passes a fallback identity when resolving the joining member fails', async () => {
    const resolver = {
      resolve: vi.fn(() => Promise.reject(new Error('lookup failed'))),
    };
    const { service, execute } = lockdownService({
      targetIdentityResolver: resolver,
    });
    await service.memberAdd({
      guildId: '12345678901234567',
      userId: '22345678901234567',
      isBot: false,
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [
          {
            id: '22345678901234567',
            identity: {
              userId: '22345678901234567',
              displayName: '不明なユーザー',
            },
          },
        ],
      }),
      'KICK',
      expect.anything(),
    );
  });

  it('propagates a fatal resolver 401', async () => {
    const resolver = {
      resolve: vi.fn(() =>
        Promise.reject(
          Object.assign(new Error('unauthorized'), { status: 401 }),
        ),
      ),
    };
    const { service, execute } = lockdownService({
      targetIdentityResolver: resolver,
    });
    await expect(
      service.memberAdd({
        guildId: '12345678901234567',
        userId: '22345678901234567',
        isBot: false,
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps the identity on a failed Kick outcome', async () => {
    const execute = vi.fn(() =>
      Promise.resolve({
        ok: true,
        value: {
          action: 'KICK',
          outcomes: [
            {
              targetId: '22345678901234567',
              ok: false,
              code: 'DISCORD_API_ERROR',
              identity: {
                userId: '22345678901234567',
                displayName: 'joined member',
              },
            },
          ],
        },
      }),
    );
    const { service } = lockdownService({ moderation: { execute } });
    await service.memberAdd({
      guildId: '12345678901234567',
      userId: '22345678901234567',
      isBot: false,
      identity: {
        userId: '22345678901234567',
        displayName: 'joined member',
      },
    });
    expect(await execute.mock.results[0]?.value).toMatchObject({
      value: {
        outcomes: [
          {
            ok: false,
            identity: { displayName: 'joined member' },
          },
        ],
      },
    });
  });
});

describe('raid state integrity', () => {
  const GUILD = '12345678901234567';
  const ACTOR = '12345678901234568';
  const baseSettings = (overrides: Record<string, unknown> = {}) => ({
    guildId: GUILD,
    timezone: 'UTC',
    raidModeEnabled: false,
    raidVerificationChanged: false,
    nextCaseNumber: 1,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  });
  const httpError = (status: number, message = 'discord error') =>
    Promise.reject(Object.assign(new Error(message), { status }));

  it('invalidates the cache before raising verification and leaves ownership unconfirmed on non-auth failure', async () => {
    let raidModeEnabled = false;
    const settings = new SettingsService({
      getOrCreate: vi.fn(() =>
        Promise.resolve(baseSettings({ raidModeEnabled })),
      ),
    } as never);
    await settings.get(GUILD); // prime the cache with the pre-raid state
    const invalidateSpy = vi.spyOn(settings, 'invalidate');
    const activateManual = vi.fn(() => {
      raidModeEnabled = true;
      return Promise.resolve({
        activated: true,
        count: 0,
        settings: baseSettings({
          raidModeEnabled: true,
          verificationLevelBeforeRaid: 1,
        }),
        case: { id: 'case-on' },
      });
    });
    const markVerificationRaised = vi.fn(() =>
      Promise.resolve(
        baseSettings({ raidModeEnabled: true, raidVerificationChanged: true }),
      ),
    );
    const setVerificationLevel = vi.fn(() => httpError(500));
    const logger = { warn: vi.fn() };
    const service = new RaidService({
      settings,
      repository: { activateManual, markVerificationRaised },
      automod: {},
      scheduler: {},
      moderation: {},
      discord: {
        getVerificationLevel: vi.fn(() => Promise.resolve(1)),
        setVerificationLevel,
        getBotUserId: vi.fn(() => Promise.resolve(ACTOR)),
      },
      modlog: { writeCase: vi.fn(() => Promise.resolve()) },
      logger,
    } as never);

    const result = await service.on(GUILD, ACTOR, 'raid');

    expect(result.ok).toBe(true); // non-auth failure swallowed, no rollback
    expect(activateManual).toHaveBeenCalledTimes(1);
    expect(invalidateSpy.mock.invocationCallOrder[0]).toBeLessThan(
      setVerificationLevel.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    // Ownership is claimed only after a successful raise.
    expect(markVerificationRaised).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled(); // operational warning emitted
    // The cache was invalidated before the failing Discord call, so joins
    // observe the persisted ON state even though verification failed.
    const fresh = await settings.get(GUILD);
    expect(fresh.ok && fresh.value.raidModeEnabled).toBe(true);
  });

  it('claims verification ownership only after a successful raise', async () => {
    const settings = {
      get: vi.fn(() => Promise.resolve({ ok: true, value: baseSettings() })),
      invalidate: vi.fn(),
    };
    const activateManual = vi.fn(() =>
      Promise.resolve({
        activated: true,
        count: 0,
        settings: baseSettings({ raidModeEnabled: true }),
        case: { id: 'case-on' },
      }),
    );
    const markVerificationRaised = vi.fn(() =>
      Promise.resolve(
        baseSettings({ raidModeEnabled: true, raidVerificationChanged: true }),
      ),
    );
    const setVerificationLevel = vi.fn(() => Promise.resolve());
    const service = new RaidService({
      settings,
      repository: { activateManual, markVerificationRaised },
      automod: {},
      scheduler: {},
      moderation: {},
      discord: {
        getVerificationLevel: vi.fn(() => Promise.resolve(1)),
        setVerificationLevel,
        getBotUserId: vi.fn(() => Promise.resolve(ACTOR)),
      },
      modlog: { writeCase: vi.fn(() => Promise.resolve()) },
    } as never);

    const result = await service.on(GUILD, ACTOR, 'raid');

    expect(result.ok).toBe(true);
    // The prior level is captured for the activation...
    expect(activateManual).toHaveBeenCalledWith(
      expect.objectContaining({
        verificationLevelBeforeRaid: 1,
        changed: true,
      }),
    );
    // ...and ownership is confirmed only after the raise succeeds.
    expect(setVerificationLevel).toHaveBeenCalledWith(GUILD, 3, 'raid');
    expect(markVerificationRaised).toHaveBeenCalledWith(GUILD);
  });

  it('propagates a 401 from raising verification on activation without claiming ownership or rolling back', async () => {
    const settings = {
      get: vi.fn(() => Promise.resolve({ ok: true, value: baseSettings() })),
      invalidate: vi.fn(),
    };
    const activateManual = vi.fn(() =>
      Promise.resolve({
        activated: true,
        count: 0,
        settings: baseSettings({ raidModeEnabled: true }),
        case: { id: 'case-on' },
      }),
    );
    const markVerificationRaised = vi.fn();
    const service = new RaidService({
      settings,
      repository: { activateManual, markVerificationRaised },
      automod: {},
      scheduler: {},
      moderation: {},
      discord: {
        getVerificationLevel: vi.fn(() => Promise.resolve(1)),
        setVerificationLevel: vi.fn(() => httpError(401, 'unauthorized')),
        getBotUserId: vi.fn(() => Promise.resolve(ACTOR)),
      },
    } as never);

    await expect(service.on(GUILD, ACTOR, 'raid')).rejects.toMatchObject({
      status: 401,
    });
    expect(activateManual).toHaveBeenCalledTimes(1); // persisted, no rollback
    expect(markVerificationRaised).not.toHaveBeenCalled();
  });

  const autoActivationService = (setVerificationLevel: () => Promise<void>) => {
    const execute = vi.fn(() =>
      Promise.resolve({ ok: true, value: { action: 'KICK', outcomes: [] } }),
    );
    const schedule = vi.fn(() => Promise.resolve({ ok: true, value: {} }));
    const recordJoinAndEvaluate = vi.fn(() =>
      Promise.resolve({
        activated: true,
        count: 10,
        case: { id: 'case-auto' },
      }),
    );
    const markVerificationRaised = vi.fn(() =>
      Promise.resolve(baseSettings({ raidModeEnabled: true })),
    );
    const invalidate = vi.fn();
    const service = new RaidService({
      automod: {
        getOrCreate: vi.fn(() =>
          Promise.resolve({
            autoRaidEnabled: true,
            autoRaidJoinCount: 10,
            autoRaidWindowSeconds: 10,
          }),
        ),
      },
      settings: {
        get: vi.fn(() =>
          Promise.resolve({
            ok: true,
            value: { raidModeEnabled: true, raidModeSource: 'AUTO' },
          }),
        ),
        invalidate,
      },
      repository: {
        recordJoinAndEvaluate,
        recordJoin: vi.fn(() => Promise.resolve()),
        markVerificationRaised,
      },
      scheduler: { schedule },
      moderation: { execute },
      discord: {
        getVerificationLevel: vi.fn(() => Promise.resolve(1)),
        setVerificationLevel: vi.fn(setVerificationLevel),
        getBotUserId: vi.fn(() => Promise.resolve(ACTOR)),
        getGuildName: vi.fn(() => Promise.resolve('guild')),
        sendDm: vi.fn(() => Promise.resolve()),
      },
    } as never);
    return { service, execute, schedule, invalidate, markVerificationRaised };
  };

  it('still kicks on auto activation when raising verification fails non-auth and never schedules from the service', async () => {
    const { service, execute, schedule, invalidate, markVerificationRaised } =
      autoActivationService(() => httpError(500));
    await expect(
      service.memberAdd({
        guildId: GUILD,
        userId: '22345678901234567',
        isBot: false,
      }),
    ).resolves.toBeUndefined();
    expect(invalidate).toHaveBeenCalledWith(GUILD);
    expect(markVerificationRaised).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: GUILD }),
      'KICK',
      expect.anything(),
    );
    // Automatic disable-deadline extension lives in the locked repository path.
    expect(schedule).not.toHaveBeenCalled();
  });

  it('propagates a 401 from raising verification on auto activation and skips the kick', async () => {
    const { service, execute } = autoActivationService(() =>
      httpError(401, 'unauthorized'),
    );
    await expect(
      service.memberAdd({
        guildId: GUILD,
        userId: '22345678901234567',
        isBot: false,
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('invalidates the cache before restoring verification on auto disable and keeps OFF processing on non-auth failure', async () => {
    const order: string[] = [];
    const settings = {
      get: vi.fn(() =>
        Promise.resolve({
          ok: true,
          value: { raidModeEnabled: true, raidModeSource: 'AUTO' },
        }),
      ),
      invalidate: vi.fn(() => {
        order.push('invalidate');
      }),
    };
    const modlog = { writeCase: vi.fn(() => Promise.resolve()) };
    const discord = {
      getVerificationLevel: vi.fn(() => Promise.resolve(3)),
      setVerificationLevel: vi.fn(() => {
        order.push('setVerificationLevel');
        return httpError(500);
      }),
      getBotUserId: vi.fn(() => Promise.resolve(ACTOR)),
    };
    const disableAutoIfIdle = vi.fn(() =>
      Promise.resolve({
        disabled: true,
        nextAt: null,
        case: { id: 'case-off' },
        restoreLevel: 1,
      }),
    );
    const service = new RaidService({
      settings,
      repository: { disableAutoIfIdle },
      discord,
      modlog,
      automod: {},
      scheduler: {},
      moderation: {},
    } as never);

    await service.disableJob(GUILD, new Date());

    expect(order).toEqual(['invalidate', 'setVerificationLevel']);
    expect(disableAutoIfIdle).toHaveBeenCalledWith(
      GUILD,
      expect.any(Date),
      ACTOR,
    );
    // The durable case is logged even though restoration failed non-auth.
    expect(modlog.writeCase).toHaveBeenCalledWith(
      expect.any(String),
      'case-off',
    );
  });

  it('propagates a 401 from restoring verification on auto disable only after the case/modlog are durable', async () => {
    const modlog = { writeCase: vi.fn(() => Promise.resolve()) };
    const settings = {
      get: vi.fn(() =>
        Promise.resolve({
          ok: true,
          value: { raidModeEnabled: true, raidModeSource: 'AUTO' },
        }),
      ),
      invalidate: vi.fn(),
    };
    const service = new RaidService({
      settings,
      repository: {
        disableAutoIfIdle: vi.fn(() =>
          Promise.resolve({
            disabled: true,
            nextAt: null,
            case: { id: 'case-off' },
            restoreLevel: 1,
          }),
        ),
      },
      discord: {
        getVerificationLevel: vi.fn(() => Promise.resolve(3)),
        setVerificationLevel: vi.fn(() => httpError(401, 'unauthorized')),
        getBotUserId: vi.fn(() => Promise.resolve(ACTOR)),
      },
      modlog,
      automod: {},
      scheduler: {},
      moderation: {},
    } as never);

    await expect(service.disableJob(GUILD, new Date())).rejects.toMatchObject({
      status: 401,
    });
    // The case/modlog were committed and logged before the 401 propagated.
    expect(modlog.writeCase).toHaveBeenCalledWith(
      expect.any(String),
      'case-off',
    );
  });

  it('keeps manual OFF processing when verification restore fails non-auth', async () => {
    const invalidate = vi.fn();
    const modlog = { writeCase: vi.fn(() => Promise.resolve()) };
    const deactivateWithCase = vi.fn(() =>
      Promise.resolve({
        changed: true,
        settings: baseSettings({ raidModeEnabled: false }),
        case: { id: 'case-off' },
        restoreLevel: 1,
      }),
    );
    const setVerificationLevel = vi.fn(() => httpError(500));
    const service = new RaidService({
      settings: { get: vi.fn(), invalidate },
      repository: { deactivateWithCase },
      discord: {
        getVerificationLevel: vi.fn(() => Promise.resolve(3)),
        setVerificationLevel,
      },
      modlog,
      automod: {},
      scheduler: {},
      moderation: {},
    } as never);

    const result = await service.off(GUILD, ACTOR, 'stood down');

    expect(result.ok).toBe(true);
    expect(deactivateWithCase).toHaveBeenCalledWith({
      guildId: GUILD,
      actorUserId: ACTOR,
      reason: 'stood down',
    });
    expect(invalidate).toHaveBeenCalledWith(GUILD);
    // The durable case is logged even though restoration failed non-auth.
    expect(modlog.writeCase).toHaveBeenCalledWith(
      expect.any(String),
      'case-off',
    );
  });

  it('propagates a restore 401 on manual OFF only after the case/modlog are durable', async () => {
    const modlog = { writeCase: vi.fn(() => Promise.resolve()) };
    const deactivateWithCase = vi.fn(() =>
      Promise.resolve({
        changed: true,
        settings: baseSettings({ raidModeEnabled: false }),
        case: { id: 'case-off' },
        restoreLevel: 1,
      }),
    );
    const service = new RaidService({
      settings: { get: vi.fn(), invalidate: vi.fn() },
      repository: { deactivateWithCase },
      discord: {
        getVerificationLevel: vi.fn(() => Promise.resolve(3)),
        setVerificationLevel: vi.fn(() => httpError(401, 'unauthorized')),
      },
      modlog,
      automod: {},
      scheduler: {},
      moderation: {},
    } as never);

    await expect(service.off(GUILD, ACTOR, 'off')).rejects.toMatchObject({
      status: 401,
    });
    expect(modlog.writeCase).toHaveBeenCalledWith(
      expect.any(String),
      'case-off',
    );
  });

  it('does not duplicate case/modlog when the raid was already off', async () => {
    const modlog = { writeCase: vi.fn(() => Promise.resolve()) };
    const setVerificationLevel = vi.fn(() => Promise.resolve());
    const deactivateWithCase = vi.fn(() =>
      Promise.resolve({
        changed: false,
        settings: baseSettings({ raidModeEnabled: false }),
        restoreLevel: null,
      }),
    );
    const service = new RaidService({
      settings: { get: vi.fn(), invalidate: vi.fn() },
      repository: { deactivateWithCase },
      discord: {
        getVerificationLevel: vi.fn(() => Promise.resolve(3)),
        setVerificationLevel,
      },
      modlog,
      automod: {},
      scheduler: {},
      moderation: {},
    } as never);

    const result = await service.off(GUILD, ACTOR, 'off');

    expect(result.ok).toBe(true);
    expect(modlog.writeCase).not.toHaveBeenCalled();
    expect(setVerificationLevel).not.toHaveBeenCalled();
  });

  it('treats a manual off with the AutoRaid literal as a normal manual off', async () => {
    const modlog = { writeCase: vi.fn(() => Promise.resolve()) };
    const deactivateWithCase = vi.fn(() =>
      Promise.resolve({
        changed: true,
        settings: baseSettings({ raidModeEnabled: false }),
        case: { id: 'case-off' },
        restoreLevel: 1,
      }),
    );
    const disableAutoIfIdle = vi.fn();
    const setVerificationLevel = vi.fn(() => Promise.resolve());
    const service = new RaidService({
      settings: { get: vi.fn(), invalidate: vi.fn() },
      repository: { deactivateWithCase, disableAutoIfIdle },
      discord: {
        getVerificationLevel: vi.fn(() => Promise.resolve(3)),
        setVerificationLevel,
      },
      modlog,
      automod: {},
      scheduler: {},
      moderation: {},
    } as never);

    const result = await service.off(GUILD, ACTOR, 'AutoRaid自動解除');

    expect(result.ok).toBe(true);
    // Normal manual off path, not the scheduler disable path.
    expect(deactivateWithCase).toHaveBeenCalledWith({
      guildId: GUILD,
      actorUserId: ACTOR,
      reason: 'AutoRaid自動解除',
    });
    expect(disableAutoIfIdle).not.toHaveBeenCalled();
    expect(setVerificationLevel).toHaveBeenCalledWith(
      GUILD,
      1,
      'AutoRaid自動解除',
    );
    expect(modlog.writeCase).toHaveBeenCalledWith(
      expect.any(String),
      'case-off',
    );
  });

  it('serializes OFF behind an in-flight raise so ownership is restored, not stranded', async () => {
    const order: string[] = [];
    let currentLevel = 1;
    let resolveRaise!: () => void;
    const raiseGate = new Promise<void>((resolve) => {
      resolveRaise = resolve;
    });
    let raiseStarted!: () => void;
    const raiseStartedPromise = new Promise<void>((resolve) => {
      raiseStarted = resolve;
    });
    const flush = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    const settings = {
      get: vi.fn(() => Promise.resolve({ ok: true, value: baseSettings() })),
      invalidate: vi.fn(),
    };
    const activateManual = vi.fn(() =>
      Promise.resolve({
        activated: true,
        count: 0,
        settings: baseSettings({
          raidModeEnabled: true,
          verificationLevelBeforeRaid: 1,
        }),
        case: { id: 'case-on' },
      }),
    );
    const markVerificationRaised = vi.fn(() => {
      order.push('claim');
      return Promise.resolve(
        baseSettings({
          raidModeEnabled: true,
          raidVerificationChanged: true,
        }),
      );
    });
    const deactivateWithCase = vi.fn(() => {
      order.push('deactivate');
      return Promise.resolve({
        changed: true,
        settings: baseSettings({ raidModeEnabled: false }),
        case: { id: 'case-off' },
        restoreLevel: 1,
      });
    });
    const setVerificationLevel = vi.fn(
      async (_guild: string, level: number) => {
        if (level === 3) {
          order.push('raise-start');
          raiseStarted();
          await raiseGate;
          currentLevel = 3;
          order.push('raise-end');
        } else {
          order.push(`restore-${String(level)}`);
          currentLevel = level;
        }
      },
    );
    const service = new RaidService({
      settings,
      repository: {
        activateManual,
        markVerificationRaised,
        deactivateWithCase,
      },
      discord: {
        getVerificationLevel: vi.fn(() => Promise.resolve(currentLevel)),
        setVerificationLevel,
        getBotUserId: vi.fn(() => Promise.resolve(ACTOR)),
      },
      modlog: { writeCase: vi.fn(() => Promise.resolve()) },
    } as never);

    const onPromise = service.on(GUILD, ACTOR, 'raid');
    await raiseStartedPromise; // the raise is now in flight, holding the lock
    const offPromise = service.off(GUILD, ACTOR, 'off');
    await flush();
    // OFF is serialized behind the in-flight raise: no deactivation yet, so it
    // cannot observe the pre-raise (ownership-unconfirmed) state.
    expect(order).not.toContain('deactivate');
    resolveRaise();
    await onPromise;
    await offPromise;
    // Ownership was claimed before OFF ran, and the prior level was restored.
    expect(order.indexOf('claim')).toBeLessThan(order.indexOf('deactivate'));
    expect(order).toContain('restore-1');
  });

  it('does not serialize unrelated guilds', async () => {
    const GUILD_A = '12345678901234567';
    const GUILD_B = '22345678901234567';
    const order: string[] = [];
    let resolveRaiseA!: () => void;
    const raiseGateA = new Promise<void>((resolve) => {
      resolveRaiseA = resolve;
    });
    let raiseAStarted!: () => void;
    const raiseAStartedPromise = new Promise<void>((resolve) => {
      raiseAStarted = resolve;
    });
    const deactivateWithCase = vi.fn((input: { guildId: string }) => {
      order.push(`deactivate:${input.guildId}`);
      return Promise.resolve({
        changed: true,
        settings: baseSettings({ raidModeEnabled: false }),
        case: { id: 'case-off' },
        restoreLevel: null,
      });
    });
    const setVerificationLevel = vi.fn(async (guild: string, level: number) => {
      if (guild === GUILD_A && level === 3) {
        raiseAStarted();
        await raiseGateA;
      }
    });
    const service = new RaidService({
      settings: {
        get: vi.fn(() => Promise.resolve({ ok: true, value: baseSettings() })),
        invalidate: vi.fn(),
      },
      repository: {
        activateManual: vi.fn(() =>
          Promise.resolve({
            activated: true,
            count: 0,
            settings: baseSettings({ raidModeEnabled: true }),
            case: { id: 'case-on' },
          }),
        ),
        markVerificationRaised: vi.fn(() =>
          Promise.resolve(baseSettings({ raidModeEnabled: true })),
        ),
        deactivateWithCase,
      },
      discord: {
        getVerificationLevel: vi.fn(() => Promise.resolve(1)),
        setVerificationLevel,
        getBotUserId: vi.fn(() => Promise.resolve(ACTOR)),
      },
      modlog: { writeCase: vi.fn(() => Promise.resolve()) },
    } as never);

    const onA = service.on(GUILD_A, ACTOR, 'raid');
    await raiseAStartedPromise; // A's raise is in flight, holding A's lock
    // B's OFF must complete even though A's lock is held.
    await service.off(GUILD_B, ACTOR, 'off');
    expect(order).toContain(`deactivate:${GUILD_B}`);
    resolveRaiseA();
    await onA;
  });
});
