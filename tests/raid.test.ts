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

  const autoDisableService = (modlog: {
    writeCase: () => Promise<unknown>;
  }) => {
    const setVerificationLevel = vi.fn(() => Promise.resolve());
    const service = new RaidService({
      settings: {
        get: vi.fn(() =>
          Promise.resolve({
            ok: true,
            value: { raidModeEnabled: true, raidModeSource: 'AUTO' },
          }),
        ),
        invalidate: vi.fn(),
      },
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
        setVerificationLevel,
        getBotUserId: vi.fn(() => Promise.resolve(ACTOR)),
      },
      modlog,
      automod: {},
      scheduler: {},
      moderation: {},
    } as never);
    return { service, setVerificationLevel };
  };

  it('propagates a 401 from modlog delivery on automatic OFF', async () => {
    const { service } = autoDisableService({
      writeCase: () => httpError(401, 'unauthorized'),
    });
    await expect(service.disableJob(GUILD, new Date())).rejects.toMatchObject({
      status: 401,
    });
  });

  it('keeps automatic OFF processing when modlog delivery fails non-auth', async () => {
    const { service, setVerificationLevel } = autoDisableService({
      writeCase: () => httpError(500, 'modlog down'),
    });
    // The non-auth modlog failure is best-effort; restoration still runs.
    await service.disableJob(GUILD, new Date());
    expect(setVerificationLevel).toHaveBeenCalledWith(
      GUILD,
      1,
      'AutoRaid自動解除',
    );
  });
});

