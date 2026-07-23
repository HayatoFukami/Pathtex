import { describe, expect, it, vi } from 'vitest';
import { withDiscordRetry } from '../src/adapters/discord-retry.js';
import { CorrelationCache } from '../src/services/correlation-cache.js';
import { SchedulerService } from '../src/services/scheduler-service.js';
import { MessageLogService } from '../src/services/logging-services.js';
import { ModerationLogService } from '../src/services/logging-services.js';
import { CaseService } from '../src/services/case-service.js';
import { SnapshotService } from '../src/services/snapshot-service.js';
import { PermissionService } from '../src/services/permission-service.js';

describe('shared services', () => {
  it('retries 5xx/network but never manually retries 429', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    let attempts = 0;
    await expect(
      withDiscordRetry(
        () => {
          attempts += 1;
          if (attempts < 3)
            return Promise.reject(
              Object.assign(new Error('temporary'), { status: 503 }),
            );
          return Promise.resolve('ok');
        },
        { delaysMs: [1, 1], sleep },
      ),
    ).resolves.toBe('ok');
    expect(attempts).toBe(3);
    attempts = 0;
    await expect(
      withDiscordRetry(
        () => {
          attempts += 1;
          return Promise.reject(
            Object.assign(new Error('rate limited'), { status: 429 }),
          );
        },
        { sleep },
      ),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });
  it('validates, expires, consumes, and refreshes correlation entries as LRU', () => {
    let now = 0;
    const cache = new CorrelationCache(
      10,
      { moderation: 1, 'message-delete': 1, slowmode: 1 },
      () => now,
    );
    const key = '12345678901234567:12345678901234568:BAN';
    expect(cache.put('moderation', key, { caseId: 'bad' }).ok).toBe(false);
    expect(
      cache.put('moderation', key, {
        caseId: '123e4567-e89b-12d3-a456-426614174000',
      }).ok,
    ).toBe(true);
    now = 5;
    expect(cache.peek('moderation', key)).toBeDefined();
    now = 11;
    expect(cache.consume('moderation', key)).toBeUndefined();
  });
  it('classifies scheduler outcomes according to Discord semantics', () => {
    const service = new SchedulerService({} as never, { workerId: 'worker' });
    expect(service.classify({ status: 404 })).toBe('IDEMPOTENT_SUCCESS');
    expect(service.classify({ status: 403 })).toBe('FAILED');
    expect(service.classify({ status: 503 })).toBe('RETRYABLE');
    expect(service.classify({ status: 401 })).toBe('FATAL');
  });
  it('validates discriminated scheduler cancellation shapes', async () => {
    const cancelTarget = vi.fn().mockResolvedValue(1);
    const service = new SchedulerService({ cancelTarget } as never, {
      workerId: 'worker',
    });
    expect(
      (
        await service.cancel({
          type: 'UNBAN',
          guildId: '12345678901234567',
          targetUserId: null,
          channelId: null,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await service.cancel({
          type: 'RESTORE_SLOWMODE',
          guildId: '12345678901234567',
          targetUserId: null,
          channelId: '12345678901234568',
        })
      ).ok,
    ).toBe(true);
  });
  it('checks dispatcher support before dispatch and propagates fatal 401', async () => {
    const job = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      type: 'UNBAN',
    } as never;
    const repository = {
      claimDue: vi.fn().mockResolvedValue([job]),
      complete: vi.fn(),
      fail: vi.fn(),
    } as never;
    const fatal = vi.fn();
    const service = new SchedulerService(repository, {
      workerId: 'worker',
      onFatal: fatal,
    });
    const dispatcher = {
      supports: () => true,
      dispatch: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('auth'), { status: 401 })),
    };
    await expect(service.dispatchDue(dispatcher)).rejects.toThrow('auth');
    expect(fatal).toHaveBeenCalledOnce();
    expect(
      (repository as { complete: ReturnType<typeof vi.fn> }).complete,
    ).not.toHaveBeenCalled();
  });
  it('separates moderator and manage-guild policies', async () => {
    const verifier = {
      verify: vi.fn().mockResolvedValue(new Set(['ManageGuild'])),
      isOwner: vi.fn().mockResolvedValue(false),
      hasModRole: vi.fn().mockResolvedValue(false),
    };
    const service = new PermissionService();
    const manageGuild = await service.authorize(
      verifier,
      '12345678901234567',
      '12345678901234568',
      'MANAGE_GUILD',
    );
    const moderator = await service.authorize(
      verifier,
      '12345678901234567',
      '12345678901234568',
      'MODERATOR',
      'KickMembers',
    );
    expect(manageGuild.ok && manageGuild.value).toBe(true);
    expect(moderator.ok && moderator.value).toBe(false);
  });
  it('skips unconfigured logs and exposes no raw exception', async () => {
    const sender = { send: vi.fn() };
    const service = new MessageLogService(sender);
    await expect(
      service.write('12345678901234567', {
        type: 'message',
        guildId: '12345678901234567',
        occurredAt: new Date(),
        timezone: 'UTC',
        embed: { title: 'x', fields: [] },
      }),
    ).resolves.toEqual({ status: 'skipped', errorCode: 'NOT_CONFIGURED' });
    expect(sender.send).not.toHaveBeenCalled();
  });
  it('rejects cross-guild events and isolates delivery/configuration failures', async () => {
    const sender = {
      send: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('gone'), { status: 404 })),
    };
    const settings = {
      getChannel: vi.fn().mockResolvedValue('12345678901234569'),
      clearChannel: vi.fn().mockResolvedValue(undefined),
    };
    const service = new ModerationLogService(sender, settings);
    const event = {
      type: 'mod',
      guildId: '12345678901234568',
      occurredAt: new Date(),
      timezone: 'UTC',
      embed: { title: 'x', fields: [] },
    };
    await expect(service.write('12345678901234567', event)).resolves.toEqual({
      status: 'failed',
      errorCode: 'DISCORD_ERROR',
    });
    expect(sender.send).not.toHaveBeenCalled();
    const result = await service.write('12345678901234568', event);
    expect(result.status).toBe('failed');
    expect(settings.clearChannel).toHaveBeenCalledWith(
      '12345678901234568',
      'moderation',
    );
  });
  it('reports successful logging delivery', async () => {
    const sender = { send: vi.fn().mockResolvedValue(undefined) };
    const settings = {
      getChannel: vi.fn().mockResolvedValue('12345678901234569'),
      clearChannel: vi.fn(),
    };
    const service = new MessageLogService(sender, settings);
    const result = await service.write('12345678901234567', {
      type: 'message',
      guildId: '12345678901234567',
      occurredAt: new Date(),
      timezone: 'UTC',
      embed: { title: 'x', fields: [] },
    });
    expect(result).toEqual({ status: 'delivered' });
    expect(sender.send).toHaveBeenCalledOnce();
  });
  it('merges case metadata and isolates update failures', async () => {
    const existing = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      guildId: '12345678901234567',
      metadata: { retained: true, old: 1 },
    };
    const updateMetadata = vi
      .fn()
      .mockRejectedValue(new Error('database unavailable'));
    const cases = { get: vi.fn().mockResolvedValue(existing), updateMetadata };
    const settings = {
      getChannel: vi.fn().mockResolvedValue('12345678901234569'),
      clearChannel: vi.fn(),
    };
    const sender = {
      send: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('gone'), { status: 404 })),
    };
    const service = new ModerationLogService(
      sender,
      settings,
      new CaseService(cases as never),
    );
    const result = await service.write(
      '12345678901234567',
      {
        type: 'mod',
        guildId: '12345678901234567',
        occurredAt: new Date(),
        timezone: 'UTC',
        embed: { title: 'x', fields: [] },
      },
      existing.id,
    );
    expect(result.status).toBe('failed');
    expect(updateMetadata).toHaveBeenCalled();
    expect(updateMetadata.mock.calls[0]?.[1]).toMatchObject({
      retained: true,
      old: 1,
      logDeliveryFailed: true,
    });
  });
  it('returns Result validation errors for case and snapshot services', async () => {
    const caseRepository = {
      get: vi.fn().mockResolvedValue({
        id: '123e4567-e89b-12d3-a456-426614174000',
        guildId: '12345678901234567',
        metadata: {},
      }),
      updateReason: vi.fn(),
      updateStatus: vi.fn(),
      updateMetadata: vi.fn(),
    };
    const caseService = new CaseService(caseRepository as never);
    expect((await caseService.create({} as never)).ok).toBe(false);
    expect(
      (
        await caseService.updateReason(
          '12345678901234567',
          '123e4567-e89b-12d3-a456-426614174000',
          '   ',
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await caseService.updateStatus(
          '12345678901234567',
          '123e4567-e89b-12d3-a456-426614174000',
          'INVALID' as never,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await caseService.updateMetadata(
          '12345678901234567',
          '123e4567-e89b-12d3-a456-426614174000',
          undefined as never,
        )
      ).ok,
    ).toBe(false);
    const snapshots = new SnapshotService({} as never);
    expect((await snapshots.getMessage('bad')).ok).toBe(false);
    expect((await snapshots.getMessages(['bad'])).ok).toBe(false);
  });
  it('resolves CaseService.latest guild-wide and validates identity', async () => {
    const latest = vi.fn().mockResolvedValue(null);
    const caseService = new CaseService({ latest } as never);
    const guildId = '12345678901234567';
    expect((await caseService.latest(guildId)).ok).toBe(true);
    expect(latest).toHaveBeenCalledWith(guildId);
    // An invalid guild identity is rejected before reaching the repository.
    latest.mockClear();
    const invalid = await caseService.latest('not-a-snowflake');
    expect(invalid.ok).toBe(false);
    expect(latest).not.toHaveBeenCalled();
  });
  it('enforces correlation capacity and per-kind value shapes', () => {
    const cache = new CorrelationCache(100, {
      moderation: 1,
      'message-delete': 2,
      slowmode: 1,
    });
    const first = '12345678901234567:12345678901234568';
    const second = '12345678901234567:12345678901234569';
    expect(cache.put('message-delete', first, { reason: 'x' }).ok).toBe(true);
    expect(cache.put('message-delete', second, { reason: 'y' }).ok).toBe(true);
    expect(cache.peek('message-delete', first)).toMatchObject({ reason: 'x' });
    expect(
      cache.put('message-delete', '12345678901234567:12345678901234570', {
        reason: 'z',
      }).ok,
    ).toBe(true);
    expect(cache.peek('message-delete', first)).toBeUndefined();
    expect(cache.peek('message-delete', second)).toMatchObject({ reason: 'y' });
    expect(
      cache.put('message-delete', '12345678901234567:12345678901234568', {
        previousInterval: 1,
        newInterval: 2,
      } as never).ok,
    ).toBe(false);
    expect(
      cache.put('moderation', '12345678901234567:12345678901234568:BAD', {
        caseId: '123e4567-e89b-12d3-a456-426614174000',
      }).ok,
    ).toBe(false);
  });
});
