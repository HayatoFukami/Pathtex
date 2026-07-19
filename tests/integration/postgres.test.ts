import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  PrismaCaseRepository,
  PrismaStrikeRepository,
  PrismaSchedulerRepository,
  PrismaPunishmentRepository,
  PrismaIgnoreRepository,
  PrismaSnapshotRepository,
  PrismaActiveMuteRepository,
  PrismaRaidRepository,
  PrismaDepartureRepository,
  PrismaRetentionRepository,
} from '../../src/repositories/prisma-repositories.js';
import { CaseService } from '../../src/services/case-service.js';
import {
  CaseDtoSchema,
  JobDtoSchema,
} from '../../src/repositories/contracts.js';

const integration =
  process.env.RUN_INTEGRATION_TESTS === '1' ? describe : describe.skip;

integration('PostgreSQL persistence foundation', () => {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>> | undefined;
  let db: PrismaClient | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    const url = container.getConnectionUri();
    execFileSync('node_modules/.bin/prisma', ['migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'ignore',
    });
    db = new PrismaClient({ datasources: { db: { url } } });
  }, 120_000);

  it('fresh migration exposes canonical tables and max_lines', async () => {
    const tables = await getDb().$queryRaw<
      Array<{ table_name: string }>
    >`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
    const names = new Set(tables.map((row) => row.table_name));
    expect(names.has('guild_settings')).toBe(true);
    expect(names.has('active_mutes')).toBe(true);
    expect(names.has('guild_lifecycle_markers')).toBe(true);
    const columns = await getDb().$queryRaw<
      Array<{ column_name: string }>
    >`SELECT column_name FROM information_schema.columns WHERE table_name = 'automod_settings'`;
    expect(columns.some((row) => row.column_name === 'max_lines')).toBe(true);
  });

  afterAll(async () => {
    await db?.$disconnect();
    await container?.stop();
  });

  it('allocates unique case numbers under concurrency', async () => {
    const repository = new PrismaCaseRepository(getDb());
    const targetIds = [
      '12345678901234560',
      '12345678901234561',
      '12345678901234562',
      '12345678901234563',
      '12345678901234564',
      '12345678901234565',
      '12345678901234566',
      '12345678901234567',
      '12345678901234568',
      '12345678901234569',
      '12345678901234570',
      '12345678901234571',
    ];
    const cases = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        repository.createWithNumber({
          guildId: '12345678901234567',
          action: 'BAN',
          targetDisplay: `user-${String(index)}`,
          targetUserId: targetIds[index] ?? '12345678901234571',
          moderatorUserId: '12345678901234568',
          source: 'COMMAND',
          status: 'COMPLETED',
          reason: 'test',
        }),
      ),
    );
    expect(
      new Set(cases.map((item) => (item as { caseNumber: number }).caseNumber))
        .size,
    ).toBe(12);
  });

  it('deduplicates concurrent external cases and consumes one number', async () => {
    const guildId = '12345678901234590';
    const auditId = '12345678901234591';
    const service = new CaseService(new PrismaCaseRepository(getDb()));
    const input = {
      guildId,
      action: 'BAN' as const,
      targetUserId: '12345678901234592',
      targetDisplay: 'external-user',
      moderatorUserId: '12345678901234593',
      source: 'EXTERNAL' as const,
      status: 'COMPLETED' as const,
      reason: 'audit',
      discordAuditLogEntryId: auditId,
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => service.createExternalCase(input)),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    const ids = results.flatMap((result) =>
      result.ok ? [result.value.id] : [],
    );
    expect(new Set(ids).size).toBe(1);
    expect(
      await getDb().moderationCase.count({
        where: { guildId, discordAuditLogEntryId: auditId },
      }),
    ).toBe(1);
    expect(
      (await getDb().guildSettings.findUnique({ where: { guildId } }))
        ?.nextCaseNumber,
    ).toBe(2);
  });

  it('round-trips SCHEDULED cases, executed jobs, FK, and nullable uniqueness', async () => {
    const guildId = '12345678901234594';
    const caseRow = await new PrismaCaseRepository(getDb()).createWithNumber({
      guildId,
      action: 'UNBAN',
      targetUserId: '12345678901234595',
      targetDisplay: 'scheduled',
      moderatorUserId: '12345678901234596',
      source: 'SCHEDULED',
      status: 'COMPLETED',
      reason: 'expiry',
    });
    expect(CaseDtoSchema.parse(caseRow).source).toBe('SCHEDULED');
    const scheduler = new PrismaSchedulerRepository(getDb());
    const job = await scheduler.scheduleReplacing({
      guildId,
      targetUserId: '12345678901234595',
      channelId: null,
      type: 'UNBAN',
      executeAt: new Date(Date.now() + 60_000),
      payload: { guildId, userId: '12345678901234595' },
    });
    await getDb().scheduledAction.update({
      where: { id: job.id },
      data: { executedCaseId: caseRow.id },
    });
    const roundTrip = await getDb().scheduledAction.findUnique({
      where: { id: job.id },
    });
    expect(JobDtoSchema.parse(roundTrip).executedCaseId).toBe(caseRow.id);
    const nullJob = await scheduler.scheduleReplacing({
      guildId,
      targetUserId: '12345678901234597',
      channelId: null,
      type: 'UNBAN',
      executeAt: new Date(Date.now() + 60_000),
      payload: { guildId, userId: '12345678901234597' },
    });
    expect(
      (await getDb().scheduledAction.findUnique({ where: { id: nullJob.id } }))
        ?.executedCaseId,
    ).toBeNull();
    await expect(
      getDb().scheduledAction.update({
        where: { id: nullJob.id },
        data: { executedCaseId: caseRow.id },
      }),
    ).rejects.toThrow(/unique|scheduled_actions_executed_case_id_key/i);
    await expect(
      getDb()
        .$executeRaw`UPDATE scheduled_actions SET executed_case_id = ${'00000000-0000-4000-8000-000000000099'}::uuid WHERE id = ${nullJob.id}::uuid`,
    ).rejects.toThrow(/foreign key|scheduled_actions_executed_case_id_fkey/i);
  });

  it('upgrades legacy rows without changing job status or data', async () => {
    const legacyContainer = await new PostgreSqlContainer(
      'postgres:16-alpine',
    ).start();
    const legacyDb = new PrismaClient({
      datasources: { db: { url: legacyContainer.getConnectionUri() } },
    });
    try {
      const initial = await readFile(
        'prisma/migrations/20260714000000_initial_persistence/migration.sql',
        'utf8',
      );
      const phaseOne = await readFile(
        'prisma/migrations/20260719000000_add_scheduled_case_execution/migration.sql',
        'utf8',
      );
      await executeSqlStatements(legacyDb, initial);
      const caseId = '00000000-0000-4000-8000-000000000091';
      const jobIds = [
        '00000000-0000-4000-8000-000000000092',
        '00000000-0000-4000-8000-000000000093',
        '00000000-0000-4000-8000-000000000094',
        '00000000-0000-4000-8000-000000000095',
        '00000000-0000-4000-8000-000000000096',
      ];
      await legacyDb.$executeRaw`INSERT INTO guild_settings (guild_id, created_at, updated_at) VALUES ('12345678901234590', now(), now())`;
      await legacyDb.$executeRaw`INSERT INTO moderation_cases (id, guild_id, case_number, action, target_user_id, target_display, moderator_user_id, source, status, metadata, created_at, updated_at) VALUES (${caseId}::uuid, '12345678901234590', 1, 'BAN', '12345678901234595', 'legacy', '12345678901234593', 'EXTERNAL', 'COMPLETED', '{}', now(), now())`;
      for (const [index, status] of [
        'PENDING',
        'RUNNING',
        'COMPLETED',
        'FAILED',
        'CANCELLED',
      ].entries()) {
        const jobId = jobIds[index];
        if (!jobId) throw new Error('missing legacy job id');
        await legacyDb.$executeRaw`INSERT INTO scheduled_actions (id, guild_id, target_user_id, type, execute_at, status, payload, created_at, updated_at) VALUES (${jobId}::uuid, '12345678901234590', '12345678901234595', 'UNBAN', now(), ${status}::"ScheduledActionStatus", ${JSON.stringify({ guildId: '12345678901234590', userId: '12345678901234595' })}::jsonb, now(), now())`;
      }
      const legacyCase = await legacyDb.$queryRaw<
        Array<{
          action: string;
          target_user_id: string | null;
          target_display: string;
          case_number: number;
          source: string;
          status: string;
        }>
      >`SELECT action, target_user_id, target_display, case_number, source, status FROM moderation_cases WHERE id = ${caseId}::uuid`;
      await executeSqlStatements(legacyDb, phaseOne);
      const rows = await legacyDb.$queryRaw<
        Array<{ status: string; executed_case_id: string | null }>
      >`SELECT status, executed_case_id FROM scheduled_actions ORDER BY id`;
      expect(rows.map((row) => row.status)).toEqual([
        'PENDING',
        'RUNNING',
        'COMPLETED',
        'FAILED',
        'CANCELLED',
      ]);
      expect(rows.every((row) => row.executed_case_id === null)).toBe(true);
      expect(
        await legacyDb.$queryRaw<
          Array<{
            action: string;
            target_user_id: string | null;
            target_display: string;
            case_number: number;
            source: string;
            status: string;
          }>
        >`SELECT action, target_user_id, target_display, case_number, source, status FROM moderation_cases WHERE id = ${caseId}::uuid`,
      ).toEqual(legacyCase);
    } finally {
      await legacyDb.$disconnect();
      await legacyContainer.stop();
    }
  }, 120_000);

  it('does not lose concurrent locked strike changes', async () => {
    const repository = new PrismaStrikeRepository(getDb());
    await Promise.all(
      Array.from({ length: 10 }, () =>
        repository.changeLocked({
          guildId: '12345678901234567',
          userId: '12345678901234569',
          requestedDelta: 1,
          source: 'MANUAL_STRIKE',
          caseInput: {
            guildId: '12345678901234567',
            action: 'STRIKE',
            targetUserId: '12345678901234569',
            targetDisplay: 'user',
            moderatorUserId: '12345678901234568',
            source: 'COMMAND',
            status: 'COMPLETED',
            reason: 'test',
          },
          actorUserId: '12345678901234568',
          reason: 'test',
        }),
      ),
    );
    const strike = await getDb().userStrike.findUnique({
      where: {
        guildId_userId: {
          guildId: '12345678901234567',
          userId: '12345678901234569',
        },
      },
    });
    expect(strike?.count).toBe(10);
  });

  it('returns a zero no-op and applies Pardon as subtraction', async () => {
    const repository = new PrismaStrikeRepository(getDb());
    const noOp = await repository.changeLocked({
      guildId: '12345678901234567',
      userId: '12345678901234572',
      requestedDelta: 1,
      source: 'PARDON',
      actorUserId: '12345678901234568',
      reason: 'noop',
      caseInput: {
        guildId: '12345678901234567',
        action: 'PARDON',
        targetUserId: '12345678901234572',
        targetDisplay: 'user',
        moderatorUserId: '12345678901234568',
        source: 'COMMAND',
        status: 'COMPLETED',
        reason: 'noop',
      },
    });
    expect(noOp.transaction).toBeNull();
    await repository.changeLocked({
      guildId: '12345678901234567',
      userId: '12345678901234572',
      requestedDelta: 3,
      source: 'MANUAL_STRIKE',
      actorUserId: '12345678901234568',
      reason: 'add',
      caseInput: {
        guildId: '12345678901234567',
        action: 'STRIKE',
        targetUserId: '12345678901234572',
        targetDisplay: 'user',
        moderatorUserId: '12345678901234568',
        source: 'COMMAND',
        status: 'COMPLETED',
        reason: 'add',
      },
    });
    const pardon = await repository.changeLocked({
      guildId: '12345678901234567',
      userId: '12345678901234572',
      requestedDelta: 1,
      source: 'PARDON',
      actorUserId: '12345678901234568',
      reason: 'pardon',
      caseInput: {
        guildId: '12345678901234567',
        action: 'PARDON',
        targetUserId: '12345678901234572',
        targetDisplay: 'user',
        moderatorUserId: '12345678901234568',
        source: 'COMMAND',
        status: 'COMPLETED',
        reason: 'pardon',
      },
    });
    expect(pardon.afterCount).toBe(2);
  });

  it('scheduler claim/replacement/recovery/exhaustion', async () => {
    const scheduler = new PrismaSchedulerRepository(
      getDb(),
      () => new Date('2026-01-01T00:00:00Z'),
    );
    const input = {
      guildId: '12345678901234567',
      targetUserId: '12345678901234569',
      channelId: null,
      type: 'UNBAN' as const,
      executeAt: new Date('2025-12-31T23:59:00Z'),
      payload: { guildId: '12345678901234567', userId: '12345678901234569' },
    };
    const job = await scheduler.scheduleReplacing(input);
    const replacement = await scheduler.scheduleReplacing({
      ...input,
      executeAt: new Date('2025-12-31T23:58:00Z'),
    });
    expect(await scheduler.getStatus(job.id)).toBe('CANCELLED');
    expect(
      (
        await scheduler.claimDue(
          10,
          'worker-a',
          new Date('2026-01-01T00:00:00Z'),
          ['UNBAN'],
        )
      ).some((item) => item.id === replacement.id),
    ).toBe(true);
    expect(await scheduler.complete(replacement.id, 'worker-b')).toBe(false);
    expect(await scheduler.complete(replacement.id, 'worker-a')).toBe(true);
    const stale = await scheduler.scheduleReplacing({
      ...input,
      targetUserId: '12345678901234570',
      payload: { guildId: '12345678901234567', userId: '12345678901234570' },
    });
    await scheduler.claimDue(10, 'worker-c', new Date('2026-01-01T00:00:00Z'));
    await getDb().scheduledAction.update({
      where: { id: stale.id },
      data: { lockedAt: new Date('2025-01-01T00:00:00Z') },
    });
    expect(
      await scheduler.recoverStale(new Date('2026-01-01T00:00:00Z')),
    ).toBeGreaterThan(0);
    await getDb().scheduledAction.update({
      where: { id: stale.id },
      data: {
        status: 'RUNNING',
        attempts: 5,
        lockedAt: new Date('2025-01-01T00:00:00Z'),
        lockedBy: 'worker-c',
      },
    });
    await scheduler.recoverStale(new Date('2026-01-01T00:00:00Z'));
    expect(await scheduler.getStatus(stale.id)).toBe('FAILED');
  });

  it('case reason/default and channel cleanup', async () => {
    const cases = new PrismaCaseRepository(getDb());
    const item = await cases.createWithNumber({
      guildId: '12345678901234567',
      action: 'BAN',
      targetDisplay: 'reason-test',
      moderatorUserId: '12345678901234568',
      source: 'COMMAND',
      status: 'COMPLETED',
      reason: null,
    });
    expect((await cases.latest('12345678901234567'))?.reason).toBe(
      '理由未指定',
    );
    expect(
      (
        await cases.findByGuildAndNumber(
          '12345678901234567',
          (item as { caseNumber: number }).caseNumber,
        )
      )?.id,
    ).toBe((item as { id: string }).id);
    await cases.updateReason((item as { id: string }).id, 'later reason');
    const missing = await cases.createWithNumber({
      guildId: '12345678901234567',
      action: 'BAN',
      targetDisplay: 'missing-reason',
      moderatorUserId: '12345678901234568',
      source: 'COMMAND',
      status: 'COMPLETED',
      reason: null,
    });
    const reasoned = await cases.createWithNumber({
      guildId: '12345678901234567',
      action: 'BAN',
      targetDisplay: 'reasoned-later',
      moderatorUserId: '12345678901234568',
      source: 'COMMAND',
      status: 'COMPLETED',
      reason: 'later',
    });
    expect((await cases.latest('12345678901234567'))?.id).toBe(
      (missing as { id: string }).id,
    );
    expect((await cases.get((reasoned as { id: string }).id))?.reason).toBe(
      'later',
    );
    const channel = '12345678901234570';
    await getDb().guildSettings.update({
      where: { guildId: '12345678901234567' },
      data: { modlogChannelId: channel },
    });
    const ignores = new PrismaIgnoreRepository(getDb());
    await ignores.setChannel('12345678901234567', channel, '12345678901234568');
    await new PrismaSchedulerRepository(getDb()).scheduleReplacing({
      guildId: '12345678901234567',
      targetUserId: null,
      channelId: channel,
      type: 'RESTORE_SLOWMODE',
      executeAt: new Date(Date.now() + 60_000),
      payload: {
        guildId: '12345678901234567',
        channelId: channel,
        interval: 10,
      },
    });
    const channelSnapshot = new PrismaSnapshotRepository(getDb());
    await channelSnapshot.upsertMessage({
      messageId: '12345678901234586',
      guildId: '12345678901234567',
      channelId: channel,
      authorUserId: '12345678901234568',
      authorDisplay: 'cleanup',
      content: 'cleanup',
      attachments: [],
      embedsSummary: {},
      expiresAt: new Date(Date.now() + 60_000),
    });
    await ignores.clearChannel('12345678901234567', channel);
    expect(
      (
        await getDb().guildSettings.findUnique({
          where: { guildId: '12345678901234567' },
        })
      )?.modlogChannelId,
    ).toBeNull();
    expect(await channelSnapshot.getMessage('12345678901234586')).toBeNull();
    expect(
      (await ignores.listChannels('12345678901234567')).some(
        (row) => row.channelId === channel,
      ),
    ).toBe(false);
    expect(
      (
        await getDb().scheduledAction.findMany({
          where: { guildId: '12345678901234567', channelId: channel },
        })
      ).every((row) => row.status === 'CANCELLED'),
    ).toBe(true);
  });

  it('two workers claim disjoint due jobs concurrently', async () => {
    const scheduler = new PrismaSchedulerRepository(getDb());
    const users = [
      '12345678901234580',
      '12345678901234581',
      '12345678901234582',
      '12345678901234583',
      '12345678901234584',
      '12345678901234585',
    ];
    await Promise.all(
      users.map((userId) =>
        scheduler.scheduleReplacing({
          guildId: '12345678901234567',
          targetUserId: userId,
          channelId: null,
          type: 'UNBAN',
          executeAt: new Date(Date.now() - 1000),
          payload: { guildId: '12345678901234567', userId },
        }),
      ),
    );
    const [left, right] = await Promise.all([
      scheduler.claimDue(50, 'worker-left'),
      scheduler.claimDue(50, 'worker-right'),
    ]);
    const leftIds = new Set(left.map((job) => job.id));
    expect(right.every((job) => !leftIds.has(job.id))).toBe(true);
    expect(left.length + right.length).toBeGreaterThanOrEqual(users.length);
  });

  it('punishment transaction and removal', async () => {
    const punishments = new PrismaPunishmentRepository(getDb());
    await punishments.replace(
      '12345678901234567',
      25,
      'BAN',
      60,
      '12345678901234568',
    );
    expect(
      (await punishments.list('12345678901234567')).some(
        (item) => item.threshold === 25,
      ),
    ).toBe(true);
    expect(await punishments.remove('12345678901234567', 25)).toBe(true);
    await punishments.replace(
      '12345678901234567',
      2,
      'BAN',
      null,
      '12345678901234568',
    );
    const strike = await new PrismaStrikeRepository(getDb()).changeLocked({
      guildId: '12345678901234567',
      userId: '12345678901234576',
      requestedDelta: 2,
      source: 'MANUAL_STRIKE',
      actorUserId: '12345678901234568',
      reason: 'cross',
      caseInput: {
        guildId: '12345678901234567',
        action: 'STRIKE',
        targetUserId: '12345678901234576',
        targetDisplay: 'cross',
        moderatorUserId: '12345678901234568',
        source: 'COMMAND',
        status: 'COMPLETED',
        reason: 'cross',
      },
    });
    expect(strike.crossedPunishments).toHaveLength(1);
    expect(strike.transaction).not.toBeNull();
    const linkedCaseId = strike.transaction?.modCaseId;
    expect(linkedCaseId).toBeTruthy();
    if (linkedCaseId)
      expect(
        await getDb().moderationCase.findUnique({
          where: { id: linkedCaseId },
        }),
      ).not.toBeNull();
    expect(
      await getDb().strikeTransaction.count({
        where: { guildId: '12345678901234567', userId: '12345678901234576' },
      }),
    ).toBe(1);
    expect(
      (
        await getDb().userStrike.findUnique({
          where: {
            guildId_userId: {
              guildId: '12345678901234567',
              userId: '12345678901234576',
            },
          },
        })
      )?.count,
    ).toBe(2);
    await punishments.remove('12345678901234567', 2);
    const beforeRollback = await getDb().userStrike.findUnique({
      where: {
        guildId_userId: {
          guildId: '12345678901234567',
          userId: '12345678901234576',
        },
      },
    });
    await expect(
      getDb().$transaction(async (tx) => {
        await tx.userStrike.update({
          where: {
            guildId_userId: {
              guildId: '12345678901234567',
              userId: '12345678901234576',
            },
          },
          data: { count: { increment: 1 } },
        });
        await tx.$executeRawUnsafe(
          'INSERT INTO user_strikes (guild_id, user_id, count) VALUES ($1, $2, $3)',
          '12345678901234567',
          '12345678901234576',
          -1,
        );
      }),
    ).rejects.toBeTruthy();
    expect(
      (
        await getDb().userStrike.findUnique({
          where: {
            guildId_userId: {
              guildId: '12345678901234567',
              userId: '12345678901234576',
            },
          },
        })
      )?.count,
    ).toBe(beforeRollback?.count);
    await getDb().$executeRawUnsafe(
      "CREATE OR REPLACE FUNCTION ora3_fail_strike() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced late failure'; END; $$",
    );
    await getDb().$executeRawUnsafe(
      'CREATE TRIGGER ora3_fail_strike_trigger BEFORE INSERT ON strike_transactions FOR EACH ROW EXECUTE FUNCTION ora3_fail_strike()',
    );
    const rollbackUser = '12345678901234581';
    await expect(
      new PrismaStrikeRepository(getDb()).changeLocked({
        guildId: '12345678901234567',
        userId: rollbackUser,
        requestedDelta: 1,
        source: 'MANUAL_STRIKE',
        actorUserId: '12345678901234568',
        reason: 'forced rollback',
        caseInput: {
          guildId: '12345678901234567',
          action: 'STRIKE',
          targetUserId: rollbackUser,
          targetDisplay: 'rollback',
          moderatorUserId: '12345678901234568',
          source: 'COMMAND',
          status: 'COMPLETED',
          reason: 'forced rollback',
        },
      }),
    ).rejects.toThrow();
    await getDb().$executeRawUnsafe(
      'DROP TRIGGER ora3_fail_strike_trigger ON strike_transactions',
    );
    await getDb().$executeRawUnsafe('DROP FUNCTION ora3_fail_strike()');
    expect(
      await getDb().userStrike.findUnique({
        where: {
          guildId_userId: {
            guildId: '12345678901234567',
            userId: rollbackUser,
          },
        },
      }),
    ).toBeNull();
    expect(
      await getDb().moderationCase.count({
        where: { guildId: '12345678901234567', targetUserId: rollbackUser },
      }),
    ).toBe(0);
    expect(
      await getDb().strikeTransaction.count({
        where: { guildId: '12345678901234567', userId: rollbackUser },
      }),
    ).toBe(0);
  });

  it('active mute atomic transition', async () => {
    const caseRecord = await new PrismaCaseRepository(getDb()).createWithNumber(
      {
        guildId: '12345678901234567',
        action: 'MUTE',
        targetUserId: '12345678901234569',
        targetDisplay: 'mute-test',
        moderatorUserId: '12345678901234568',
        source: 'COMMAND',
        status: 'COMPLETED',
        reason: 'test',
      },
    );
    const mute = new PrismaActiveMuteRepository(getDb());
    const expiry = new Date(Date.now() + 60_000);
    await mute.activateWithSchedule(
      '12345678901234567',
      '12345678901234569',
      (caseRecord as { id: string }).id,
      expiry,
      { guildId: '12345678901234567', userId: '12345678901234569' },
    );
    const replacementExpiry = new Date(Date.now() + 120_000);
    await mute.activateWithSchedule(
      '12345678901234567',
      '12345678901234569',
      (caseRecord as { id: string }).id,
      replacementExpiry,
      { guildId: '12345678901234567', userId: '12345678901234569' },
    );
    expect(
      await getDb().scheduledAction.count({
        where: {
          guildId: '12345678901234567',
          targetUserId: '12345678901234569',
          type: 'UNMUTE',
          status: 'CANCELLED',
        },
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      (await mute.getActive('12345678901234567', '12345678901234569'))?.status,
    ).toBe('ACTIVE');
    await mute.releaseWithSchedule(
      '12345678901234567',
      '12345678901234569',
      'RELEASED',
    );
    expect(
      await mute.getActive('12345678901234567', '12345678901234569'),
    ).toBeNull();
    expect(
      await getDb().scheduledAction.count({
        where: {
          guildId: '12345678901234567',
          targetUserId: '12345678901234569',
          type: 'UNMUTE',
          status: 'PENDING',
        },
      }),
    ).toBe(0);
    await mute.activateWithSchedule(
      '12345678901234567',
      '12345678901234569',
      (caseRecord as { id: string }).id,
      replacementExpiry,
      { guildId: '12345678901234567', userId: '12345678901234569' },
    );
    const muteScheduler = new PrismaSchedulerRepository(getDb());
    const dueMute = await muteScheduler.claimDue(
      10,
      'mute-worker',
      new Date(replacementExpiry.getTime() + 1),
    );
    const muteJob = dueMute.find(
      (job) =>
        job.type === 'UNMUTE' && job.targetUserId === '12345678901234569',
    );
    expect(muteJob).toBeDefined();
    const requiredMuteJob = requireDefined(
      muteJob,
      'expected an expiry job to be claimed',
    );
    expect(
      await mute.expireWithSchedule(
        '12345678901234567',
        '12345678901234569',
        requiredMuteJob.id,
        'wrong-worker',
        new Date(replacementExpiry.getTime() + 1),
      ),
    ).toBe(false);
    expect(
      await mute.expireWithSchedule(
        '12345678901234567',
        '12345678901234569',
        requiredMuteJob.id,
        'mute-worker',
        new Date(replacementExpiry.getTime() + 1),
      ),
    ).toBe(true);
    const cancelledBeforeConcurrent = await getDb().scheduledAction.count({
      where: {
        guildId: '12345678901234567',
        targetUserId: '12345678901234569',
        type: 'UNMUTE',
        status: 'CANCELLED',
      },
    });
    await Promise.all([
      mute.activateWithSchedule(
        '12345678901234567',
        '12345678901234569',
        (caseRecord as { id: string }).id,
        new Date(Date.now() + 180_000),
        { guildId: '12345678901234567', userId: '12345678901234569' },
      ),
      mute.activateWithSchedule(
        '12345678901234567',
        '12345678901234569',
        (caseRecord as { id: string }).id,
        new Date(Date.now() + 240_000),
        { guildId: '12345678901234567', userId: '12345678901234569' },
      ),
    ]);
    expect(
      (await mute.getActive('12345678901234567', '12345678901234569'))?.status,
    ).toBe('ACTIVE');
    expect(
      await getDb().scheduledAction.count({
        where: {
          guildId: '12345678901234567',
          targetUserId: '12345678901234569',
          type: 'UNMUTE',
          status: 'PENDING',
        },
      }),
    ).toBe(1);
    expect(
      await getDb().scheduledAction.count({
        where: {
          guildId: '12345678901234567',
          targetUserId: '12345678901234569',
          type: 'UNMUTE',
          status: 'CANCELLED',
        },
      }),
    ).toBeGreaterThan(cancelledBeforeConcurrent);
  });

  it('raid concurrency and replacement', async () => {
    const raid = new PrismaRaidRepository(getDb());
    const activation = {
      guildId: '12345678901234567',
      actorUserId: '12345678901234568',
      source: 'AUTO' as const,
      changed: false,
      reason: 'test',
    };
    await new PrismaSchedulerRepository(getDb()).scheduleReplacing({
      guildId: '12345678901234567',
      targetUserId: null,
      channelId: null,
      type: 'DISABLE_RAIDMODE',
      executeAt: new Date(Date.now() + 300_000),
      payload: { guildId: '12345678901234567' },
    });
    const results = await Promise.all(
      ['12345678901234571', '12345678901234572', '12345678901234573'].map(
        (userId) =>
          raid.recordJoinAndEvaluate(
            '12345678901234567',
            userId,
            new Date(),
            3,
            10,
            activation,
          ),
      ),
    );
    expect(results.some((result) => result.activated)).toBe(true);
    expect(
      await getDb().moderationCase.count({
        where: { guildId: '12345678901234567', action: 'RAIDMODE_ON' },
      }),
    ).toBe(1);
    expect(
      await getDb().scheduledAction.count({
        where: {
          guildId: '12345678901234567',
          type: 'DISABLE_RAIDMODE',
          status: 'CANCELLED',
        },
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await getDb().scheduledAction.count({
        where: {
          guildId: '12345678901234567',
          type: 'DISABLE_RAIDMODE',
          status: 'PENDING',
        },
      }),
    ).toBe(1);
  });

  it('lifecycle/rejoin cleanup and retention', async () => {
    const lifecycle = new PrismaDepartureRepository(getDb());
    const departed = new Date('2025-01-01T00:00:00Z');
    await lifecycle.markLeft({
      guildId: '12345678901234567',
      departedAt: departed,
    });
    await lifecycle.markActive(
      '12345678901234567',
      new Date('2025-01-02T00:00:00Z'),
    );
    expect(
      await new PrismaRetentionRepository(getDb()).deleteOldRaidEvents(
        new Date('2026-01-01T00:00:00Z'),
      ),
    ).toBeGreaterThanOrEqual(0);
    const cleanupGuild = '12345678901234577';
    await lifecycle.markLeft({
      guildId: cleanupGuild,
      departedAt: new Date('2025-01-01T00:00:00Z'),
    });
    const cleanupCase = await new PrismaCaseRepository(
      getDb(),
    ).createWithNumber({
      guildId: cleanupGuild,
      action: 'BAN',
      targetDisplay: 'dependent',
      moderatorUserId: '12345678901234568',
      source: 'COMMAND',
      status: 'COMPLETED',
      reason: 'dependent',
    });
    await new PrismaStrikeRepository(getDb()).changeLocked({
      guildId: cleanupGuild,
      userId: '12345678901234580',
      requestedDelta: 1,
      source: 'MANUAL_STRIKE',
      actorUserId: '12345678901234568',
      reason: 'dependent',
      caseInput: {
        guildId: cleanupGuild,
        action: 'STRIKE',
        targetUserId: '12345678901234580',
        targetDisplay: 'dependent',
        moderatorUserId: '12345678901234568',
        source: 'COMMAND',
        status: 'COMPLETED',
        reason: 'dependent',
      },
    });
    const cleanupSnapshot = new PrismaSnapshotRepository(getDb());
    await cleanupSnapshot.upsertMessage({
      messageId: '12345678901234587',
      guildId: cleanupGuild,
      channelId: '12345678901234570',
      authorUserId: '12345678901234568',
      authorDisplay: 'dependent',
      content: 'dependent',
      attachments: [],
      embedsSummary: {},
      expiresAt: new Date(Date.now() + 60_000),
    });
    const muteCase = await new PrismaCaseRepository(getDb()).createWithNumber({
      guildId: cleanupGuild,
      action: 'MUTE',
      targetUserId: '12345678901234580',
      targetDisplay: 'mute',
      moderatorUserId: '12345678901234568',
      source: 'COMMAND',
      status: 'COMPLETED',
      reason: 'dependent',
    });
    await new PrismaActiveMuteRepository(getDb()).activateWithSchedule(
      cleanupGuild,
      '12345678901234580',
      (muteCase as { id: string }).id,
      null,
      { guildId: cleanupGuild, userId: '12345678901234580' },
    );
    const terminalJob = await new PrismaSchedulerRepository(
      getDb(),
    ).scheduleReplacing({
      guildId: cleanupGuild,
      targetUserId: '12345678901234581',
      channelId: null,
      type: 'UNBAN',
      executeAt: new Date(Date.now() + 300_000),
      payload: { guildId: cleanupGuild, userId: '12345678901234581' },
    });
    await getDb().scheduledAction.update({
      where: { id: terminalJob.id },
      data: { status: 'COMPLETED' },
    });
    const protectedJob = await new PrismaSchedulerRepository(
      getDb(),
    ).scheduleReplacing({
      guildId: cleanupGuild,
      targetUserId: '12345678901234580',
      channelId: null,
      type: 'UNBAN',
      executeAt: new Date(Date.now() + 300_000),
      payload: { guildId: cleanupGuild, userId: '12345678901234580' },
      createdByCaseId: (cleanupCase as { id: string }).id,
    });
    expect(
      await lifecycle.cleanupEligible(new Date('2026-01-01T00:00:00Z')),
    ).toBe(0);
    await getDb().scheduledAction.update({
      where: { id: protectedJob.id },
      data: { status: 'CANCELLED' },
    });
    expect(
      await lifecycle.cleanupEligible(new Date('2026-01-01T00:00:00Z')),
    ).toBeGreaterThan(0);
    expect(
      await getDb().guildLifecycleMarker.findUnique({
        where: { guildId: cleanupGuild },
      }),
    ).toBeNull();
    expect(
      await getDb().guildSettings.findUnique({
        where: { guildId: cleanupGuild },
      }),
    ).toBeNull();
    expect(
      await getDb().userStrike.count({ where: { guildId: cleanupGuild } }),
    ).toBe(0);
    expect(
      await getDb().strikeTransaction.count({
        where: { guildId: cleanupGuild },
      }),
    ).toBe(0);
    expect(
      await getDb().moderationCase.count({ where: { guildId: cleanupGuild } }),
    ).toBe(0);
    expect(
      await getDb().activeMute.count({ where: { guildId: cleanupGuild } }),
    ).toBe(0);
    expect(
      await getDb().messageSnapshot.count({ where: { guildId: cleanupGuild } }),
    ).toBe(0);
    expect(
      await getDb().scheduledAction.count({ where: { guildId: cleanupGuild } }),
    ).toBe(0);
    await lifecycle.markLeft({
      guildId: cleanupGuild,
      departedAt: new Date('2025-01-01T00:00:00Z'),
    });
    await lifecycle.markActive(cleanupGuild, new Date('2025-01-02T00:00:00Z'));
    expect(
      await lifecycle.cleanupEligible(new Date('2026-01-01T00:00:00Z')),
    ).toBe(0);
    const rollbackGuild = '12345678901234588';
    await lifecycle.markLeft({
      guildId: rollbackGuild,
      departedAt: new Date('2025-01-01T00:00:00Z'),
    });
    await new PrismaCaseRepository(getDb()).createWithNumber({
      guildId: rollbackGuild,
      action: 'BAN',
      targetDisplay: 'rollback',
      moderatorUserId: '12345678901234568',
      source: 'COMMAND',
      status: 'COMPLETED',
      reason: 'rollback',
    });
    await getDb().$executeRawUnsafe(
      "CREATE OR REPLACE FUNCTION ora3_fail_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced cleanup rollback'; END; $$",
    );
    await getDb().$executeRawUnsafe(
      'CREATE TRIGGER ora3_fail_cleanup_trigger BEFORE DELETE ON guild_settings FOR EACH ROW EXECUTE FUNCTION ora3_fail_cleanup()',
    );
    await expect(
      lifecycle.cleanupEligible(new Date('2026-01-01T00:00:00Z')),
    ).rejects.toThrow();
    await getDb().$executeRawUnsafe(
      'DROP TRIGGER ora3_fail_cleanup_trigger ON guild_settings',
    );
    await getDb().$executeRawUnsafe('DROP FUNCTION ora3_fail_cleanup()');
    expect(
      await getDb().guildLifecycleMarker.findUnique({
        where: { guildId: rollbackGuild },
      }),
    ).not.toBeNull();
    expect(
      await getDb().guildSettings.findUnique({
        where: { guildId: rollbackGuild },
      }),
    ).not.toBeNull();
    expect(
      await getDb().moderationCase.count({ where: { guildId: rollbackGuild } }),
    ).toBe(1);
  });

  it('snapshot read and bulk read', async () => {
    const snapshots = new PrismaSnapshotRepository(getDb());
    await snapshots.upsertMessage({
      messageId: '12345678901234574',
      guildId: '12345678901234575',
      channelId: '12345678901234570',
      authorUserId: '12345678901234568',
      authorDisplay: 'snapshot',
      content: 'body',
      attachments: [],
      embedsSummary: {},
      expiresAt: new Date('2026-01-02T00:00:00Z'),
    });
    expect(await snapshots.getMessage('12345678901234574')).not.toBeNull();
    expect((await snapshots.getMessages(['12345678901234574'])).length).toBe(1);
    expect(
      await getDb().guildSettings.findUnique({
        where: { guildId: '12345678901234575' },
      }),
    ).not.toBeNull();
  });

  it('rejects persistence constraints', async () => {
    await expectConstraint(
      getDb().$executeRawUnsafe(
        'INSERT INTO automod_settings (guild_id, anti_invite_strikes, anti_referral_strikes, anti_everyone_strikes, anti_copypasta_strikes, max_lines, duplicate_strikes, auto_raid_join_count, auto_raid_window_seconds, auto_raid_idle_seconds, created_at, updated_at) VALUES ($1, 0, 0, 0, 0, $2, 1, 10, 10, 120, now(), now())',
        '12345678901234567',
        501,
      ),
      'automod_settings_bounds',
    );
    await expectConstraint(
      getDb().$executeRawUnsafe(
        'INSERT INTO scheduled_actions (id, guild_id, target_user_id, channel_id, type, execute_at, payload, attempts, created_at, updated_at) VALUES ($1::uuid, $2, NULL, $3, $4::"ScheduledActionType", now(), $5::jsonb, $6, now(), now())',
        '00000000-0000-4000-8000-000000000001',
        '12345678901234567',
        '12345678901234570',
        'RESTORE_SLOWMODE',
        JSON.stringify({
          guildId: '12345678901234567',
          channelId: '12345678901234570',
          interval: 10,
        }),
        6,
      ),
      'scheduled_actions_attempts_valid',
    );
    await expectConstraint(
      getDb().$executeRawUnsafe(
        'INSERT INTO scheduled_actions (id, guild_id, target_user_id, channel_id, type, execute_at, payload, created_at, updated_at) VALUES ($1::uuid, $2, NULL, $3, $4::"ScheduledActionType", now(), $5::jsonb, now(), now())',
        '00000000-0000-4000-8000-000000000002',
        '12345678901234567',
        '12345678901234570',
        'UNBAN',
        JSON.stringify({
          guildId: '12345678901234567',
          userId: '12345678901234569',
        }),
      ),
      'scheduled_actions_target_channel_shape',
    );
    await expectConstraint(
      getDb().$executeRawUnsafe(
        'INSERT INTO punishments (id, guild_id, threshold, action, duration_seconds, created_by, created_at, updated_at) VALUES ($1::uuid, $2, 3, $3::"PunishmentAction", 10, $4, now(), now())',
        '00000000-0000-4000-8000-000000000003',
        '12345678901234567',
        'KICK',
        '12345678901234568',
      ),
      'punishments_action_duration_valid',
    );
    await expectConstraint(
      getDb().$executeRawUnsafe(
        'INSERT INTO guild_lifecycle_markers (guild_id, status, created_at, updated_at) VALUES ($1, $2::"GuildLifecycleStatus", now(), now())',
        '12345678901234578',
        'LEFT',
      ),
      'guild_lifecycle_left_dates_valid',
    );
    await expectConstraint(
      getDb().$executeRawUnsafe(
        'INSERT INTO message_snapshots (message_id, guild_id, channel_id, author_user_id, author_display, content, attachments, embeds_summary, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, repeat($6, 4001), $7::jsonb, $8::jsonb, now(), now())',
        '12345678901234579',
        '12345678901234567',
        '12345678901234570',
        '12345678901234568',
        'too-long',
        'x',
        JSON.stringify([]),
        JSON.stringify({}),
      ),
      'message_snapshots_content_length',
    );
    const existingCase = requireDefined(
      await getDb().moderationCase.findFirst({
        where: { guildId: '12345678901234567' },
      }),
      'expected a prerequisite moderation case for active mute constraint test',
    );
    await expectConstraint(
      getDb().$executeRawUnsafe(
        "INSERT INTO active_mutes (guild_id, user_id, case_id, expires_at, created_at, updated_at) VALUES ($1, $2, $3::uuid, now() - interval '1 second', now(), now())",
        '12345678901234567',
        '12345678901234580',
        existingCase.id,
      ),
      'active_mutes_expiry_valid',
    );
  });

  function getDb(): PrismaClient {
    if (!db) throw new Error('integration database was not initialized');
    return db;
  }

  async function expectConstraint(
    operation: Promise<unknown>,
    constraint: string,
  ) {
    let failure: unknown;
    try {
      await operation;
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    const text = failure instanceof Error ? failure.message : String(failure);
    expect(text).toContain(constraint);
    expect(text).toMatch(/23514|check constraint/i);
  }

  async function executeSqlStatements(client: PrismaClient, sql: string) {
    for (const statement of splitSqlStatements(sql))
      await client.$executeRawUnsafe(statement);
  }

  function splitSqlStatements(sql: string): string[] {
    const statements: string[] = [];
    let start = 0;
    let quote: "'" | '"' | null = null;
    let dollarQuote: string | null = null;
    for (let index = 0; index < sql.length; index += 1) {
      const character = sql[index];
      const next = sql[index + 1];
      if (dollarQuote) {
        if (sql.startsWith(dollarQuote, index)) {
          index += dollarQuote.length - 1;
          dollarQuote = null;
        }
        continue;
      }
      if (quote) {
        if (character === quote && sql[index - 1] !== '\\') quote = null;
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        continue;
      }
      if (character === '$') {
        const match = sql.slice(index).match(/^\$[A-Za-z_0-9]*\$/u);
        if (match?.[0]) {
          dollarQuote = match[0];
          index += match[0].length - 1;
          continue;
        }
      }
      if (character === ';') {
        const statement = sql.slice(start, index).trim();
        if (statement) statements.push(statement);
        start = index + 1;
      } else if (character === '-' && next === '-') {
        const lineEnd = sql.indexOf('\n', index);
        if (lineEnd >= 0) index = lineEnd;
      }
    }
    const remainder = sql.slice(start).trim();
    if (remainder) statements.push(remainder);
    return statements;
  }

  function requireDefined<T>(value: T | null | undefined, message: string): T {
    if (value === null || value === undefined) throw new Error(message);
    return value;
  }
});
