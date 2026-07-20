import { describe, expect, it, vi } from 'vitest';
import {
  ConfigurationOverviewError,
  ConfigurationService,
  formatGuildTime,
} from '../src/features/configuration/service.js';
import { serviceSettingsText } from '../src/features/configuration/commands.js';
import {
  classifyVoice,
  LogDeliveryService,
  messageEditEmbed,
  normalizeEmbed,
  serverEmbed,
} from '../src/features/logging/index.js';

describe('configuration and logging slice', () => {
  const guildId = '12345678901234567';
  const settings = {
    guildId,
    modlogChannelId: null,
    messageLogChannelId: null,
    serverLogChannelId: null,
    voiceLogChannelId: null,
    modRoleId: null,
    mutedRoleId: null,
    timezone: 'UTC',
    raidModeEnabled: false,
    raidModeSource: null,
    raidModeReason: null,
    raidStartedAt: null,
    verificationLevelBeforeRaid: null,
    raidVerificationChanged: false,
    nextCaseNumber: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('returns all configured overview sections on success', async () => {
    const service = new ConfigurationService({
      settings: { getOrCreate: vi.fn().mockResolvedValue(settings) } as never,
      setup: {
        getAutomaticIgnoredRoles: vi.fn().mockResolvedValue(['role-automatic']),
        getBotWarnings: vi.fn().mockResolvedValue(['権限不足']),
      } as never,
    });

    await expect(service.overview(guildId)).resolves.toMatchObject({
      ok: true,
      value: {
        settings,
        automod: null,
        punishments: [],
        ignoredRoles: [],
        ignoredChannels: [],
        automaticIgnoredRoles: ['role-automatic'],
        botWarnings: ['権限不足'],
        resourceWarnings: [],
      },
    });
  });

  it('renders automatic ignore roles and bot warnings in settings output', () => {
    const output = serviceSettingsText({
      settings,
      automod: null,
      punishments: [],
      ignoredRoles: [],
      ignoredChannels: [],
      automaticIgnoredRoles: ['role-automatic'],
      botWarnings: ['権限不足'],
      resourceWarnings: [],
    });

    expect(output).toContain('自動Ignoreロール: role-automatic');
    expect(output).toContain('Bot権限警告: 権限不足');
  });

  it('identifies a failed overview dependency and preserves its cause', async () => {
    const cause = new Error('automod backend unavailable');
    const service = new ConfigurationService({
      settings: { getOrCreate: vi.fn().mockResolvedValue(settings) } as never,
      automod: {
        getOrCreate: vi.fn().mockRejectedValue(cause),
        update: vi.fn(),
      },
    });

    await expect(service.overview(guildId)).rejects.toSatisfy(
      (error: unknown) => {
        return (
          error instanceof ConfigurationOverviewError &&
          error.dependency === 'automod' &&
          error.cause === cause
        );
      },
    );
  });

  it('renders configured timezone while preserving the instant', () => {
    expect(
      formatGuildTime(new Date('2026-01-01T00:00:00.000Z'), 'Asia/Tokyo'),
    ).toContain('2026-01-01 09:00:00');
  });
  it('classifies only channel transitions as voice events', () => {
    expect(classifyVoice(null, '1')).toBe('Join');
    expect(classifyVoice('1', null)).toBe('Leave');
    expect(classifyVoice('1', '2')).toBe('Move');
    expect(classifyVoice('1', '1')).toBeNull();
  });
  it('does not log embed-only equivalent updates', () => {
    const base = {
      guildId: '12345678901234567',
      channelId: '12345678901234568',
      messageId: '12345678901234569',
      author: 'a',
      authorId: '12345678901234570',
      content: 'same',
      createdAt: new Date(),
    };
    expect(messageEditEmbed(base, { ...base }, 'UTC')).toBeNull();
  });
  it('delivers server embeds with a Discord timestamp and guild time', async () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    const embed = serverEmbed(
      'Member Join',
      [{ name: 'User', value: 'user' }],
      date,
      'Asia/Tokyo',
    );
    const send = vi.fn().mockResolvedValue(undefined);
    const delivery = new LogDeliveryService(
      { send },
      {
        getChannel: vi.fn().mockResolvedValue('12345678901234568'),
        clearChannel: vi.fn(),
      },
    );

    await expect(delivery.deliver(guildId, 'server', embed)).resolves.toEqual({
      status: 'delivered',
    });
    expect(embed.timestamp).toBe(date.toISOString());
    expect(embed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(embed.fields[0]).toEqual({
      name: '日時',
      value: '2026-01-01 09:00:00 GMT+9 (<t:1767225600:F>)',
    });
    expect(send).toHaveBeenCalledWith('12345678901234568', embed);
  });
  it('reserves one field for server embed guild time', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    const fields = Array.from({ length: 25 }, (_, index) => ({
      name: `field-${String(index)}`,
      value: 'value',
    }));

    expect(
      serverEmbed('title', fields.slice(0, 24), date, 'UTC').fields,
    ).toHaveLength(25);
    expect(serverEmbed('title', fields, date, 'UTC').fields).toHaveLength(25);
    expect(serverEmbed('title', fields, date, 'UTC').fields.at(-1)?.name).toBe(
      'field-23',
    );
  });
  it('normalizes the aggregate embed payload to 6000 characters', () => {
    const embed = normalizeEmbed({
      title: 't'.repeat(256),
      timestamp: '2026-01-01T00:00:00.000Z',
      fields: Array.from({ length: 5 }, () => ({
        name: 'n'.repeat(256),
        value: 'v'.repeat(1024),
      })),
    });
    const characters =
      embed.title.length +
      embed.fields.reduce(
        (total, field) => total + field.name.length + field.value.length,
        0,
      );

    expect(characters).toBe(6000);
    expect(embed.fields).toHaveLength(5);
    expect(embed.fields.at(-1)?.value).toHaveLength(368);
  });
});
