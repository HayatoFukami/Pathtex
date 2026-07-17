import { describe, expect, it, vi } from 'vitest';
import {
  ConfigurationOverviewError,
  ConfigurationService,
  formatGuildTime,
} from '../src/features/configuration/service.js';
import {
  classifyVoice,
  messageEditEmbed,
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
    });

    await expect(service.overview(guildId)).resolves.toMatchObject({
      ok: true,
      value: {
        settings,
        automod: null,
        punishments: [],
        ignoredRoles: [],
        ignoredChannels: [],
        automaticIgnoredRoles: [],
        botWarnings: [],
        resourceWarnings: [],
      },
    });
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
});
