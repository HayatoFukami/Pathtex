import { describe, expect, it, vi } from 'vitest';
import {
  TargetIdentityResolver,
  fallbackTargetIdentity,
  formatTargetIdentity,
  normalizeTargetDisplay,
  TargetIdentitySchema,
} from '../src/services/target-identity.js';
import {
  ModerationLogService,
  renderCaseTarget,
  type LogEvent,
} from '../src/services/logging-services.js';
import { createCanonicalUserCase } from '../src/services/case-service.js';

const guildId = '12345678901234567';
const userId = '12345678901234568';

describe('target identity foundation', () => {
  it('normalizes Unicode names and rejects numeric/decorated names', () => {
    expect(normalizeTargetDisplay('  ＡＢＣ  ')).toBe('ABC');
    expect(normalizeTargetDisplay(userId)).toBeNull();
    expect(normalizeTargetDisplay(`<@${userId}>`)).toBeNull();
    expect(normalizeTargetDisplay(`name (${userId})`)).toBeNull();
    expect(formatTargetIdentity({ userId, displayName: 'user007' })).toBe(
      `user007 (${userId})`,
    );
    expect(
      TargetIdentitySchema.safeParse({ userId, displayName: '😀'.repeat(128) })
        .success,
    ).toBe(true);
    expect(
      TargetIdentitySchema.safeParse({ userId, displayName: '😀'.repeat(129) })
        .success,
    ).toBe(false);
    expect(
      TargetIdentitySchema.safeParse({ userId, displayName: '  name  ' }).data
        ?.displayName,
    ).toBe('name');
    expect(() =>
      createCanonicalUserCase({
        guildId,
        action: 'BAN',
        moderatorUserId: guildId,
        source: 'COMMAND',
        status: 'COMPLETED',
        identity: { userId, displayName: userId },
      }),
    ).toThrow();
  });

  it('uses the specified resolution order and fallback', async () => {
    const lookup = {
      getMember: vi.fn().mockResolvedValue({ displayName: userId }),
      getUser: vi.fn().mockResolvedValue({ globalName: 'global007' }),
      getSnapshot: vi.fn(),
    };
    await expect(
      new TargetIdentityResolver(lookup).resolve(guildId, userId),
    ).resolves.toEqual({
      userId,
      displayName: 'global007',
    });
    await expect(
      new TargetIdentityResolver({}).resolve(guildId, userId),
    ).resolves.toEqual(fallbackTargetIdentity(userId));
    const member = vi.fn().mockResolvedValue({ displayName: 'member' });
    const user = vi.fn();
    await expect(
      new TargetIdentityResolver({ getMember: member, getUser: user }).resolve(
        guildId,
        userId,
        { member: { displayName: 'event' } },
      ),
    ).resolves.toMatchObject({ displayName: 'event' });
    expect(member).not.toHaveBeenCalled();
    expect(user).not.toHaveBeenCalled();
    await expect(
      new TargetIdentityResolver({
        getMember: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('fatal'), { status: 401 }),
          ),
      }).resolve(guildId, userId),
    ).rejects.toThrow('fatal');
  });

  it('renders historical users without performing a lookup and preserves non-user descriptors', () => {
    expect(
      renderCaseTarget({
        action: 'BAN',
        targetUserId: userId,
        targetDisplay: userId,
      } as never),
    ).toBe(`不明なユーザー (${userId})`);
    expect(
      renderCaseTarget({
        targetUserId: null,
        targetDisplay: 'raidmode',
      } as never),
    ).toBe('raidmode');
    expect(
      renderCaseTarget({
        action: 'SLOWMODE',
        targetUserId: userId,
        targetDisplay: 'channel-123',
      } as never),
    ).toBe('channel-123');
  });

  it('writes a persisted case with complete, timezone-visible fields', async () => {
    const sender = { send: vi.fn().mockResolvedValue(undefined) };
    const settings = {
      getChannel: vi.fn().mockResolvedValue('12345678901234569'),
      clearChannel: vi.fn(),
    };
    const dto = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      guildId,
      caseNumber: 7,
      action: 'BAN',
      targetUserId: userId,
      targetDisplay: '名前',
      moderatorUserId: guildId,
      reason: 'test',
      durationSeconds: null,
      source: 'EXTERNAL',
      status: 'FAILED',
      errorCode: 'USER_NOT_FOUND',
      logMessageId: null,
      logChannelId: null,
      discordAuditLogEntryId: userId,
      metadata: {},
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    } as never;
    const service = new ModerationLogService(
      sender,
      settings,
      { get: vi.fn().mockResolvedValue({ ok: true, value: dto }) } as never,
      { getTimezone: vi.fn().mockResolvedValue('Asia/Tokyo') },
    );
    await expect(
      service.writeCase(guildId, '123e4567-e89b-12d3-a456-426614174000'),
    ).resolves.toEqual({ status: 'delivered' });
    const event = sender.send.mock.calls[0]?.[1] as LogEvent;
    expect(event.embed.description).toContain('2026-01-01 09:00:00');
    expect(event.embed.fields).toEqual(
      expect.arrayContaining([
        { name: 'Action', value: 'BAN' },
        { name: 'Source', value: 'EXTERNAL' },
        { name: 'Status', value: 'FAILED' },
        { name: 'Reason', value: 'test' },
        { name: 'Duration', value: 'Permanent' },
        { name: 'Moderator', value: guildId },
        { name: 'DM', value: '対象外' },
      ]),
    );
  });
});
