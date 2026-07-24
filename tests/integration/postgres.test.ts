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
import { SchedulerService } from '../../src/services/scheduler-service.js';
import { ScheduledModerationDispatcher } from '../../src/features/moderation/scheduled-dispatch.js';
import {
  CaseDtoSchema,
  JobDtoSchema,
  SCHEDULED_MAX_ATTEMPTS,
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
      Array.from({ length: 8 }, () => service.createExternalCaseResult(input)),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(
      results.map((result) => (result.ok ? result.value.created : null)).sort(),
    ).toEqual([false, false, false, false, false, false, false, true]);
    const ids = results.flatMap((result) =>
      result.ok ? [result.value.case.id] : [],
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

  it('creates one scheduled case across workers, retries, and legacy jobs', async () => {
    const guildId = '12345678901234610';
    const targetUserId = '12345678901234611';
    const moderatorUserId = '12345678901234612';
    const cases = new PrismaCaseRepository(getDb());
    const scheduler = new PrismaSchedulerRepository(getDb());
    const origin = await cases.createWithNumber({
      guildId,
      action: 'MUTE',
      targetUserId,
      targetDisplay: 'snapshot-name',
      moderatorUserId,
      source: 'COMMAND',
      status: 'COMPLETED',
      reason: 'temporary mute',
    });
    const job = await scheduler.scheduleReplacing({
      guildId,
      targetUserId,
      channelId: null,
      type: 'UNMUTE',
      executeAt: new Date(Date.now() - 1_000),
      payload: { guildId, userId: targetUserId },
      createdByCaseId: origin.id,
    });
    const workerOne = new SchedulerService(scheduler, {
      workerId: 'worker-one',
    });
    const workerTwo = new SchedulerService(scheduler, {
      workerId: 'worker-two',
    });
    const claimed = await workerOne.claimDue(1);
    expect(claimed.ok).toBe(true);
    const otherClaim = await workerTwo.claimDue(1);
    expect(otherClaim.ok).toBe(true);
    if (!otherClaim.ok) throw new Error('second worker claim failed');
    expect(otherClaim.value).toHaveLength(0);
    await expect(
      workerTwo.createScheduledCase(job.id, moderatorUserId),
    ).rejects.toThrow(/owned by worker/i);
    const [first, retry] = await Promise.all([
      workerOne.createScheduledCase(job.id, moderatorUserId),
      workerOne.createScheduledCase(job.id, moderatorUserId),
    ]);
    expect(first.ok && retry.ok).toBe(true);
    if (!first.ok || !retry.ok)
      throw new Error('scheduled case creation failed');
    expect(first.value.created || retry.value.created).toBe(true);
    expect(first.value.case.id).toBe(retry.value.case.id);
    expect(
      await getDb().moderationCase.count({
        where: { guildId, source: 'SCHEDULED' },
      }),
    ).toBe(1);
    expect(first.value.case.targetDisplay).toBe('snapshot-name');
    const wrongOwnerTerminalization = await workerTwo.terminalizeScheduledCase({
      jobId: job.id,
      executedCaseId: first.value.case.id,
      status: 'COMPLETED',
    });
    expect(
      wrongOwnerTerminalization.ok && wrongOwnerTerminalization.value,
    ).toBe(false);
    await getDb().scheduledAction.update({
      where: { id: job.id },
      data: { status: 'PENDING', lockedAt: null, lockedBy: null },
    });
    const reclaimed = await workerTwo.claimDue(1);
    expect(reclaimed.ok).toBe(true);
    if (!reclaimed.ok) throw new Error('reclaimed job claim failed');
    expect(reclaimed.value).toHaveLength(1);
    const reclaimedCase = await workerTwo.createScheduledCase(
      job.id,
      moderatorUserId,
    );
    expect(reclaimedCase.ok).toBe(true);
    if (!reclaimedCase.ok) throw new Error('reclaimed case creation failed');
    expect(reclaimedCase.value.created).toBe(false);
    expect(reclaimedCase.value.case.id).toBe(first.value.case.id);
    const terminalized = await workerTwo.terminalizeScheduledCase({
      jobId: job.id,
      executedCaseId: first.value.case.id,
      status: 'COMPLETED',
    });
    expect(terminalized.ok && terminalized.value).toBe(true);
    const duplicateTerminalization = await workerTwo.terminalizeScheduledCase({
      jobId: job.id,
      executedCaseId: first.value.case.id,
      status: 'COMPLETED',
    });
    expect(duplicateTerminalization.ok && duplicateTerminalization.value).toBe(
      false,
    );
    await expect(
      getDb().scheduledAction.findUnique({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      status: 'COMPLETED',
      executedCaseId: first.value.case.id,
    });

    const staleJob = await scheduler.scheduleReplacing({
      guildId,
      targetUserId: '12345678901234614',
      channelId: null,
      type: 'UNBAN',
      executeAt: new Date(Date.now() - 1_000),
      payload: { guildId, userId: '12345678901234614' },
    });
    const staleInitialClaim = await workerOne.claimDue(1);
    expect(staleInitialClaim.ok).toBe(true);
    if (!staleInitialClaim.ok) throw new Error('stale initial claim failed');
    expect(staleInitialClaim.value).toHaveLength(1);
    await getDb().scheduledAction.update({
      where: { id: staleJob.id },
      data: { lockedAt: new Date(Date.now() - 6 * 60_000) },
    });
    expect(await workerTwo.recoverStale()).toBe(1);
    const staleClaim = await workerTwo.claimDue(1);
    expect(staleClaim.ok).toBe(true);
    if (!staleClaim.ok) throw new Error('stale job claim failed');
    expect(staleClaim.value).toHaveLength(1);
    const recoveredCase = await workerTwo.createScheduledCase(
      staleJob.id,
      moderatorUserId,
    );
    expect(recoveredCase.ok).toBe(true);
    if (!recoveredCase.ok) throw new Error('recovered case creation failed');
    const failedTerminalization = await workerTwo.terminalizeScheduledCase({
      jobId: staleJob.id,
      executedCaseId: recoveredCase.value.case.id,
      status: 'FAILED',
      errorCode: 'DISCORD_API_ERROR',
    });
    expect(failedTerminalization.ok && failedTerminalization.value).toBe(true);
    await expect(
      getDb().scheduledAction.findUnique({ where: { id: staleJob.id } }),
    ).resolves.toMatchObject({ status: 'FAILED' });
    await expect(
      getDb().moderationCase.findUnique({
        where: { id: recoveredCase.value.case.id },
      }),
    ).resolves.toMatchObject({
      status: 'FAILED',
      errorCode: 'DISCORD_API_ERROR',
    });

    const mismatchedOriginJob = await scheduler.scheduleReplacing({
      guildId,
      targetUserId: '12345678901234615',
      channelId: null,
      type: 'UNBAN',
      executeAt: new Date(Date.now() - 1_000),
      payload: { guildId, userId: '12345678901234615' },
      createdByCaseId: origin.id,
    });
    const mismatchedClaim = await workerTwo.claimDue(1);
    expect(mismatchedClaim.ok).toBe(true);
    if (!mismatchedClaim.ok) throw new Error('mismatched origin claim failed');
    expect(mismatchedClaim.value).toHaveLength(1);
    const mismatchedCase = await workerTwo.createScheduledCase(
      mismatchedOriginJob.id,
      moderatorUserId,
    );
    expect(mismatchedCase.ok).toBe(true);
    if (!mismatchedCase.ok) throw new Error('mismatched origin case failed');
    expect(mismatchedCase.value.case.targetDisplay).toBe('不明なユーザー');

    const legacyJob = await scheduler.scheduleReplacing({
      guildId,
      targetUserId: '12345678901234613',
      channelId: null,
      type: 'UNBAN',
      executeAt: new Date(Date.now() - 1_000),
      payload: { guildId, userId: '12345678901234613' },
    });
    const legacyClaim = await workerTwo.claimDue(1);
    expect(legacyClaim.ok).toBe(true);
    if (!legacyClaim.ok) throw new Error('legacy worker claim failed');
    expect(legacyClaim.value).toHaveLength(1);
    const legacy = await workerTwo.createScheduledCase(
      legacyJob.id,
      moderatorUserId,
    );
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) throw new Error('legacy scheduled case creation failed');
    expect(legacy.value.created).toBe(true);
    expect(legacy.value.case.targetDisplay).toBe('不明なユーザー');
  });

  it('dispatches a scheduled UNMUTE to one case + one modlog across a crash-retry', async () => {
    const guildId = '12345678901234620';
    const targetUserId = '12345678901234621';
    const moderatorUserId = '12345678901234622';
    const cases = new PrismaCaseRepository(getDb());
    const scheduler = new PrismaSchedulerRepository(getDb());
    const origin = await cases.createWithNumber({
      guildId,
      action: 'MUTE',
      targetUserId,
      targetDisplay: 'scheduled-unmute-name',
      moderatorUserId,
      source: 'COMMAND',
      status: 'COMPLETED',
      reason: 'temporary mute',
    });
    const job = await scheduler.scheduleReplacing({
      guildId,
      targetUserId,
      channelId: null,
      type: 'UNMUTE',
      executeAt: new Date(Date.now() - 1_000),
      payload: { guildId, userId: targetUserId },
      createdByCaseId: origin.id,
    });
    const worker = new SchedulerService(scheduler, { workerId: 'worker-one' });
    const claimed = await worker.claimDue(1);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error('claim failed');
    expect(claimed.value).toHaveLength(1);

    const modlogCalls: string[] = [];
    let muteActive = true;
    const dispatcher = new ScheduledModerationDispatcher({
      scheduler: worker,
      moderation: {
        execute: () => {
          throw new Error('UNMUTE dispatch must not route through moderation');
        },
      },
      discord: {
        getBotUserId: () => Promise.resolve(moderatorUserId),
        hasRole: () => Promise.resolve(true),
        removeRoleUnlocked: () => Promise.resolve(undefined),
        withRoleMutationLock: (_g, _u, operation) => operation(),
      },
      activeMutes: {
        claimScheduledUnmute: () => Promise.resolve(muteActive),
        verifyScheduledUnmute: () => Promise.resolve(true),
        completeScheduledUnmute: () => Promise.resolve(true),
        restoreScheduledUnmute: () => Promise.resolve(true),
      },
      settings: {
        get: () =>
          Promise.resolve({ ok: true, value: { mutedRoleId: 'muted-role' } }),
      },
      roleCorrelation: { put: () => undefined, remove: () => undefined },
      modlog: {
        writeCase: (_guild, caseId) => {
          modlogCalls.push(caseId);
          return Promise.resolve();
        },
      },
      workerId: 'worker-one',
    });

    await dispatcher.dispatch(job);
    // Exactly one SCHEDULED case allocated and exactly one modlog emitted.
    expect(
      await getDb().moderationCase.count({
        where: { guildId, source: 'SCHEDULED' },
      }),
    ).toBe(1);
    expect(modlogCalls).toHaveLength(1);
    const scheduledCase = await getDb().moderationCase.findFirst({
      where: { guildId, source: 'SCHEDULED' },
    });
    expect(scheduledCase?.targetDisplay).toBe('scheduled-unmute-name');
    expect(modlogCalls[0]).toBe(scheduledCase?.id);
    await expect(
      getDb().scheduledAction.findUnique({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      status: 'COMPLETED',
      executedCaseId: scheduledCase?.id,
    });

    // Simulate a crash-retry: the mute is already released, the job is
    // reclaimed, and the dispatcher runs again. It must reuse the same case
    // (no duplicate) and must not emit a second modlog.
    muteActive = false;
    await getDb().scheduledAction.update({
      where: { id: job.id },
      data: { status: 'PENDING', lockedAt: null, lockedBy: null },
    });
    const reclaimed = await worker.claimDue(1);
    expect(reclaimed.ok).toBe(true);
    if (!reclaimed.ok) throw new Error('reclaim failed');
    expect(reclaimed.value).toHaveLength(1);
    await dispatcher.dispatch(job);
    expect(
      await getDb().moderationCase.count({
        where: { guildId, source: 'SCHEDULED' },
      }),
    ).toBe(1);
    expect(modlogCalls).toHaveLength(1);
  });

  it('completeScheduledUnmute expires only the matching mute and leaves the job RUNNING', async () => {
    const guildId = '12345678901234630';
    const targetUserId = '12345678901234631';
    const cases = new PrismaCaseRepository(getDb());
    const mute = new PrismaActiveMuteRepository(getDb());
    const scheduler = new PrismaSchedulerRepository(getDb());
    const origin = await cases.createWithNumber({
      guildId,
      action: 'MUTE',
      targetUserId,
      targetDisplay: 'cas-name',
      moderatorUserId: '12345678901234632',
      source: 'COMMAND',
      status: 'COMPLETED',
      reason: 'temp',
    });
    const expiry = new Date(Date.now() + 60_000);
    await mute.activateWithSchedule(guildId, targetUserId, origin.id, expiry, {
      guildId,
      userId: targetUserId,
    });
    const claimed = await scheduler.claimDue(
      10,
      'cas-worker',
      new Date(expiry.getTime() + 1),
    );
    const job = claimed.find(
      (item) => item.type === 'UNMUTE' && item.targetUserId === targetUserId,
    );
    const jobId = requireDefined(
      job,
      'expected an unmute job to be claimed',
    ).id;
    expect(
      await mute.claimScheduledUnmute(
        guildId,
        targetUserId,
        jobId,
        'cas-worker',
      ),
    ).toBe(true);
    expect(
      await mute.completeScheduledUnmute(
        guildId,
        targetUserId,
        jobId,
        'cas-worker',
      ),
    ).toBe(true);
    // The matching mute is expired...
    const muteRow = await getDb().activeMute.findUnique({
      where: { guildId_userId: { guildId, userId: targetUserId } },
    });
    expect(muteRow?.status).toBe('EXPIRED');
    // ...but the job is deliberately left RUNNING for terminalizeScheduledCase.
    expect(await scheduler.getStatus(jobId)).toBe('RUNNING');
    // A second CAS no longer matches the (now expired) mute.
    expect(
      await mute.completeScheduledUnmute(
        guildId,
        targetUserId,
        jobId,
        'cas-worker',
      ),
    ).toBe(false);
  });

  it('fail() at retry exhaustion atomically fails the linked PENDING scheduled case', async () => {
    const guildId = '12345678901234640';
    const targetUserId = '12345678901234641';
    const moderatorUserId = '12345678901234642';
    const scheduler = new PrismaSchedulerRepository(getDb());
    const worker = new SchedulerService(scheduler, { workerId: 'fail-worker' });
    const job = await scheduler.scheduleReplacing({
      guildId,
      targetUserId,
      channelId: null,
      type: 'UNBAN',
      executeAt: new Date(Date.now() - 1_000),
      payload: { guildId, userId: targetUserId },
    });
    const claimed = await worker.claimDue(1);
    expect(claimed.ok && claimed.value).toHaveLength(1);
    const created = await worker.createScheduledCase(job.id, moderatorUserId);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('scheduled case creation failed');
    expect(created.value.case.status).toBe('PENDING');
    // Push the job to the final attempt so the next retryable failure exhausts.
    await getDb().scheduledAction.update({
      where: { id: job.id },
      data: { attempts: SCHEDULED_MAX_ATTEMPTS },
    });
    expect(await scheduler.fail(job.id, 'fail-worker', 'transient', true)).toBe(
      true,
    );
    await expect(
      getDb().scheduledAction.findUnique({ where: { id: job.id } }),
    ).resolves.toMatchObject({ status: 'FAILED' });
    // The linked still-PENDING SCHEDULED case is failed by the same transaction.
    await expect(
      getDb().moderationCase.findUnique({
        where: { id: created.value.case.id },
      }),
    ).resolves.toMatchObject({ status: 'FAILED' });
  });

  it('recoverStale() exhaustion atomically fails the linked PENDING scheduled case', async () => {
    const guildId = '12345678901234650';
    const targetUserId = '12345678901234651';
    const moderatorUserId = '12345678901234652';
    const scheduler = new PrismaSchedulerRepository(getDb());
    const worker = new SchedulerService(scheduler, {
      workerId: 'stale-worker',
    });
    const job = await scheduler.scheduleReplacing({
      guildId,
      targetUserId,
      channelId: null,
      type: 'UNBAN',
      executeAt: new Date(Date.now() - 1_000),
      payload: { guildId, userId: targetUserId },
    });
    const claimed = await worker.claimDue(1);
    expect(claimed.ok && claimed.value).toHaveLength(1);
    const created = await worker.createScheduledCase(job.id, moderatorUserId);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('scheduled case creation failed');
    // Simulate a crashed worker that exhausted attempts and never terminalized.
    await getDb().scheduledAction.update({
      where: { id: job.id },
      data: {
        attempts: SCHEDULED_MAX_ATTEMPTS,
        lockedAt: new Date(Date.now() - 6 * 60_000),
      },
    });
    expect(await worker.recoverStale()).toBeGreaterThanOrEqual(1);
    await expect(
      getDb().scheduledAction.findUnique({ where: { id: job.id } }),
    ).resolves.toMatchObject({ status: 'FAILED' });
    await expect(
      getDb().moderationCase.findUnique({
        where: { id: created.value.case.id },
      }),
    ).resolves.toMatchObject({ status: 'FAILED' });
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

  it('rejects user-target cases whose display is an ID, mention, or formatted value', async () => {
    const cases = new PrismaCaseRepository(getDb());
    const guildId = '32345678901234567';
    const base = {
      guildId,
      targetUserId: '12345678901234571',
      moderatorUserId: '12345678901234568',
      source: 'COMMAND' as const,
      status: 'COMPLETED' as const,
      reason: 'test',
    };
    await expect(
      cases.createWithNumber({
        ...base,
        action: 'BAN',
        targetDisplay: '12345678901234571',
      }),
    ).rejects.toThrow(/target_display/u);
    await expect(
      cases.createWithNumber({
        ...base,
        action: 'BAN',
        targetDisplay: '<@12345678901234571>',
      }),
    ).rejects.toThrow(/target_display/u);
    await expect(
      cases.createWithNumber({
        ...base,
        action: 'BAN',
        targetDisplay: 'name (12345678901234571)',
      }),
    ).rejects.toThrow(/target_display/u);
    // A valid name snapshot for a user-target action persists unchanged.
    const valid = await cases.createWithNumber({
      ...base,
      action: 'BAN',
      targetDisplay: 'valid-name',
    });
    expect(valid.targetDisplay).toBe('valid-name');
    // A non-user-target action keeps its action-specific descriptor.
    const raid = await cases.createWithNumber({
      ...base,
      action: 'RAIDMODE_ON',
      targetUserId: null,
      targetDisplay: 'raidmode',
    });
    expect(raid.targetDisplay).toBe('raidmode');
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

  it('schedules auto raid disable from the latest committed join, not a stale input', async () => {
    const raid = new PrismaRaidRepository(getDb());
    const guildId = '12345678901234578';
    const activation = {
      guildId,
      actorUserId: '12345678901234568',
      source: 'AUTO' as const,
      changed: false,
      reason: 'AutoRaid: 3 joins in 300 seconds',
    };
    const early = new Date('2025-06-01T12:00:00.000Z');
    const newest = new Date('2025-06-01T12:00:02.000Z');
    // The activating delivery arrives out of order with an older timestamp
    // than a join that was already committed.
    const staleInput = new Date('2025-06-01T12:00:01.000Z');
    await raid.recordJoinAndEvaluate(
      guildId,
      '12345678901234571',
      early,
      3,
      300,
      activation,
    );
    await raid.recordJoinAndEvaluate(
      guildId,
      '12345678901234572',
      newest,
      3,
      300,
      activation,
    );
    const result = await raid.recordJoinAndEvaluate(
      guildId,
      '12345678901234573',
      staleInput,
      3,
      300,
      activation,
    );
    expect(result.activated).toBe(true);
    const job = await getDb().scheduledAction.findFirst({
      where: { guildId, type: 'DISABLE_RAIDMODE', status: 'PENDING' },
    });
    expect(job).not.toBeNull();
    expect(job?.executeAt.getTime()).toBe(newest.getTime() + 120_000);
    expect(job?.executeAt.getTime()).not.toBe(staleInput.getTime() + 120_000);
  });

  it('records the raid verification intent at activation and confirms idempotently', async () => {
    const raid = new PrismaRaidRepository(getDb());
    const guildId = '12345678901234579';
    await raid.activateManual({
      guildId,
      actorUserId: '12345678901234568',
      source: 'MANUAL',
      changed: true,
      verificationLevelBeforeRaid: 1,
      reason: 'raid',
    });
    const before = await getDb().guildSettings.findUnique({
      where: { guildId },
    });
    // The prior level is captured and the raise intent (ownership) is recorded
    // durably at activation, BEFORE the Discord raise.
    expect(before?.verificationLevelBeforeRaid).toBe(1);
    expect(before?.raidVerificationChanged).toBe(true);
    // The post-raise confirmation is an idempotent re-assertion.
    await raid.markVerificationRaised(guildId);
    const after = await getDb().guildSettings.findUnique({
      where: { guildId },
    });
    expect(after?.raidVerificationChanged).toBe(true);
    // A confirmed owner restores to the captured level.
    const deactivated = await raid.deactivateWithCase({
      guildId,
      actorUserId: '12345678901234568',
      reason: 'off',
    });
    expect(deactivated.changed).toBe(true);
    expect(deactivated.restoreLevel).toBe(1);
  });

  it('restores verification even when a crash skips the post-raise confirmation', async () => {
    const raid = new PrismaRaidRepository(getDb());
    const guildId = '12345678901234660';
    await raid.activateManual({
      guildId,
      actorUserId: '12345678901234568',
      source: 'MANUAL',
      changed: true,
      verificationLevelBeforeRaid: 1,
      reason: 'raid',
    });
    // Simulate a crash after the Discord raise succeeded but before
    // markVerificationRaised ran: the intent is already durable, so a later OFF
    // still restores the captured level instead of stranding the guild at HIGH.
    const deactivated = await raid.deactivateWithCase({
      guildId,
      actorUserId: '12345678901234568',
      reason: 'off',
    });
    expect(deactivated.changed).toBe(true);
    expect(deactivated.restoreLevel).toBe(1);
  });

  it('does not restore verification when no raise was intended or the raise was relinquished', async () => {
    const raid = new PrismaRaidRepository(getDb());
    // (a) No raise intended (already HIGH before the raid): nothing to restore.
    const noRaiseGuild = '12345678901234580';
    await raid.activateManual({
      guildId: noRaiseGuild,
      actorUserId: '12345678901234568',
      source: 'MANUAL',
      changed: false,
      verificationLevelBeforeRaid: 3,
      reason: 'raid',
    });
    const noRaise = await raid.deactivateWithCase({
      guildId: noRaiseGuild,
      actorUserId: '12345678901234568',
      reason: 'off',
    });
    expect(noRaise.changed).toBe(true);
    expect(noRaise.restoreLevel).toBeNull();

    // (b) Raise intended but definitively failed: the service relinquishes the
    // intent, so OFF must not restore a level the bot never raised.
    const revokedGuild = '12345678901234661';
    await raid.activateManual({
      guildId: revokedGuild,
      actorUserId: '12345678901234568',
      source: 'MANUAL',
      changed: true,
      verificationLevelBeforeRaid: 1,
      reason: 'raid',
    });
    await raid.revokeVerificationRaised(revokedGuild);
    const revoked = await getDb().guildSettings.findUnique({
      where: { guildId: revokedGuild },
    });
    expect(revoked?.raidVerificationChanged).toBe(false);
    const revokedOff = await raid.deactivateWithCase({
      guildId: revokedGuild,
      actorUserId: '12345678901234568',
      reason: 'off',
    });
    expect(revokedOff.changed).toBe(true);
    expect(revokedOff.restoreLevel).toBeNull();
  });

  it('extends the auto raid deadline to the latest join and never earlier', async () => {
    const raid = new PrismaRaidRepository(getDb());
    const guildId = '12345678901234581';
    const activation = {
      guildId,
      actorUserId: '12345678901234568',
      source: 'AUTO' as const,
      changed: false,
      reason: 'AutoRaid',
    };
    const at = (seconds: number) =>
      new Date(`2025-06-01T12:00:${String(seconds).padStart(2, '0')}.000Z`);
    const pending = () =>
      getDb().scheduledAction.findFirst({
        where: { guildId, type: 'DISABLE_RAIDMODE', status: 'PENDING' },
      });
    await raid.recordJoinAndEvaluate(
      guildId,
      '12345678901234571',
      at(0),
      3,
      300,
      activation,
    );
    await raid.recordJoinAndEvaluate(
      guildId,
      '12345678901234572',
      at(1),
      3,
      300,
      activation,
    );
    const activated = await raid.recordJoinAndEvaluate(
      guildId,
      '12345678901234573',
      at(2),
      3,
      300,
      activation,
    );
    expect(activated.activated).toBe(true);
    expect((await pending())?.executeAt.getTime()).toBe(
      at(2).getTime() + 120_000,
    );
    // A later join extends the deadline.
    await raid.recordJoinAndEvaluate(
      guildId,
      '12345678901234574',
      at(30),
      3,
      300,
      activation,
    );
    expect((await pending())?.executeAt.getTime()).toBe(
      at(30).getTime() + 120_000,
    );
    // A stale (out-of-order) join must not move the deadline earlier.
    await raid.recordJoinAndEvaluate(
      guildId,
      '12345678901234575',
      at(5),
      3,
      300,
      activation,
    );
    expect((await pending())?.executeAt.getTime()).toBe(
      at(30).getTime() + 120_000,
    );
    expect(
      await getDb().scheduledAction.count({
        where: { guildId, type: 'DISABLE_RAIDMODE', status: 'PENDING' },
      }),
    ).toBe(1);
  });

  it('keeps a single deadline at the latest join under concurrent extensions', async () => {
    const raid = new PrismaRaidRepository(getDb());
    const guildId = '12345678901234582';
    const activation = {
      guildId,
      actorUserId: '12345678901234568',
      source: 'AUTO' as const,
      changed: false,
      reason: 'AutoRaid',
    };
    const base = Date.parse('2025-06-01T12:00:00.000Z');
    const at = (ms: number) => new Date(base + ms);
    await raid.recordJoinAndEvaluate(
      guildId,
      '12345678901234571',
      at(0),
      3,
      300,
      activation,
    );
    await raid.recordJoinAndEvaluate(
      guildId,
      '12345678901234572',
      at(1_000),
      3,
      300,
      activation,
    );
    const activated = await raid.recordJoinAndEvaluate(
      guildId,
      '12345678901234573',
      at(2_000),
      3,
      300,
      activation,
    );
    expect(activated.activated).toBe(true);
    // Concurrent out-of-order extensions; the latest join is at +20s.
    await Promise.all(
      [10_000, 5_000, 20_000, 3_000].map((ms, index) =>
        raid.recordJoinAndEvaluate(
          guildId,
          `1234567890123459${String(index)}`,
          at(ms),
          3,
          300,
          activation,
        ),
      ),
    );
    const jobs = await getDb().scheduledAction.findMany({
      where: { guildId, type: 'DISABLE_RAIDMODE', status: 'PENDING' },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.executeAt.getTime()).toBe(at(20_000).getTime() + 120_000);
  });

  it('allocates exactly one OFF case under concurrent manual deactivation', async () => {
    const raid = new PrismaRaidRepository(getDb());
    const guildId = '12345678901234583';
    await raid.activateManual({
      guildId,
      actorUserId: '12345678901234568',
      source: 'MANUAL',
      changed: false,
      reason: 'raid',
    });
    const results = await Promise.all([
      raid.deactivateWithCase({
        guildId,
        actorUserId: '12345678901234568',
        reason: 'off-1',
      }),
      raid.deactivateWithCase({
        guildId,
        actorUserId: '12345678901234568',
        reason: 'off-2',
      }),
      raid.deactivateWithCase({
        guildId,
        actorUserId: '12345678901234568',
        reason: 'off-3',
      }),
    ]);
    expect(results.filter((result) => result.changed)).toHaveLength(1);
    expect(
      await getDb().moderationCase.count({
        where: { guildId, action: 'RAIDMODE_OFF' },
      }),
    ).toBe(1);
  });

  it('allocates the OFF case atomically with the auto idle disable', async () => {
    const raid = new PrismaRaidRepository(getDb());
    const guildId = '12345678901234584';
    const activation = {
      guildId,
      actorUserId: '12345678901234568',
      source: 'AUTO' as const,
      changed: true,
      verificationLevelBeforeRaid: 1,
      reason: 'AutoRaid',
    };
    const joinAt = new Date('2025-06-01T12:00:00.000Z');
    await raid.recordJoinAndEvaluate(
      guildId,
      '12345678901234571',
      joinAt,
      3,
      300,
      activation,
    );
    await raid.recordJoinAndEvaluate(
      guildId,
      '12345678901234572',
      joinAt,
      3,
      300,
      activation,
    );
    await raid.recordJoinAndEvaluate(
      guildId,
      '12345678901234573',
      joinAt,
      3,
      300,
      activation,
    );
    await raid.markVerificationRaised(guildId);
    const result = await raid.disableAutoIfIdle(
      guildId,
      new Date(joinAt.getTime() + 300_000),
      '12345678901234568',
    );
    expect(result.disabled).toBe(true);
    expect(result.case?.action).toBe('RAIDMODE_OFF');
    expect(result.restoreLevel).toBe(1);
    expect(
      await getDb().moderationCase.count({
        where: { guildId, action: 'RAIDMODE_OFF' },
      }),
    ).toBe(1);
    const settings = await getDb().guildSettings.findUnique({
      where: { guildId },
    });
    expect(settings?.raidModeEnabled).toBe(false);
  });

  it('keeps the newer join deadline when a stale disable fires (max-only, in transaction)', async () => {
    const raid = new PrismaRaidRepository(getDb());
    const guildId = '12345678901234585';
    const activation = {
      guildId,
      actorUserId: '12345678901234568',
      source: 'AUTO' as const,
      changed: false,
      reason: 'AutoRaid',
    };
    const t0 = Date.parse('2025-06-01T12:00:00.000Z');
    // Activate with 3 joins at t0 -> deadline t0+120s.
    await raid.recordJoinAndEvaluate(
      guildId,
      '12345678901234571',
      new Date(t0),
      3,
      300,
      activation,
    );
    await raid.recordJoinAndEvaluate(
      guildId,
      '12345678901234572',
      new Date(t0),
      3,
      300,
      activation,
    );
    await raid.recordJoinAndEvaluate(
      guildId,
      '12345678901234573',
      new Date(t0),
      3,
      300,
      activation,
    );
    // A newer join extends the deadline to t1+120s.
    const t1 = t0 + 30_000;
    await raid.recordJoinAndEvaluate(
      guildId,
      '12345678901234574',
      new Date(t1),
      3,
      300,
      activation,
    );
    // A stale disable fires after the ORIGINAL deadline (t0+120s) but before
    // the newer join's deadline (t1+120s).
    const result = await raid.disableAutoIfIdle(
      guildId,
      new Date(t0 + 121_000),
      '12345678901234568',
    );
    expect(result.disabled).toBe(false); // not idle relative to the newer join
    const settings = await getDb().guildSettings.findUnique({
      where: { guildId },
    });
    expect(settings?.raidModeEnabled).toBe(true);
    const jobs = await getDb().scheduledAction.findMany({
      where: { guildId, type: 'DISABLE_RAIDMODE', status: 'PENDING' },
    });
    expect(jobs).toHaveLength(1);
    // The newer join's deadline is preserved, not cancelled/replaced by the
    // stale disable.
    expect(jobs[0]?.executeAt.getTime()).toBe(t1 + 120_000);
  });

  it('never replaces a newer join deadline under concurrent stale-disable/new-join', async () => {
    const raid = new PrismaRaidRepository(getDb());
    const guildId = '12345678901234586';
    const activation = {
      guildId,
      actorUserId: '12345678901234568',
      source: 'AUTO' as const,
      changed: false,
      reason: 'AutoRaid',
    };
    const t0 = Date.parse('2025-06-01T12:00:00.000Z');
    await raid.recordJoinAndEvaluate(
      guildId,
      '12345678901234571',
      new Date(t0),
      3,
      300,
      activation,
    );
    await raid.recordJoinAndEvaluate(
      guildId,
      '12345678901234572',
      new Date(t0),
      3,
      300,
      activation,
    );
    await raid.recordJoinAndEvaluate(
      guildId,
      '12345678901234573',
      new Date(t0),
      3,
      300,
      activation,
    );
    // Concurrently: a stale disable (after the original t0+120s deadline) and a
    // newer join at t0+125s. Whichever wins the guild lock, the newer join's
    // deadline must prevail and there must be exactly one pending job.
    const newJoin = t0 + 125_000;
    await Promise.all([
      raid.disableAutoIfIdle(
        guildId,
        new Date(t0 + 130_000),
        '12345678901234568',
      ),
      raid.recordJoinAndEvaluate(
        guildId,
        '12345678901234574',
        new Date(newJoin),
        3,
        300,
        activation,
      ),
    ]);
    const settings = await getDb().guildSettings.findUnique({
      where: { guildId },
    });
    const jobs = await getDb().scheduledAction.findMany({
      where: { guildId, type: 'DISABLE_RAIDMODE', status: 'PENDING' },
    });
    expect(settings?.raidModeEnabled).toBe(true);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.executeAt.getTime()).toBe(newJoin + 120_000);
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

  it('preserves snapshot createdAt on edit and bulk-deletes by id', async () => {
    const snapshots = new PrismaSnapshotRepository(getDb());
    const guildId = '12345678901234662';
    const channelId = '12345678901234663';
    const originalCreatedAt = new Date('2025-12-01T09:30:00.000Z');
    await snapshots.upsertMessage({
      messageId: '12345678901234664',
      guildId,
      channelId,
      authorUserId: '12345678901234568',
      authorDisplay: 'user',
      content: 'original',
      attachments: [],
      embedsSummary: {},
      createdAt: originalCreatedAt,
      expiresAt: new Date('2026-01-08T00:00:00.000Z'),
    });
    // An edit upsert that omits createdAt must not reset the creation time.
    await snapshots.upsertMessage({
      messageId: '12345678901234664',
      guildId,
      channelId,
      authorUserId: '12345678901234568',
      authorDisplay: 'user',
      content: 'edited',
      attachments: [],
      embedsSummary: {},
      editedAt: new Date('2026-02-02T00:00:00.000Z'),
      expiresAt: new Date('2026-02-09T00:00:00.000Z'),
    });
    const edited = await snapshots.getMessage('12345678901234664');
    expect(edited?.content).toBe('edited');
    expect(edited?.createdAt.getTime()).toBe(originalCreatedAt.getTime());
    expect(edited?.editedAt).not.toBeNull();

    // Bulk deletion removes exactly the requested ids and reports the count.
    await snapshots.upsertMessage({
      messageId: '12345678901234665',
      guildId,
      channelId,
      authorUserId: '12345678901234568',
      authorDisplay: 'user',
      content: 'second',
      attachments: [],
      embedsSummary: {},
      expiresAt: new Date('2026-01-08T00:00:00.000Z'),
    });
    const deleted = await snapshots.deleteMessages([
      '12345678901234664',
      '12345678901234665',
      '12345678901234699', // not present
    ]);
    expect(deleted).toBe(2);
    expect(await snapshots.getMessage('12345678901234664')).toBeNull();
    expect(await snapshots.getMessage('12345678901234665')).toBeNull();
    expect(await snapshots.deleteMessages([])).toBe(0);
  });

  it('lists member snapshots for a user ordered by guildId', async () => {
    const snapshots = new PrismaSnapshotRepository(getDb());
    const userId = '12345678901234999';
    const guildA = '12345678901234990';
    const guildB = '12345678901234991';
    await getDb().guildSettings.create({ data: { guildId: guildA } });
    await getDb().guildSettings.create({ data: { guildId: guildB } });
    // Insert out of guildId order (B before A) to prove ordering is by guildId.
    await snapshots.upsertMember({
      guildId: guildB,
      userId,
      username: 'beta',
      globalName: 'b',
      nickname: null,
      joinedAt: null,
    });
    await snapshots.upsertMember({
      guildId: guildA,
      userId,
      username: 'alpha',
      globalName: 'a',
      nickname: 'nick',
      joinedAt: new Date('2025-01-01T00:00:00Z'),
    });

    const result = await snapshots.listMembersForUser(userId);

    expect(result.map((row) => row.guildId)).toEqual([guildA, guildB]);
    expect(result[0]?.username).toBe('alpha');
    expect(result[0]?.nickname).toBe('nick');
    expect(result[1]?.username).toBe('beta');
  });

  it('excludes retained member snapshots for lifecycle LEFT guilds', async () => {
    const snapshots = new PrismaSnapshotRepository(getDb());
    const userId = '12345678901234989';
    const activeGuild = '12345678901234980';
    const leftGuild = '12345678901234981';
    await getDb().guildSettings.create({ data: { guildId: activeGuild } });
    await getDb().guildSettings.create({ data: { guildId: leftGuild } });
    // Mark leftGuild as LEFT; its retained snapshot must be excluded from the lookup.
    await new PrismaDepartureRepository(getDb()).markLeft({
      guildId: leftGuild,
      departedAt: new Date('2026-01-01T00:00:00Z'),
    });
    await snapshots.upsertMember({
      guildId: activeGuild,
      userId,
      username: 'active',
      globalName: null,
      nickname: null,
      joinedAt: null,
    });
    await snapshots.upsertMember({
      guildId: leftGuild,
      userId,
      username: 'left',
      globalName: null,
      nickname: null,
      joinedAt: null,
    });

    const result = await snapshots.listMembersForUser(userId);

    expect(result.map((row) => row.guildId)).toEqual([activeGuild]);
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
        'INSERT INTO punishments (id, guild_id, threshold, action, duration_seconds, created_by, created_at, updated_at) VALUES ($1::uuid, $2, 4, $3::"PunishmentAction", 31536001, $4, now(), now())',
        '00000000-0000-4000-8000-000000000004',
        '12345678901234567',
        'BAN',
        '12345678901234568',
      ),
      'punishments_duration_valid',
    );
    await expectConstraint(
      getDb().$executeRawUnsafe(
        'INSERT INTO punishments (id, guild_id, threshold, action, duration_seconds, created_by, created_at, updated_at) VALUES ($1::uuid, $2, 5, $3::"PunishmentAction", 2419201, $4, now(), now())',
        '00000000-0000-4000-8000-000000000005',
        '12345678901234567',
        'MUTE',
        '12345678901234568',
      ),
      'punishments_mute_max_28_days',
    );
    await expectConstraint(
      getDb().$executeRawUnsafe(
        'INSERT INTO punishments (id, guild_id, threshold, action, created_by, created_at, updated_at) VALUES ($1::uuid, $2, 1000001, $3::"PunishmentAction", $4, now(), now())',
        '00000000-0000-4000-8000-000000000006',
        '12345678901234567',
        'KICK',
        '12345678901234568',
      ),
      'punishments_threshold_valid',
    );
    await expectConstraint(
      getDb().$executeRawUnsafe(
        'INSERT INTO user_strikes (guild_id, user_id, count, updated_at) VALUES ($1, $2, $3, now())',
        '12345678901234567',
        '12345678901234590',
        1_000_001,
      ),
      'user_strikes_count_valid',
    );
    await expectConstraint(
      getDb().$executeRawUnsafe(
        'INSERT INTO user_strikes (guild_id, user_id, count, updated_at) VALUES ($1, $2, $3, now())',
        '12345678901234567',
        '12345678901234591',
        -1,
      ),
      'user_strikes_count_valid',
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