describe('raid lockdown DM reliability', () => {
  const GUILD = '12345678901234567';
  const USER = '22345678901234567';
  const BOT = '12345678901234568';

  const dmService = (
    discord: Record<string, unknown> = {},
    extra: Record<string, unknown> = {},
  ) => {
    const execute = vi.fn(() =>
      Promise.resolve({ ok: true, value: { action: 'KICK', outcomes: [] } }),
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
      repository: { recordJoin: vi.fn(() => Promise.resolve()) },
      scheduler: {},
      moderation: { execute },
      cases: {},
      discord: {
        getBotUserId: vi.fn(() => Promise.resolve(BOT)),
        getGuildName: vi.fn(() => Promise.resolve('guild')),
        sendDm: vi.fn(() => Promise.resolve()),
        ...discord,
      },
      ...extra,
    } as never);
    return { service, execute };
  };

  it('treats a non-auth lockdown DM failure as non-fatal and still kicks', async () => {
    const sendDm = vi.fn(() =>
      Promise.reject(Object.assign(new Error('dm closed'), { status: 500 })),
    );
    const { service, execute } = dmService({ sendDm });
    await expect(
      service.memberAdd({ guildId: GUILD, userId: USER, isBot: false }),
    ).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('propagates a fatal 401 from the lockdown DM and skips the kick', async () => {
    const sendDm = vi.fn(() =>
      Promise.reject(Object.assign(new Error('unauthorized'), { status: 401 })),
    );
    const { service, execute } = dmService({ sendDm });
    await expect(
      service.memberAdd({ guildId: GUILD, userId: USER, isBot: false }),
    ).rejects.toMatchObject({ status: 401 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('propagates a cause-wrapped 401 from the lockdown guild-name lookup', async () => {
    const getGuildName = vi.fn(() =>
      Promise.reject(
        Object.assign(new Error('wrapper'), { cause: { status: 401 } }),
      ),
    );
    const { service, execute } = dmService({ getGuildName });
    await expect(
      service.memberAdd({ guildId: GUILD, userId: USER, isBot: false }),
    ).rejects.toMatchObject({ cause: { status: 401 } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not leak an unhandled rejection when the lockdown DM times out then rejects', async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let rejectDm!: (error: unknown) => void;
      const sendDm = vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectDm = reject;
          }),
      );
      const { service, execute } = dmService({ sendDm });
      const pending = service.memberAdd({
        guildId: GUILD,
        userId: USER,
        isBot: false,
      });
      // Settle the pre-DM work, then exceed the 2s DM budget so the timeout
      // wins the race while sendDm is still pending.
      await vi.advanceTimersByTimeAsync(2000);
      await pending;
      expect(sendDm).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();
      // The dangling DM send now rejects after the race settled; the attached
      // handler must absorb it so no unhandled rejection escapes.
      rejectDm(Object.assign(new Error('late dm failure'), { status: 500 }));
      await vi.advanceTimersByTimeAsync(10);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      vi.useRealTimers();
    }
  });

  const lateDmHarness = () => {
    vi.useFakeTimers();
    let rejectDm: ((error: unknown) => void) | undefined;
    const sendDm = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectDm = reject;
        }),
    );
    const fatalLog = vi.fn();
    const { service, execute } = dmService(
      { sendDm },
      { logger: { fatal: fatalLog } },
    );
    return {
      // Delegate through a stable closure so callers reach the live reject
      // handle, which is only assigned once sendDm is invoked.
      rejectDm: (error: unknown) => {
        if (!rejectDm) throw new Error('sendDm was not invoked');
        rejectDm(error);
      },
      fatalLog,
      service,
      execute,
    };
  };

  it('escalates a late, timed-out lockdown DM 401 through the fatal mechanism', async () => {
    const originalExitCode = process.exitCode;
    const emit = vi
      .spyOn(process, 'emit')
      .mockImplementation((() => true) as never);
    const { rejectDm, fatalLog, service, execute } = lateDmHarness();
    try {
      const pending = service.memberAdd({
        guildId: GUILD,
        userId: USER,
        isBot: false,
      });
      await vi.advanceTimersByTimeAsync(2000); // timeout wins the race
      await pending; // memberAdd completes the kick
      expect(execute).toHaveBeenCalledOnce();
      expect(emit).not.toHaveBeenCalledWith('SIGTERM');
      // The DM now rejects late with a 401; with no awaiting caller it must
      // escalate explicitly rather than being lost.
      rejectDm(Object.assign(new Error('unauthorized'), { status: 401 }));
      await vi.advanceTimersByTimeAsync(10);
      expect(emit).toHaveBeenCalledWith('SIGTERM');
      expect(process.exitCode).toBe(1);
      expect(fatalLog).toHaveBeenCalledOnce();
    } finally {
      process.exitCode = originalExitCode;
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('escalates a late, timed-out cause-wrapped lockdown DM 401', async () => {
    const originalExitCode = process.exitCode;
    const emit = vi
      .spyOn(process, 'emit')
      .mockImplementation((() => true) as never);
    const { rejectDm, service } = lateDmHarness();
    try {
      const pending = service.memberAdd({
        guildId: GUILD,
        userId: USER,
        isBot: false,
      });
      await vi.advanceTimersByTimeAsync(2000);
      await pending;
      rejectDm(Object.assign(new Error('wrapper'), { cause: { code: 401 } }));
      await vi.advanceTimersByTimeAsync(10);
      expect(emit).toHaveBeenCalledWith('SIGTERM');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('does not escalate a late, timed-out non-auth lockdown DM failure', async () => {
    const emit = vi
      .spyOn(process, 'emit')
      .mockImplementation((() => true) as never);
    const { rejectDm, fatalLog, service } = lateDmHarness();
    try {
      const pending = service.memberAdd({
        guildId: GUILD,
        userId: USER,
        isBot: false,
      });
      await vi.advanceTimersByTimeAsync(2000);
      await pending;
      rejectDm(Object.assign(new Error('late dm failure'), { status: 500 }));
      await vi.advanceTimersByTimeAsync(10);
      expect(emit).not.toHaveBeenCalledWith('SIGTERM');
      expect(fatalLog).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});

describe('raid status aggregation', () => {
  const GUILD = '12345678901234567';

  it('combines the raid state with the AutoRaid settings', async () => {
    const settings = { raidModeEnabled: true, raidModeSource: 'AUTO' };
    const autoRaid = {
      autoRaidEnabled: true,
      autoRaidJoinCount: 15,
      autoRaidWindowSeconds: 20,
    };
    const getOrCreate = vi.fn(() => Promise.resolve(autoRaid));
    const service = new RaidService({
      settings: {
        get: vi.fn(() => Promise.resolve({ ok: true, value: settings })),
      },
      automod: { getOrCreate },
    } as never);

    const result = await service.status(GUILD);

    expect(getOrCreate).toHaveBeenCalledWith(GUILD);
    expect(result).toEqual({ ok: true, value: { settings, autoRaid } });
  });

  it('propagates a settings read failure without reading AutoRaid', async () => {
    const getOrCreate = vi.fn();
    const service = new RaidService({
      settings: {
        get: vi.fn(() =>
          Promise.resolve({
            ok: false,
            error: new Error('settings unavailable'),
          }),
        ),
      },
      automod: { getOrCreate },
    } as never);

    const result = await service.status(GUILD);

    expect(result.ok).toBe(false);
    expect(getOrCreate).not.toHaveBeenCalled();
  });
});

describe('raid command reply rendering', () => {
  const GUILD = '12345678901234567';
  const ACTOR = '12345678901234568';
  const startedAt = new Date('2026-01-01T00:00:00Z');
  const startedEpoch = String(Math.floor(startedAt.getTime() / 1000));

  // Passes the in-handler bot-permission preflight: guild.members.me is present
  // and the invoking channel reports every requested permission as granted.
  const raidInteraction = (sub: string) => ({
    guildId: GUILD,
    user: { id: ACTOR },
    guild: { members: { me: {} } },
    channel: { permissionsFor: () => ({ has: () => true }) },
    options: {
      getSubcommand: () => sub,
      getString: () => null,
      getInteger: (name: string) => (name === 'joins' ? 20 : 30),
    },
    editReply: vi.fn(),
  });
  const raidmode = (service: unknown) => {
    const command = raidCommands(service as never).find(
      (c) => c.name === 'raidmode',
    );
    if (!command) throw new Error('raidmode command missing');
    return command;
  };
  const autoraidmode = (service: unknown) => {
    const command = raidCommands(service as never).find(
      (c) => c.name === 'autoraidmode',
    );
    if (!command) throw new Error('autoraidmode command missing');
    return command;
  };

  it('renders raidmode status ON with source, start, reason, prior level, and AutoRaid settings', async () => {
    const command = raidmode({
      status: vi.fn(() =>
        Promise.resolve({
          ok: true,
          value: {
            settings: {
              raidModeEnabled: true,
              raidModeSource: 'MANUAL',
              raidStartedAt: startedAt,
              raidModeReason: '急激な参加増加',
              verificationLevelBeforeRaid: 1,
            },
            autoRaid: {
              autoRaidEnabled: true,
              autoRaidJoinCount: 10,
              autoRaidWindowSeconds: 10,
            },
          },
        }),
      ),
    });
    const ix = raidInteraction('status');
    await command.execute({ interaction: ix } as never);
    expect(ix.editReply).toHaveBeenCalledWith(
      [
        'RaidMode: ON (MANUAL)',
        `発動日時: <t:${startedEpoch}:F>`,
        '理由: 急激な参加増加',
        '発動前の Verification Level: 1',
        'AutoRaidMode: ON (10 joins / 10秒)',
      ].join('\n'),
    );
  });

  it('renders raidmode status OFF with the AutoRaid settings', async () => {
    const command = raidmode({
      status: vi.fn(() =>
        Promise.resolve({
          ok: true,
          value: {
            settings: { raidModeEnabled: false },
            autoRaid: {
              autoRaidEnabled: false,
              autoRaidJoinCount: 10,
              autoRaidWindowSeconds: 10,
            },
          },
        }),
      ),
    });
    const ix = raidInteraction('status');
    await command.execute({ interaction: ix } as never);
    expect(ix.editReply).toHaveBeenCalledWith(
      ['RaidMode: OFF', 'AutoRaidMode: OFF (10 joins / 10秒)'].join('\n'),
    );
  });

  it('renders raidmode ON activation with the new case number', async () => {
    const on = vi.fn(() =>
      Promise.resolve({
        ok: true,
        value: { settings: { raidModeEnabled: true }, case: { caseNumber: 5 } },
      }),
    );
    const command = raidmode({ on });
    const ix = raidInteraction('on');
    await command.execute({ interaction: ix } as never);
    expect(on).toHaveBeenCalledWith(GUILD, ACTOR, undefined);
    expect(ix.editReply).toHaveBeenCalledWith(
      'RaidModeをONにしました。Case #5',
    );
  });

  it('renders the idempotent already-ON reply when no case is returned', async () => {
    const command = raidmode({
      on: vi.fn(() =>
        Promise.resolve({
          ok: true,
          value: { settings: { raidModeEnabled: true } },
        }),
      ),
    });
    const ix = raidInteraction('on');
    await command.execute({ interaction: ix } as never);
    expect(ix.editReply).toHaveBeenCalledWith('RaidModeは既にONです。');
  });

  it('renders raidmode OFF restoration with the new case number', async () => {
    const command = raidmode({
      off: vi.fn(() =>
        Promise.resolve({
          ok: true,
          value: {
            settings: { raidModeEnabled: false },
            case: { caseNumber: 6 },
          },
        }),
      ),
    });
    const ix = raidInteraction('off');
    await command.execute({ interaction: ix } as never);
    expect(ix.editReply).toHaveBeenCalledWith(
      'RaidModeをOFFにしました。Case #6',
    );
  });

  it('renders a raidmode service error message instead of JSON', async () => {
    const command = raidmode({
      status: vi.fn(() =>
        Promise.resolve({
          ok: false,
          error: new Error('settings unavailable'),
        }),
      ),
    });
    const ix = raidInteraction('status');
    await command.execute({ interaction: ix } as never);
    expect(ix.editReply).toHaveBeenCalledWith('settings unavailable');
  });

  it('renders autoraidmode set with the resolved thresholds', async () => {
    const setAutoRaid = vi.fn(() =>
      Promise.resolve({
        ok: true,
        value: {
          autoRaidEnabled: true,
          autoRaidJoinCount: 20,
          autoRaidWindowSeconds: 30,
        },
      }),
    );
    const command = autoraidmode({ setAutoRaid, status: vi.fn() });
    const ix = raidInteraction('set');
    await command.execute({ interaction: ix } as never);
    expect(setAutoRaid).toHaveBeenCalledWith(GUILD, undefined, 20, 30);
    expect(ix.editReply).toHaveBeenCalledWith(
      'AutoRaidMode: ON (20 joins / 30秒)',
    );
  });

  it('renders autoraidmode off with the stored thresholds', async () => {
    const command = autoraidmode({
      setAutoRaid: vi.fn(() =>
        Promise.resolve({
          ok: true,
          value: {
            autoRaidEnabled: false,
            autoRaidJoinCount: 10,
            autoRaidWindowSeconds: 10,
          },
        }),
      ),
      status: vi.fn(),
    });
    const ix = raidInteraction('off');
    await command.execute({ interaction: ix } as never);
    expect(ix.editReply).toHaveBeenCalledWith(
      'AutoRaidMode: OFF (10 joins / 10秒)',
    );
  });

  it('renders autoraidmode status with the AutoRaid settings, not the RaidMode state', async () => {
    const command = autoraidmode({
      status: vi.fn(() =>
        Promise.resolve({
          ok: true,
          value: {
            // RaidMode is ON, but `/autoraidmode status` must show only the
            // AutoRaid settings; rendering the raid state would fail the match.
            settings: {
              raidModeEnabled: true,
              raidModeSource: 'MANUAL',
              verificationLevelBeforeRaid: 1,
            },
            autoRaid: {
              autoRaidEnabled: true,
              autoRaidJoinCount: 15,
              autoRaidWindowSeconds: 20,
            },
          },
        }),
      ),
    });
    const ix = raidInteraction('status');
    await command.execute({ interaction: ix } as never);
    expect(ix.editReply).toHaveBeenCalledWith(
      'AutoRaidMode: ON (15 joins / 20秒)',
    );
  });
});
