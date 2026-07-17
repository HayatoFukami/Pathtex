import { describe, expect, it, vi } from 'vitest';
import { createCommandManifest } from '../src/commands/index.js';
import { PrismaGeneralRepository } from '../src/repositories/prisma-repositories.js';
import {
  createGeneralManifest,
  DiscordGeneralAdapter,
  GeneralService,
  formatDuration,
  splitList,
} from '../src/features/general/index.js';

const runtime = {
  botName: 'Vortex',
  avatarUrl: undefined,
  version: '1.0.0',
  nodeVersion: 'v22',
  discordVersion: '14.x',
  uptimeMs: 90_061_000,
  guildCount: 2,
  cachedUserCount: 3,
  clientId: '12345678901234567',
  invitePermissions: '8',
  gatewayPing: 42,
  dbPing: vi.fn(() => Promise.resolve(4)),
};
describe('general commands', () => {
  it('formats uptime and splits long lists', () => {
    expect(formatDuration(90_061_000)).toBe('1日 1時間 1分 1秒');
    expect(splitList(['a', 'b', 'c'], 3)).toEqual(['a', 'b', 'c']);
  });
  it('builds a safe invite URL and ping result', async () => {
    const service = new GeneralService({ runtime });
    expect(service.invite()).toContain('scope=bot%20applications.commands');
    expect(await service.ping(Date.now() - 10)).toMatchObject({
      gatewayMs: 42,
      databaseMs: 4,
    });
  });
  it('falls back when statistics are unavailable', async () => {
    const service = new GeneralService({
      runtime,
      stats: { getStats: vi.fn(() => Promise.reject(new Error('offline'))) },
    });
    expect((await service.about()).統計).toBe('取得失敗');
  });
  it('publishes every guild-only public command with the user fetch defer', () => {
    const manifest = createGeneralManifest(
      new GeneralService({ runtime }),
      {} as never,
    );
    expect(manifest.commands.map((command) => command.name)).toEqual([
      'about',
      'invite',
      'ping',
      'roleinfo',
      'serverinfo',
      'userinfo',
    ]);
    for (const command of manifest.commands)
      expect(command.guildOnly).toBe(true);
    expect(manifest.commands[5]?.deferMode).toBe('PUBLIC');
  });
  it('keeps only the general ping in the central manifest', () => {
    const general = createGeneralManifest(
      new GeneralService({ runtime }),
      {} as never,
    ).commands;
    const commands = createCommandManifest(
      { health: vi.fn(() => Promise.resolve(true)) },
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      general,
    );
    expect(commands.filter((command) => command.name === 'ping')).toHaveLength(
      1,
    );
  });
  it('reports a bounded database timeout as unavailable', async () => {
    vi.useFakeTimers();
    try {
      const service = new GeneralService({
        runtime,
        database: {
          ping: () => new Promise<void>(() => undefined),
          getStats: vi.fn(),
        },
      });
      const result = service.ping(Date.now());
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(result).resolves.toMatchObject({ databaseMs: null });
    } finally {
      vi.useRealTimers();
    }
  });
  it('presents API roles and missing guild avatars without inventing data', () => {
    const adapter = new DiscordGeneralAdapter({} as never, {
      version: '1.0.0',
      clientId: runtime.clientId,
    });
    const role = adapter.role({
      id: '12345678901234567',
      name: 'API role',
      color: 0,
      colors: {
        primary_color: 0x123456,
        secondary_color: null,
        tertiary_color: null,
      },
      hoist: false,
      icon: null,
      unicode_emoji: '🛡️',
      position: 7,
      permissions: '0',
      managed: false,
      mentionable: true,
      flags: 0 as never,
    });
    expect(role.color).toBe('#123456');
    expect(role.icon).toBe('🛡️');
    expect(role.position).toBe(7);
    expect(role.members).toBeNull();
    const user = adapter.user({
      id: runtime.clientId,
      username: 'user',
      globalName: null,
      bot: false,
      system: false,
      createdAt: new Date(0),
      displayAvatarURL: () => 'https://avatar',
      bannerURL: () => null,
      hexAccentColor: null,
    } as never);
    expect(user.guildAvatar).toBe('なし');
    expect(user.guildAvatarAvailable).toBe(false);
  });
  it('uses the repository port for database ping and statistics', async () => {
    const repository = new PrismaGeneralRepository({
      $queryRaw: vi.fn(() => Promise.resolve([{ '?column?': 1 }])),
      moderationCase: { count: vi.fn(() => Promise.resolve(4)) },
      userStrike: {
        aggregate: vi.fn(() => Promise.resolve({ _sum: { count: 9 } })),
      },
    } as never);
    await repository.ping();
    await expect(repository.getStats()).resolves.toEqual({
      cases: 4,
      strikes: 9,
    });
  });
  it('executes invite and about with the required embed metadata', async () => {
    const service = new GeneralService({
      runtime,
      stats: {
        getStats: vi.fn(() => Promise.resolve({ cases: 12, strikes: 34 })),
      },
    });
    const adapter = {} as never;
    const commands = createGeneralManifest(service, adapter).commands;
    const interaction = {
      deferred: false,
      replied: false,
      reply: vi.fn<(payload: unknown) => Promise<void>>(() =>
        Promise.resolve(),
      ),
      followUp: vi.fn<(payload: unknown) => Promise<void>>(() =>
        Promise.resolve(),
      ),
    };
    await commands[1]?.execute({ interaction } as never);
    const inviteReply = interaction.reply.mock.calls[0]?.[0] as {
      embeds: Array<{ data: { color?: number } }>;
      components: Array<{
        components: Array<{
          data: { label?: string; style?: number; url?: string };
        }>;
      }>;
    };
    expect(inviteReply.embeds[0]?.data.color).toBe(0x3498db);
    expect(inviteReply.components).toHaveLength(1);
    const button = inviteReply.components[0]?.components[0]?.data;
    expect(button).toMatchObject({ label: '招待リンク', style: 5 });
    expect(button?.url).toContain('scope=bot%20applications.commands');

    interaction.reply.mockClear();
    await commands[0]?.execute({ interaction } as never);
    const aboutReply = interaction.reply.mock.calls[0]?.[0] as {
      embeds: Array<{ data: { fields?: Array<{ value: string }> } }>;
    };
    expect(
      aboutReply.embeds[0]?.data.fields?.some((field) =>
        field.value.includes('ケース 12 / ストライク 34'),
      ),
    ).toBe(true);
  });
  it('exposes complete public guild command metadata and typed options', () => {
    const commands = createGeneralManifest(
      new GeneralService({ runtime }),
      {} as never,
    ).commands;
    for (const command of commands) {
      expect(command.authorizationPolicy).toBe('PUBLIC');
      expect(command.guildOnly).toBe(true);
      expect(command.data.contexts).toEqual([0]);
      expect(command.data.integration_types).toEqual([0]);
    }
    const role = commands.find((command) => command.name === 'roleinfo');
    const user = commands.find((command) => command.name === 'userinfo');
    expect(role?.deferMode).toBe('PUBLIC');
    expect(user?.deferMode).toBe('PUBLIC');
    expect(
      (role?.data.options as Array<{ name: string; type: number }>)[0],
    ).toMatchObject({ name: 'role', type: 8 });
    expect(
      (user?.data.options as Array<{ name: string; type: number }>)[0],
    ).toMatchObject({ name: 'user', type: 6 });
  });
  it('resolves members and safely falls back when fetching fails', async () => {
    const adapter = new DiscordGeneralAdapter({} as never, {
      version: '1.0.0',
      clientId: runtime.clientId,
    });
    const member = { id: 'u' };
    const guild = { members: { fetch: vi.fn(() => Promise.resolve(member)) } };
    await expect(adapter.resolveMember(guild as never, 'u')).resolves.toBe(
      member,
    );
    guild.members.fetch.mockRejectedValueOnce(new Error('not found'));
    await expect(
      adapter.resolveMember(guild as never, 'u'),
    ).resolves.toBeUndefined();
  });
  it('executes roleinfo with a successful member count', async () => {
    const roleInfo = {
      name: 'Moderators',
      id: runtime.clientId,
      color: '#123456',
      createdAt: 'now',
      position: 3,
      members: 2,
      memberCountApproximate: false,
      mentionable: true,
      hoist: true,
      managed: false,
      icon: '🛡️',
      permissions: ['ViewChannel'],
      botComparison: 'Botより下位',
    };
    const adapter = {
      roleWithMemberCount: vi.fn(() => Promise.resolve(roleInfo)),
      role: vi.fn(() => ({
        ...roleInfo,
        members: null,
        memberCountApproximate: true,
      })),
    };
    const command = createGeneralManifest(
      new GeneralService({ runtime }),
      adapter as never,
    ).commands[3];
    const interaction = {
      deferred: true,
      replied: false,
      editReply: vi.fn<(payload: unknown) => Promise<void>>(() =>
        Promise.resolve(),
      ),
      followUp: vi.fn<(payload: unknown) => Promise<void>>(() =>
        Promise.resolve(),
      ),
      guild: { roles: { cache: new Map() }, members: { me: undefined } },
      options: { getRole: vi.fn(() => ({ id: runtime.clientId })) },
    };
    await command?.execute({ interaction } as never);
    expect(adapter.roleWithMemberCount).toHaveBeenCalledOnce();
    expect(interaction.editReply).toHaveBeenCalledOnce();
  });
  it('renders an approximate cached role count in the response embed', async () => {
    const roleInfo = {
      name: 'Cached role',
      id: runtime.clientId,
      color: '#123456',
      createdAt: 'now',
      position: 3,
      members: 3,
      memberCountApproximate: true,
      mentionable: true,
      hoist: false,
      managed: false,
      icon: 'なし',
      permissions: [],
      botComparison: '取得不能',
    };
    const adapter = {
      roleWithMemberCount: vi.fn(() => Promise.resolve(roleInfo)),
      role: vi.fn(() => roleInfo),
    };
    const command = createGeneralManifest(
      new GeneralService({ runtime }),
      adapter as never,
    ).commands[3];
    const interaction = {
      deferred: true,
      replied: false,
      editReply: vi.fn<(payload: unknown) => Promise<void>>(() =>
        Promise.resolve(),
      ),
      followUp: vi.fn<(payload: unknown) => Promise<void>>(() =>
        Promise.resolve(),
      ),
      guild: { roles: { cache: new Map() }, members: { me: undefined } },
      options: { getRole: vi.fn(() => ({ id: runtime.clientId })) },
    };
    await command?.execute({ interaction } as never);
    const payload = interaction.editReply.mock.calls[0]?.[0] as {
      embeds: Array<{
        data: { fields?: Array<{ name: string; value: string }> };
      }>;
    };
    expect(
      payload.embeds[0]?.data.fields?.find(
        (field) => field.name === 'メンバー数',
      )?.value,
    ).toBe('3（概算）');
  });
  it('preserves the cached role count when member fetching fails', async () => {
    const adapter = new DiscordGeneralAdapter({} as never, {
      version: '1.0.0',
      clientId: runtime.clientId,
    });
    const cachedRole = {
      id: runtime.clientId,
      name: 'Cached role',
      guild: {},
      members: new Map([
        ['a', {}],
        ['b', {}],
        ['c', {}],
      ]),
      position: 2,
      hexColor: '#abcdef',
      createdAt: new Date(0),
      mentionable: false,
      hoist: false,
      managed: false,
      iconURL: () => null,
      unicodeEmoji: null,
      permissions: { toArray: () => [] },
    };
    const guild = {
      members: {
        fetch: vi.fn(() => Promise.reject(new Error('fetch failed'))),
      },
    };
    const result = await adapter.roleWithMemberCount(
      cachedRole as never,
      guild as never,
    );
    expect(result.members).toBe(3);
    expect(result.memberCountApproximate).toBe(true);
  });
  it('keeps the four fast commands non-deferred and validates options', () => {
    const commands = createGeneralManifest(
      new GeneralService({ runtime }),
      {} as never,
    ).commands;
    expect(
      commands
        .filter((command) => command.deferMode === 'NONE')
        .map((command) => command.name),
    ).toEqual(['about', 'invite', 'ping', 'serverinfo']);
    const role = commands.find((command) => command.name === 'roleinfo');
    const user = commands.find((command) => command.name === 'userinfo');
    expect(
      (role?.data.options as Array<{ required?: boolean }>)[0]?.required,
    ).toBe(true);
    expect(
      (user?.data.options as Array<{ required?: boolean }>)[0]?.required,
    ).toBe(false);
  });
});
