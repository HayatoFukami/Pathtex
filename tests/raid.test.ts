import { describe, expect, it, vi } from 'vitest';
import {
  raidDisableAt,
  raidWindowCount,
  shouldActivateRaid,
} from '../src/domain/raid.js';
import { RaidService } from '../src/features/raid/service.js';
import { raidCommands } from '../src/features/raid/commands.js';

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
      repository: {},
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
          value: {
            raidModeEnabled: true,
            raidModeSource: 'AUTO',
            raidVerificationChanged: true,
            verificationLevelBeforeRaid: 1,
          },
        }),
      ),
      invalidate: vi.fn(),
    };
    const cases = {
      create: vi.fn(() =>
        Promise.resolve({ ok: true, value: { id: 'case-id' } }),
      ),
    };
    const modlog = { write: vi.fn(() => Promise.resolve(undefined)) };
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
          }),
        ),
      },
      discord,
      cases,
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
    expect(cases.create).toHaveBeenCalled();
    expect(modlog.write).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
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
});
