import { describe, expect, it, vi } from 'vitest';
import {
  MessageFlags,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import {
  configurationDashboard,
  createConfigurationComponentHandler,
  createConfigurationCustomId,
  createConfigurationModalHandler,
  parseConfigurationCustomId,
} from '../src/features/configuration/dashboard.js';

const guildId = '12345678901234567';
const actorId = '12345678901234568';
const overview = {
  settings: {
    timezone: 'Asia/Tokyo',
    messageLogChannelId: '12345678901234569',
    modlogChannelId: '12345678901234573',
    serverLogChannelId: null,
    voiceLogChannelId: null,
    modRoleId: null,
    mutedRoleId: null,
    raidModeEnabled: true,
    raidModeSource: 'AUTO',
  },
  automod: {
    antiInviteStrikes: 2,
    antiReferralStrikes: 1,
    maxUserMentions: 5,
    autoRaidEnabled: true,
  },
  punishments: [
    {
      id: 'p1',
      guildId,
      threshold: 3,
      action: 'MUTE',
      durationSeconds: 600,
      createdBy: actorId,
    },
  ],
  ignoredRoles: [
    {
      guildId,
      roleId: '12345678901234571',
      createdBy: actorId,
      createdAt: new Date(),
    },
  ],
  ignoredChannels: [
    {
      guildId,
      channelId: '12345678901234572',
      createdBy: actorId,
      createdAt: new Date(),
    },
  ],
  automaticIgnoredRoles: ['12345678901234570'],
  botWarnings: [],
  resourceWarnings: [],
};

function interaction(
  customId: string,
  userId = actorId,
  values: string[] = [],
) {
  return {
    customId,
    guildId,
    user: { id: userId },
    inGuild: () => true,
    isMessageComponent: () => true,
    isAnySelectMenu: () => values.length > 0,
    values,
    reply: vi.fn(),
    deferUpdate: vi.fn(),
    editReply: vi.fn(),
    followUp: vi.fn(),
    showModal: vi.fn(),
  } as unknown as MessageComponentInteraction;
}

describe('configuration Component v2 dashboard', () => {
  it('renders only V2 components, with no legacy content or embeds', () => {
    const payload = configurationDashboard(overview, { guildId, actorId });
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(payload.content).toBeUndefined();
    expect(payload.embeds).toBeUndefined();
    expect(payload.components).toHaveLength(1);
    expect(
      (payload.components?.[0] as { toJSON(): unknown }).toJSON(),
    ).toMatchObject({ type: 17 });
  });

  it('provides navigation pages for channels, roles, and timezone', () => {
    const logs = configurationDashboard(overview, {
      guildId,
      actorId,
      page: 'logs',
    });
    const access = configurationDashboard(overview, {
      guildId,
      actorId,
      page: 'access',
    });
    expect(
      (logs.components?.[0] as { toJSON(): { components: unknown[] } }).toJSON()
        .components,
    ).toHaveLength(6);
    expect(
      (
        access.components?.[0] as { toJSON(): { components: unknown[] } }
      ).toJSON().components,
    ).toHaveLength(3);
  });

  it('sets defaults only for configured valid log channels', () => {
    const logs = configurationDashboard(overview, {
      guildId,
      actorId,
      page: 'logs',
    });
    const serialized = JSON.stringify(
      (logs.components?.[0] as { toJSON(): unknown }).toJSON(),
    );
    expect(serialized).toContain('12345678901234569');
    expect(serialized).toContain('12345678901234573');
    expect(serialized).not.toContain(
      'default_values":[{"id":"12345678901234570"',
    );
    expect(serialized).not.toContain('default_values":[{"id":"null"');
  });

  it('renders realistic DTO identities and configuration details', () => {
    const payload = configurationDashboard(overview, { guildId, actorId });
    const serialized = JSON.stringify(
      (payload.components?.[0] as { toJSON(): unknown }).toJSON(),
    );
    expect(serialized).toContain('<@&12345678901234571>');
    expect(serialized).toContain('<#12345678901234572>');
    expect(serialized).toContain('3→MUTE（600秒）');
    expect(serialized).toContain('AutoRaid');
    expect(serialized).toContain('有効（AUTO）');
  });

  it('bounds every V2 text block with large configuration datasets', () => {
    const stressOverview = {
      ...overview,
      punishments: Array.from({ length: 240 }, (_, index) => ({
        id: `p-${String(index)}`,
        guildId,
        threshold: index + 1,
        action: 'MUTE',
        durationSeconds: 86400,
        createdBy: actorId,
      })),
      ignoredRoles: Array.from({ length: 240 }, (_, index) => ({
        guildId,
        roleId: `1234567890123${String(index).padStart(5, '0')}`,
        createdBy: actorId,
        createdAt: new Date(),
      })),
      ignoredChannels: Array.from({ length: 240 }, (_, index) => ({
        guildId,
        channelId: `1234567890123${String(index + 240).padStart(5, '0')}`,
        createdBy: actorId,
        createdAt: new Date(),
      })),
      automaticIgnoredRoles: Array.from(
        { length: 240 },
        (_, index) => `1234567890123${String(index + 480).padStart(5, '0')}`,
      ),
      botWarnings: Array.from(
        { length: 240 },
        (_, index) => `警告${String(index)}：${'詳細'.repeat(20)}`,
      ),
      resourceWarnings: ['リソース警告'],
    };
    const payload = configurationDashboard(stressOverview, {
      guildId,
      actorId,
    });
    const root = (
      payload.components?.[0] as { toJSON(): unknown }
    ).toJSON() as {
      type: number;
      components?: unknown[];
    };
    const all: Array<{
      type?: number;
      content?: unknown;
      components?: unknown[];
    }> = [];
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      const item = value as {
        type?: number;
        content?: unknown;
        components?: unknown[];
      };
      all.push(item);
      item.components?.forEach(visit);
    };
    visit(root);
    expect(all.length).toBeLessThanOrEqual(40);
    for (const item of all.filter((item) => item.type === 10)) {
      expect(typeof item.content).toBe('string');
      expect(String(item.content).length).toBeLessThanOrEqual(4000);
    }
  });

  it('uses strict, scoped, expiring IDs', () => {
    const id = createConfigurationCustomId(
      'channel-message',
      guildId,
      actorId,
      1_700_000_000_000,
    );
    expect(parseConfigurationCustomId(id)).toMatchObject({
      guildId,
      actorId,
      action: 'channel-message',
    });
    expect(parseConfigurationCustomId(`${id}.extra`)).toBeNull();
    expect(
      parseConfigurationCustomId(
        id.replace('cfg1.channel-message', 'cfg1.delete'),
      ),
    ).toBeNull();
    expect(parseConfigurationCustomId('cfg1.refresh.1.2.abc')).toBeNull();
  });

  it('sets a selected channel through the public service contract', async () => {
    const service = {
      setLogChannel: vi
        .fn()
        .mockResolvedValue({ ok: true, value: overview.settings }),
      overview: vi.fn().mockResolvedValue({ ok: true, value: overview }),
      setup: vi.fn(),
    };
    const authorization = { authorize: vi.fn().mockResolvedValue(true) };
    const handler = createConfigurationComponentHandler({
      service: service as never,
      authorization,
      roles: { resolveRole: vi.fn() },
    });
    const target = interaction(
      createConfigurationCustomId('channel-message', guildId, actorId),
      actorId,
      ['12345678901234569'],
    );
    await handler(target);
    expect(service.setLogChannel).toHaveBeenCalledWith(
      guildId,
      'message',
      '12345678901234569',
    );
    expect(service.overview).toHaveBeenCalledWith(guildId);
    const editReply = Reflect.get(target, 'editReply') as ReturnType<
      typeof vi.fn
    >;
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).not.toContain(
      'status',
    );
    const followUp = Reflect.get(target, 'followUp') as ReturnType<
      typeof vi.fn
    >;
    expect(followUp).toHaveBeenCalledWith({
      content: 'メッセージログのチャンネルを更新しました。',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('never renders a Result error message, while preserving it for the error sink', async () => {
    const secret = 'database password: sentinel-secret';
    const service = {
      setLogChannel: vi.fn().mockResolvedValue({
        ok: false,
        error: new Error(secret),
      }),
      overview: vi.fn().mockResolvedValue({ ok: true, value: overview }),
      setup: vi.fn(),
    };
    const reportFailure = vi.fn();
    const target = interaction(
      createConfigurationCustomId('channel-message', guildId, actorId),
      actorId,
      ['12345678901234569'],
    );
    const handler = createConfigurationComponentHandler({
      service: service as never,
      authorization: { authorize: vi.fn().mockResolvedValue(true) },
      roles: { resolveRole: vi.fn() },
      reportFailure,
    });
    await handler(target);
    const editReply = Reflect.get(target, 'editReply') as ReturnType<
      typeof vi.fn
    >;
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).not.toContain(secret);
    expect(reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: secret }),
    );
  });

  it('validates selected MOD roles using injected slash-command metadata rules', async () => {
    const service = {
      setModRole: vi
        .fn()
        .mockResolvedValue({ ok: true, value: overview.settings }),
      overview: vi.fn().mockResolvedValue({ ok: true, value: overview }),
      setup: vi.fn(),
    };
    const resolveRole = vi.fn().mockResolvedValue({
      id: '12345678901234571',
      managed: false,
      everyone: false,
      botIntegration: false,
    });
    const handler = createConfigurationComponentHandler({
      service: service as never,
      authorization: { authorize: vi.fn().mockResolvedValue(true) },
      roles: { resolveRole },
    });
    await handler(
      interaction(
        createConfigurationCustomId('role-select', guildId, actorId),
        actorId,
        ['12345678901234571'],
      ),
    );
    expect(service.setModRole).toHaveBeenCalledWith(
      guildId,
      '12345678901234571',
      expect.objectContaining({
        managed: false,
        everyone: false,
        botIntegration: false,
      }),
    );
    for (const metadata of [
      {
        id: '12345678901234571',
        managed: true,
        everyone: false,
        botIntegration: false,
      },
      { id: guildId, managed: false, everyone: true, botIntegration: false },
      {
        id: '12345678901234571',
        managed: false,
        everyone: false,
        botIntegration: true,
      },
    ]) {
      resolveRole.mockResolvedValueOnce(metadata);
      await handler(
        interaction(
          createConfigurationCustomId('role-select', guildId, actorId),
          actorId,
          [metadata.id],
        ),
      );
    }
    expect(service.setModRole).toHaveBeenCalledTimes(1);
  });

  it('opens and submits the timezone modal', async () => {
    const service = {
      setTimezone: vi.fn().mockResolvedValue({
        ok: true,
        value: { settings: { timezone: 'Asia/Tokyo' } },
      }),
      overview: vi.fn().mockResolvedValue({ ok: true, value: overview }),
      setup: vi.fn(),
    };
    const options = {
      service: service as never,
      authorization: { authorize: vi.fn().mockResolvedValue(true) },
      roles: { resolveRole: vi.fn() },
      now: () => 1_700_000_000_000,
    };
    const open = interaction(
      createConfigurationCustomId(
        'timezone-open',
        guildId,
        actorId,
        1_700_000_000_000,
      ),
    );
    await createConfigurationComponentHandler(options)(open);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(open.showModal).toHaveBeenCalledOnce();
    const modal = {
      customId: createConfigurationCustomId(
        'timezone-submit',
        guildId,
        actorId,
        1_700_000_000_000,
      ),
      guildId,
      user: { id: actorId },
      inGuild: () => true,
      isMessageComponent: () => false,
      fields: { getTextInputValue: () => 'Asia/Tokyo' },
      reply: vi.fn(),
      deferReply: vi.fn(),
      editReply: vi.fn(),
      followUp: vi.fn(),
    } as unknown as ModalSubmitInteraction;
    await createConfigurationModalHandler(options)(modal);
    expect(service.setTimezone).toHaveBeenCalledWith(guildId, 'Asia/Tokyo');
    // eslint-disable-next-line @typescript-eslint/unbound-method, @typescript-eslint/no-deprecated
    expect(modal.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
  });

  it('rejects wrong actor and expired IDs before authorization', async () => {
    const service = {
      setLogChannel: vi.fn(),
      overview: vi.fn(),
      setup: vi.fn(),
    };
    const authorization = { authorize: vi.fn().mockResolvedValue(true) };
    const handler = createConfigurationComponentHandler({
      service: service as never,
      authorization,
      roles: { resolveRole: vi.fn() },
      now: () => 1_700_002_000_000,
    });
    await handler(
      interaction(
        createConfigurationCustomId(
          'refresh',
          guildId,
          actorId,
          1_700_000_000_000,
        ),
        '12345678901234570',
      ),
    );
    await handler(
      interaction(
        createConfigurationCustomId(
          'refresh',
          guildId,
          actorId,
          1_700_000_000_000,
        ),
      ),
    );
    expect(authorization.authorize).not.toHaveBeenCalled();
    expect(service.overview).not.toHaveBeenCalled();
  });

  it('follows up ephemerally when a deferred action throws', async () => {
    const service = {
      setLogChannel: vi
        .fn()
        .mockRejectedValue(new Error('channel unavailable')),
      overview: vi.fn(),
      setup: vi.fn(),
    };
    const target = interaction(
      createConfigurationCustomId('channel-message', guildId, actorId),
      actorId,
      ['12345678901234569'],
    );
    const handler = createConfigurationComponentHandler({
      service: service as never,
      authorization: { authorize: vi.fn().mockResolvedValue(true) },
      roles: { resolveRole: vi.fn() },
    });
    await expect(handler(target)).rejects.toThrow('channel unavailable');
    // eslint-disable-next-line @typescript-eslint/unbound-method, @typescript-eslint/no-deprecated
    expect(target.deferUpdate).toHaveBeenCalledOnce();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(target.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
    const followUp = Reflect.get(target, 'followUp') as ReturnType<
      typeof vi.fn
    >;
    const followUpPayload = followUp.mock.calls[0]?.[0] as {
      content?: unknown;
    };
    expect(String(followUpPayload.content)).not.toContain(
      'channel unavailable',
    );
  });

  it('uses safe V2 feedback for a failed overview without exposing its cause', async () => {
    const service = {
      overview: vi.fn().mockResolvedValue({
        ok: false,
        error: new Error('database password leaked'),
      }),
      setup: vi.fn(),
    };
    const target = interaction(
      createConfigurationCustomId('refresh', guildId, actorId),
    );
    const handler = createConfigurationComponentHandler({
      service: service as never,
      authorization: { authorize: vi.fn().mockResolvedValue(true) },
      roles: { resolveRole: vi.fn() },
    });
    await expect(handler(target)).resolves.toBe(true);
    const editReply = Reflect.get(target, 'editReply') as ReturnType<
      typeof vi.fn
    >;
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).not.toContain(
      'database password leaked',
    );
  });

  it('rejects setup before acknowledgement when bot permissions are missing', async () => {
    const service = {
      setup: vi.fn(),
      overview: vi.fn(),
    };
    const target = interaction(
      createConfigurationCustomId('setup', guildId, actorId),
    );
    const handler = createConfigurationComponentHandler({
      service: service as never,
      authorization: { authorize: vi.fn().mockResolvedValue(true) },
      roles: { resolveRole: vi.fn() },
      setupPermissionPreflight: vi.fn().mockResolvedValue(['Manage Channels']),
    });

    await handler(target);

    expect(service.setup).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method, @typescript-eslint/no-deprecated
    expect(target.deferUpdate).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method, @typescript-eslint/no-deprecated
    expect(target.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
  });
});
