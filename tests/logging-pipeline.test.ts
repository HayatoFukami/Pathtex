import { describe, expect, it, vi } from 'vitest';
import {
  LoggingEventPipeline,
  DEFAULT_MESSAGE_RETENTION_MS,
} from '../src/features/logging/pipeline.js';
import type { MessageView } from '../src/features/logging/events.js';
import { SnapshotService } from '../src/services/snapshot-service.js';
import { RetentionService } from '../src/services/retention-service.js';
import type {
  MessageSnapshotInput,
  SnapshotDto,
} from '../src/repositories/contracts.js';

type SavedInput = MessageSnapshotInput;
const firstSaved = (saveMessage: ReturnType<typeof vi.fn>): SavedInput =>
  saveMessage.mock.calls[0]?.[0] as SavedInput;

const GUILD = '12345678901234567';
const CHANNEL = '12345678901234568';

const view = (overrides: Partial<MessageView> = {}): MessageView => ({
  guildId: GUILD,
  channelId: CHANNEL,
  messageId: '12345678901234570',
  author: 'user',
  authorId: '12345678901234571',
  content: 'hello',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const snapshotDto = (overrides: Partial<SnapshotDto> = {}): SnapshotDto => ({
  messageId: '12345678901234570',
  guildId: GUILD,
  channelId: CHANNEL,
  authorUserId: '12345678901234571',
  authorDisplay: 'user',
  content: 'hello',
  attachments: [],
  embedsSummary: [],
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  editedAt: null,
  expiresAt: new Date('2026-01-08T00:00:00.000Z'),
  ...overrides,
});

const buildPipeline = (
  snapshots: Record<string, unknown>,
  events: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) =>
  new LoggingEventPipeline({
    snapshots: {
      saveMessage: vi.fn().mockResolvedValue({ ok: true, value: {} }),
      getMessage: vi.fn().mockResolvedValue({ ok: true, value: null }),
      getMessages: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      deleteMessage: vi.fn().mockResolvedValue({ ok: true }),
      deleteMessages: vi.fn().mockResolvedValue({ ok: true, value: 0 }),
      saveMember: vi.fn().mockResolvedValue({ ok: true, value: {} }),
      getMembersForUser: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      ...snapshots,
    } as never,
    events: {
      messageEdit: vi.fn().mockReturnValue(null),
      messageDelete: vi.fn().mockResolvedValue({ title: 'delete' }),
      bulkDelete: vi.fn().mockResolvedValue({ title: 'bulk' }),
      voice: vi.fn().mockReturnValue(null),
      ...events,
    } as never,
    delivery: { deliver: vi.fn().mockResolvedValue({ status: 'delivered' }) },
    timezone: vi.fn().mockResolvedValue('UTC'),
    ...extra,
  } as never);

describe('logging pipeline message retention', () => {
  it('defaults message snapshot expiry to 7 days', async () => {
    const saveMessage = vi.fn().mockResolvedValue({ ok: true, value: {} });
    const pipeline = buildPipeline({ saveMessage });
    const before = Date.now();
    await pipeline.messageCreate(view());
    const after = Date.now();
    const expiresAt = firstSaved(saveMessage).expiresAt;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + DEFAULT_MESSAGE_RETENTION_MS,
    );
    expect(expiresAt.getTime()).toBeLessThanOrEqual(
      after + DEFAULT_MESSAGE_RETENTION_MS,
    );
    expect(DEFAULT_MESSAGE_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('uses a supplied message retention instead of the hard-coded 7 days', async () => {
    const saveMessage = vi.fn().mockResolvedValue({ ok: true, value: {} });
    const pipeline = buildPipeline(
      { saveMessage },
      {},
      { messageRetentionMs: 60_000 },
    );
    const before = Date.now();
    await pipeline.messageCreate(view());
    const after = Date.now();
    const expiresAt = firstSaved(saveMessage).expiresAt;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + 60_000);
  });
});

describe('logging pipeline messageUpdate preserves creation time', () => {
  it('carries forward the persisted snapshot createdAt on edit', async () => {
    const originalCreatedAt = new Date('2025-12-01T09:30:00.000Z');
    const saveMessage = vi.fn().mockResolvedValue({ ok: true, value: {} });
    const getMessage = vi.fn().mockResolvedValue({
      ok: true,
      value: snapshotDto({ createdAt: originalCreatedAt, content: 'old' }),
    });
    const pipeline = buildPipeline({ saveMessage, getMessage });

    await pipeline.messageUpdate(
      null,
      view({ content: 'new', createdAt: new Date('2026-02-02T00:00:00.000Z') }),
      new Date('2026-02-02T00:00:00.000Z'),
    );

    const saved = firstSaved(saveMessage);
    // The original creation time is preserved, not reset to the edit time.
    expect(saved.createdAt).toEqual(originalCreatedAt);
    expect(saved.editedAt).toBeInstanceOf(Date);
    expect(saved.content).toBe('new');
  });

  it('falls back to the gateway message createdAt when no snapshot exists', async () => {
    const gatewayCreatedAt = new Date('2026-01-05T00:00:00.000Z');
    const saveMessage = vi.fn().mockResolvedValue({ ok: true, value: {} });
    const getMessage = vi.fn().mockResolvedValue({ ok: true, value: null });
    const pipeline = buildPipeline({ saveMessage, getMessage });

    await pipeline.messageUpdate(
      null,
      view({ createdAt: gatewayCreatedAt }),
      new Date('2026-02-02T00:00:00.000Z'),
    );

    expect(firstSaved(saveMessage).createdAt).toEqual(gatewayCreatedAt);
  });
});

describe('logging pipeline messageDeleteBulk uses bulk operations', () => {
  it('bulk-loads missing snapshots and bulk-deletes all ids in single calls', async () => {
    const getMessage = vi.fn().mockResolvedValue({ ok: true, value: null });
    const deleteMessage = vi.fn().mockResolvedValue({ ok: true });
    const getMessages = vi.fn().mockResolvedValue({
      ok: true,
      value: [
        snapshotDto({ messageId: '12345678901234581', content: 'b' }),
        snapshotDto({ messageId: '12345678901234582', content: 'c' }),
      ],
    });
    const deleteMessages = vi.fn().mockResolvedValue({ ok: true, value: 3 });
    const bulkDelete = vi.fn().mockResolvedValue({ title: 'bulk' });
    const pipeline = buildPipeline(
      { getMessage, getMessages, deleteMessage, deleteMessages },
      { bulkDelete },
    );

    const cachedA = view({ messageId: '12345678901234580', content: 'a' });
    await pipeline.messageDeleteBulk(
      GUILD,
      CHANNEL,
      ['12345678901234580', '12345678901234581', '12345678901234582'],
      [cachedA],
      new Date('2026-02-02T00:00:00.000Z'),
    );

    // Only the ids absent from the gateway cache are bulk-loaded, in one call.
    expect(getMessages).toHaveBeenCalledTimes(1);
    expect(getMessages).toHaveBeenCalledWith([
      '12345678901234581',
      '12345678901234582',
    ]);
    expect(getMessage).not.toHaveBeenCalled();
    // All ids are bulk-deleted in one call; no per-id deletes.
    expect(deleteMessages).toHaveBeenCalledTimes(1);
    expect(deleteMessages).toHaveBeenCalledWith([
      '12345678901234580',
      '12345678901234581',
      '12345678901234582',
    ]);
    expect(deleteMessage).not.toHaveBeenCalled();
    // The merged views preserve the requested order (cached + snapshot-derived).
    const merged = bulkDelete.mock.calls[0]?.[3] as MessageView[];
    expect(merged.map((m) => m.messageId)).toEqual([
      '12345678901234580',
      '12345678901234581',
      '12345678901234582',
    ]);
    expect(merged.map((m) => m.content)).toEqual(['a', 'b', 'c']);
  });

  it('skips the bulk load when every id is already cached', async () => {
    const getMessages = vi.fn().mockResolvedValue({ ok: true, value: [] });
    const deleteMessages = vi.fn().mockResolvedValue({ ok: true, value: 1 });
    const pipeline = buildPipeline({ getMessages, deleteMessages });

    await pipeline.messageDeleteBulk(
      GUILD,
      CHANNEL,
      ['12345678901234580'],
      [view({ messageId: '12345678901234580' })],
      new Date('2026-02-02T00:00:00.000Z'),
    );

    expect(getMessages).not.toHaveBeenCalled();
    expect(deleteMessages).toHaveBeenCalledWith(['12345678901234580']);
  });

  it('still deletes when the bulk load reports no snapshots', async () => {
    const getMessages = vi.fn().mockResolvedValue({ ok: true, value: [] });
    const deleteMessages = vi.fn().mockResolvedValue({ ok: true, value: 0 });
    const bulkDelete = vi.fn().mockResolvedValue({ title: 'bulk' });
    const pipeline = buildPipeline(
      { getMessages, deleteMessages },
      { bulkDelete },
    );

    await pipeline.messageDeleteBulk(
      GUILD,
      CHANNEL,
      ['12345678901234581'],
      [],
      new Date('2026-02-02T00:00:00.000Z'),
    );

    const merged = bulkDelete.mock.calls[0]?.[3] as MessageView[];
    expect(merged).toEqual([]);
    expect(deleteMessages).toHaveBeenCalledWith(['12345678901234581']);
  });
});

describe('SnapshotService bulk deletion', () => {
  it('rejects invalid message ids before reaching the repository', async () => {
    const deleteMessages = vi.fn();
    const service = new SnapshotService({ deleteMessages } as never);
    const result = await service.deleteMessages(['bad']);
    expect(result.ok).toBe(false);
    expect(deleteMessages).not.toHaveBeenCalled();
  });

  it('delegates valid bulk deletion to the repository and returns the count', async () => {
    const deleteMessages = vi.fn().mockResolvedValue(2);
    const service = new SnapshotService({ deleteMessages } as never);
    const result = await service.deleteMessages([
      '12345678901234570',
      '12345678901234571',
    ]);
    expect(result).toEqual({ ok: true, value: 2 });
    expect(deleteMessages).toHaveBeenCalledWith([
      '12345678901234570',
      '12345678901234571',
    ]);
  });
});

describe('RetentionService cleanup surface', () => {
  const repository = () => ({
    deleteExpiredSnapshots: vi.fn().mockResolvedValue(3),
    deleteOldRaidEvents: vi.fn().mockResolvedValue(5),
    deleteOldScheduledActions: vi.fn().mockResolvedValue(7),
  });

  it('exposes each retention purge through the service contract', async () => {
    const repo = repository();
    const service = new RetentionService(repo);
    const now = new Date('2026-02-02T00:00:00.000Z');
    expect(await service.cleanupExpiredSnapshots(now)).toEqual({
      ok: true,
      value: 3,
    });
    expect(await service.cleanupOldRaidEvents(now)).toEqual({
      ok: true,
      value: 5,
    });
    expect(await service.cleanupOldScheduledActions(now)).toEqual({
      ok: true,
      value: 7,
    });
    expect(repo.deleteExpiredSnapshots).toHaveBeenCalledWith(now);
    expect(repo.deleteOldRaidEvents).toHaveBeenCalledWith(now);
    expect(repo.deleteOldScheduledActions).toHaveBeenCalledWith(now);
  });

  it('runs every purge and aggregates the counts', async () => {
    const repo = repository();
    const service = new RetentionService(repo);
    const result = await service.runAll(new Date('2026-02-02T00:00:00.000Z'));
    expect(result).toEqual({
      ok: true,
      value: { snapshots: 3, raidEvents: 5, scheduledActions: 7 },
    });
  });

  it('rejects an invalid reference time without touching the repository', async () => {
    const repo = repository();
    const service = new RetentionService(repo);
    const bad = new Date('not-a-date');
    expect((await service.runAll(bad)).ok).toBe(false);
    expect((await service.cleanupExpiredSnapshots(bad)).ok).toBe(false);
    expect(repo.deleteExpiredSnapshots).not.toHaveBeenCalled();
  });

  it('runs each purge independently: one rejection does not abort or hide the others', async () => {
    const repo = {
      deleteExpiredSnapshots: vi
        .fn()
        .mockRejectedValue(new Error('snapshots down')),
      deleteOldRaidEvents: vi.fn().mockResolvedValue(5),
      deleteOldScheduledActions: vi.fn().mockResolvedValue(7),
    };
    const logger = { warn: vi.fn() };
    const service = new RetentionService(repo, {
      logger: logger as never,
    });
    const result = await service.runAll(new Date('2026-02-02T00:00:00.000Z'));
    // The failed purge counts as zero; the others still ran and are reported.
    expect(result).toEqual({
      ok: true,
      value: { snapshots: 0, raidEvents: 5, scheduledActions: 7 },
    });
    expect(repo.deleteOldRaidEvents).toHaveBeenCalledOnce();
    expect(repo.deleteOldScheduledActions).toHaveBeenCalledOnce();
    // The failure is observable via the supplied logger.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'retention.purge_failed',
        target: 'snapshots',
      }),
      expect.any(String),
    );
  });
});
