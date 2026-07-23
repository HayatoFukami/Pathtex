import { describe, expect, it, vi } from 'vitest';
import { PrismaCaseRepository } from '../src/repositories/prisma-repositories.js';
import type { CaseInput } from '../src/repositories/contracts.js';

/** Builds a PrismaClient stub whose `$transaction` runs the callback against a
 * minimal transaction stub. The stubbed allocator returns a schema-valid case
 * row that echoes the written `target_display`, so these tests exercise the
 * real `createWithNumber` -> `allocate` -> `allocateCase` path (including the
 * user target-display write-boundary guard) without a database. */
function makeDb() {
  const timestamp = new Date('2026-01-01T00:00:00Z');
  const tx = {
    guildSettings: {
      upsert: vi.fn().mockResolvedValue({ nextCaseNumber: 1 }),
      update: vi.fn().mockResolvedValue({ nextCaseNumber: 2 }),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
    moderationCase: {
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => ({
        id: '123e4567-e89b-12d3-a456-426614174000',
        guildId: data.guildId,
        caseNumber: 1,
        action: data.action,
        targetUserId: data.targetUserId ?? null,
        targetDisplay: data.targetDisplay,
        moderatorUserId: data.moderatorUserId,
        reason: data.reason ?? null,
        durationSeconds: data.durationSeconds ?? null,
        source: data.source,
        status: data.status,
        errorCode: null,
        logMessageId: null,
        logChannelId: null,
        discordAuditLogEntryId: data.discordAuditLogEntryId ?? null,
        metadata: data.metadata ?? {},
        createdAt: timestamp,
        updatedAt: timestamp,
      })),
    },
  };
  const db = {
    $transaction: vi.fn(async (run: (client: unknown) => Promise<unknown>) =>
      run(tx),
    ),
  };
  return { db: db as never, tx };
}

const baseInput: CaseInput = {
  guildId: '12345678901234567',
  action: 'BAN',
  targetUserId: '12345678901234571',
  targetDisplay: 'valid-name',
  moderatorUserId: '12345678901234568',
  reason: 'x',
  source: 'COMMAND',
  status: 'COMPLETED',
};

describe('PrismaCaseRepository target-display write boundary', () => {
  it('createWithNumber rejects a user-target case whose display is an ID, mention, or formatted value', async () => {
    const { db, tx } = makeDb();
    const repository = new PrismaCaseRepository(db);
    await expect(
      repository.createWithNumber({
        ...baseInput,
        targetDisplay: '12345678901234571',
      }),
    ).rejects.toThrow(/target_display/u);
    await expect(
      repository.createWithNumber({
        ...baseInput,
        targetDisplay: '<@12345678901234571>',
      }),
    ).rejects.toThrow(/target_display/u);
    await expect(
      repository.createWithNumber({
        ...baseInput,
        targetDisplay: 'name (12345678901234571)',
      }),
    ).rejects.toThrow(/target_display/u);
    // The guard fires before any persistence call is attempted.
    expect(tx.moderationCase.create).not.toHaveBeenCalled();
  });

  it('createWithNumber persists a valid user-target display and a non-user-target descriptor', async () => {
    const { db } = makeDb();
    const repository = new PrismaCaseRepository(db);
    const valid = await repository.createWithNumber(baseInput);
    expect(valid.targetDisplay).toBe('valid-name');
    const raid = await repository.createWithNumber({
      ...baseInput,
      action: 'RAIDMODE_ON',
      targetUserId: null,
      targetDisplay: 'raidmode',
    });
    expect(raid.targetDisplay).toBe('raidmode');
  });
});
