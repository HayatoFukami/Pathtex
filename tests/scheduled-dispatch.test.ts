import { describe, expect, it, vi } from 'vitest';
import {
  ScheduledModerationDispatcher,
  type ScheduledModerationDependencies,
} from '../src/features/moderation/scheduled-dispatch.js';
import { SchedulerService } from '../src/services/scheduler-service.js';
import { ok, err } from '../src/domain/result.js';
import type {
  CaseDto,
  JobDto,
  SchedulerRepository,
} from '../src/repositories/contracts.js';

const GUILD = '12345678901234567';
const USER = '12345678901234568';
const BOT = '12345678901234569';
const JOB_ID = '00000000-0000-4000-8000-000000000001';
const CASE_ID = '00000000-0000-4000-8000-0000000000aa';

const stubRepository = {} as SchedulerRepository;
const classifier = new SchedulerService(stubRepository, { workerId: 'worker' });

const scheduledCase = (
  action: 'UNBAN' | 'UNMUTE',
  overrides: Partial<CaseDto> = {},
): CaseDto => ({
  id: CASE_ID,
  guildId: GUILD,
  caseNumber: 5,
  action,
  targetUserId: USER,
  targetDisplay: 'snapshot-name',
  moderatorUserId: BOT,
  reason: '期限到達',
  durationSeconds: null,
  source: 'SCHEDULED',
  status: 'PENDING',
  errorCode: null,
  metadata: {},
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const job = (type: 'UNBAN' | 'UNMUTE', attempts = 0): JobDto => ({
  id: JOB_ID,
  guildId: GUILD,
  targetUserId: USER,
  channelId: null,
  type,
  executeAt: new Date(),
  status: 'RUNNING',
  payload: { guildId: GUILD, userId: USER },
  attempts,
  createdAt: new Date(),
  updatedAt: new Date(),
});

interface Harness {
  deps: ScheduledModerationDependencies;
  dispatcher: ScheduledModerationDispatcher;
  mocks: {
    createScheduledCase: ReturnType<typeof vi.fn>;
    terminalizeScheduledCase: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
    writeCase: ReturnType<typeof vi.fn>;
    getBotUserId: ReturnType<typeof vi.fn>;
    hasRole: ReturnType<typeof vi.fn>;
    removeRoleUnlocked: ReturnType<typeof vi.fn>;
    claimScheduledUnmute: ReturnType<typeof vi.fn>;
    verifyScheduledUnmute: ReturnType<typeof vi.fn>;
    completeScheduledUnmute: ReturnType<typeof vi.fn>;
    restoreScheduledUnmute: ReturnType<typeof vi.fn>;
  };
}

/** Builds a dispatcher harness. `terminalizeWins` controls how many times
 * terminalizeScheduledCase reports a winning (true) terminalization, modelling
 * the repository's "terminalize once" idempotency across retries. */
const harness = (
  action: 'UNBAN' | 'UNMUTE',
  opts: { created?: boolean; terminalizeWins?: number } = {},
): Harness => {
  const created = opts.created ?? true;
  const terminalizeWins = opts.terminalizeWins ?? 1;
  const caseValue = scheduledCase(action);
  const terminalization = {
    jobId: JOB_ID,
    workerId: 'worker',
    executedCaseId: CASE_ID,
  };
  const createScheduledCase = vi.fn(() =>
    Promise.resolve(ok({ case: caseValue, created, terminalization })),
  );
  let terminalizations = 0;
  const terminalizeScheduledCase = vi.fn(() => {
    const wins = terminalizations < terminalizeWins;
    terminalizations += 1;
    return Promise.resolve(ok(wins));
  });
  const execute = vi.fn(() =>
    Promise.resolve(
      ok({
        action,
        outcomes: [{ targetId: USER, ok: true, case: caseValue }],
      }),
    ),
  );
  const writeCase = vi.fn(() => Promise.resolve());
  const getBotUserId = vi.fn(() => Promise.resolve(BOT));
  const hasRole = vi.fn(() => Promise.resolve(true));
  const removeRoleUnlocked = vi.fn(() => Promise.resolve());
  const claimScheduledUnmute = vi.fn(() => Promise.resolve(true));
  const verifyScheduledUnmute = vi.fn(() => Promise.resolve(true));
  const completeScheduledUnmute = vi.fn(() => Promise.resolve(true));
  const restoreScheduledUnmute = vi.fn(() => Promise.resolve(true));
  const deps: ScheduledModerationDependencies = {
    scheduler: {
      createScheduledCase,
      terminalizeScheduledCase,
      classify: classifier.classify.bind(classifier),
    },
    moderation: { execute },
    discord: {
      getBotUserId,
      hasRole,
      removeRoleUnlocked,
      withRoleMutationLock: (_g, _u, operation) => operation(),
    },
    activeMutes: {
      claimScheduledUnmute,
      verifyScheduledUnmute,
      completeScheduledUnmute,
      restoreScheduledUnmute,
    },
    settings: { get: () => Promise.resolve(ok({ mutedRoleId: 'muted-role' })) },
    roleCorrelation: { put: () => undefined, remove: () => undefined },
    modlog: { writeCase },
    workerId: 'worker',
  };
  return {
    deps,
    dispatcher: new ScheduledModerationDispatcher(deps),
    mocks: {
      createScheduledCase,
      terminalizeScheduledCase,
      execute,
      writeCase,
      getBotUserId,
      hasRole,
      removeRoleUnlocked,
      claimScheduledUnmute,
      verifyScheduledUnmute,
      completeScheduledUnmute,
      restoreScheduledUnmute,
    },
  };
};

describe('ScheduledModerationDispatcher UNBAN idempotency', () => {
  it('creates one SCHEDULED case, terminalizes once, and emits one modlog', async () => {
    const { dispatcher, mocks } = harness('UNBAN');
    await dispatcher.dispatch(job('UNBAN'));
    expect(mocks.createScheduledCase).toHaveBeenCalledOnce();
    expect(mocks.createScheduledCase).toHaveBeenCalledWith(JOB_ID, BOT);
    // The claimed case is used as the pre-created case for enforcement.
    expect(mocks.execute).toHaveBeenCalledOnce();
    const call = mocks.execute.mock.calls[0]?.[0] as {
      actorId: string;
      execution?: { preCreatedCase?: { id: string }; source?: string };
    };
    expect(call.execution?.preCreatedCase?.id).toBe(CASE_ID);
    expect(call.execution?.source).toBe('SCHEDULED');
    expect(call.actorId).toBe(BOT);
    expect(mocks.terminalizeScheduledCase).toHaveBeenCalledOnce();
    expect(mocks.terminalizeScheduledCase).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: JOB_ID,
        executedCaseId: CASE_ID,
        status: 'COMPLETED',
      }),
    );
    expect(mocks.writeCase).toHaveBeenCalledOnce();
    expect(mocks.writeCase).toHaveBeenCalledWith(GUILD, CASE_ID);
  });

  it('does not duplicate the case or modlog when retried after Discord success', async () => {
    // First attempt succeeds and wins terminalization.
    const first = harness('UNBAN', { created: true, terminalizeWins: 1 });
    await first.dispatcher.dispatch(job('UNBAN'));
    expect(first.mocks.writeCase).toHaveBeenCalledOnce();

    // A retry/crash-recovery re-claims the SAME case (created: false) and the
    // target is already unbanned, so enforcement reports NOT_APPLIED. The
    // terminalization no longer wins, so no second modlog is emitted.
    const retry = harness('UNBAN', { created: false, terminalizeWins: 0 });
    retry.mocks.execute.mockResolvedValueOnce(
      ok({
        action: 'UNBAN',
        outcomes: [{ targetId: USER, ok: false, code: 'NOT_APPLIED' }],
      }),
    );
    await retry.dispatcher.dispatch(job('UNBAN'));
    // Same case id reused; no new case allocation surface.
    const retryCall = retry.mocks.execute.mock.calls[0]?.[0] as {
      execution?: { preCreatedCase?: { id: string } };
    };
    expect(retryCall.execution?.preCreatedCase?.id).toBe(CASE_ID);
    expect(retry.mocks.terminalizeScheduledCase).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'COMPLETED' }),
    );
    // Terminalization did not win on retry → no modlog emitted again.
    expect(retry.mocks.writeCase).not.toHaveBeenCalled();
  });

  it('rethrows a 401 from enforcement without terminalizing (fatal propagates)', async () => {
    const { dispatcher, mocks } = harness('UNBAN');
    const fatal = Object.assign(new Error('unauthorized'), { status: 401 });
    mocks.execute.mockRejectedValueOnce(fatal);
    await expect(dispatcher.dispatch(job('UNBAN'))).rejects.toBe(fatal);
    expect(mocks.terminalizeScheduledCase).not.toHaveBeenCalled();
    expect(mocks.writeCase).not.toHaveBeenCalled();
  });

  it('rethrows a resolution-stage wrapped (cause) 401 without terminalizing', async () => {
    const { dispatcher, mocks } = harness('UNBAN');
    const wrapped = Object.assign(new Error('wrapped unauthorized'), {
      cause: { status: 401 },
    });
    mocks.execute.mockRejectedValueOnce(wrapped);
    await expect(dispatcher.dispatch(job('UNBAN'))).rejects.toBe(wrapped);
    expect(mocks.terminalizeScheduledCase).not.toHaveBeenCalled();
    expect(mocks.writeCase).not.toHaveBeenCalled();
    // The shared classifier still detects the wrapped 401 as fatal downstream.
    expect(classifier.classify(wrapped)).toBe('FATAL');
  });

  it('classifies a resolution-stage 403 outcome as a definitive FAILED', async () => {
    const { dispatcher, mocks } = harness('UNBAN');
    mocks.execute.mockResolvedValueOnce(
      ok({
        action: 'UNBAN',
        outcomes: [
          { targetId: USER, ok: false, code: 'DISCORD_API_ERROR', status: 403 },
        ],
      }),
    );
    await expect(dispatcher.dispatch(job('UNBAN'))).rejects.toMatchObject({
      status: 403,
    });
    expect(mocks.terminalizeScheduledCase).toHaveBeenCalledOnce();
    expect(mocks.terminalizeScheduledCase).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILED' }),
    );
    expect(mocks.writeCase).toHaveBeenCalledOnce();
  });

  it('leaves the case PENDING for a retryable Discord failure (no terminalization)', async () => {
    const { dispatcher, mocks } = harness('UNBAN');
    mocks.execute.mockResolvedValueOnce(
      ok({
        action: 'UNBAN',
        outcomes: [{ targetId: USER, ok: false, code: 'DISCORD_API_ERROR' }],
      }),
    );
    await expect(dispatcher.dispatch(job('UNBAN'))).rejects.toMatchObject({
      code: 'DISCORD_API_ERROR',
    });
    expect(mocks.terminalizeScheduledCase).not.toHaveBeenCalled();
    expect(mocks.writeCase).not.toHaveBeenCalled();
    // The thrown error classifies as retryable so the scheduler re-queues it.
    expect(
      classifier.classify(
        Object.assign(new Error('x'), { code: 'DISCORD_API_ERROR' }),
      ),
    ).toBe('RETRYABLE');
  });

  it('terminalizes FAILED once for a 400/403 Discord failure (preserved status)', async () => {
    const { dispatcher, mocks } = harness('UNBAN');
    mocks.execute.mockResolvedValueOnce(
      ok({
        action: 'UNBAN',
        outcomes: [
          { targetId: USER, ok: false, code: 'DISCORD_API_ERROR', status: 403 },
        ],
      }),
    );
    await expect(dispatcher.dispatch(job('UNBAN'))).rejects.toMatchObject({
      code: 'DISCORD_API_ERROR',
      status: 403,
    });
    expect(mocks.terminalizeScheduledCase).toHaveBeenCalledOnce();
    expect(mocks.terminalizeScheduledCase).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'FAILED',
        errorCode: 'DISCORD_API_ERROR',
      }),
    );
    expect(mocks.writeCase).toHaveBeenCalledOnce();
  });

  it('treats a 5xx Discord failure as retryable (no terminalization before final attempt)', async () => {
    const { dispatcher, mocks } = harness('UNBAN');
    mocks.execute.mockResolvedValueOnce(
      ok({
        action: 'UNBAN',
        outcomes: [
          { targetId: USER, ok: false, code: 'DISCORD_API_ERROR', status: 500 },
        ],
      }),
    );
    await expect(dispatcher.dispatch(job('UNBAN', 1))).rejects.toMatchObject({
      code: 'DISCORD_API_ERROR',
      status: 500,
    });
    expect(mocks.terminalizeScheduledCase).not.toHaveBeenCalled();
    expect(mocks.writeCase).not.toHaveBeenCalled();
    expect(
      classifier.classify(
        Object.assign(new Error('x'), {
          code: 'DISCORD_API_ERROR',
          status: 500,
        }),
      ),
    ).toBe('RETRYABLE');
  });

  it('treats a 404 outcome as idempotent success (terminalize COMPLETED)', async () => {
    const { dispatcher, mocks } = harness('UNBAN');
    mocks.execute.mockResolvedValueOnce(
      ok({
        action: 'UNBAN',
        outcomes: [
          { targetId: USER, ok: false, code: 'DISCORD_API_ERROR', status: 404 },
        ],
      }),
    );
    await dispatcher.dispatch(job('UNBAN'));
    expect(mocks.terminalizeScheduledCase).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'COMPLETED' }),
    );
    expect(mocks.writeCase).toHaveBeenCalledOnce();
  });

  it('propagates a 401 outcome as fatal without terminalizing', async () => {
    const { dispatcher, mocks } = harness('UNBAN');
    mocks.execute.mockResolvedValueOnce(
      ok({
        action: 'UNBAN',
        outcomes: [
          { targetId: USER, ok: false, code: 'DISCORD_API_ERROR', status: 401 },
        ],
      }),
    );
    await expect(dispatcher.dispatch(job('UNBAN'))).rejects.toMatchObject({
      status: 401,
    });
    expect(mocks.terminalizeScheduledCase).not.toHaveBeenCalled();
    expect(mocks.writeCase).not.toHaveBeenCalled();
  });

  it('terminalizes FAILED + modlog for a retryable failure at the final attempt', async () => {
    const { dispatcher, mocks } = harness('UNBAN');
    mocks.execute.mockResolvedValueOnce(
      ok({
        action: 'UNBAN',
        outcomes: [
          { targetId: USER, ok: false, code: 'DISCORD_API_ERROR', status: 500 },
        ],
      }),
    );
    // attempts === SCHEDULED_MAX_ATTEMPTS (5) → final attempt.
    await expect(dispatcher.dispatch(job('UNBAN', 5))).rejects.toMatchObject({
      code: 'DISCORD_API_ERROR',
      status: 500,
    });
    expect(mocks.terminalizeScheduledCase).toHaveBeenCalledOnce();
    expect(mocks.terminalizeScheduledCase).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILED' }),
    );
    expect(mocks.writeCase).toHaveBeenCalledOnce();
  });

  it('rethrows an unauthorized modlog delivery (401) after terminalizing', async () => {
    const { dispatcher, mocks } = harness('UNBAN');
    const fatal = Object.assign(new Error('modlog unauthorized'), {
      status: 401,
    });
    mocks.writeCase.mockRejectedValueOnce(fatal);
    await expect(dispatcher.dispatch(job('UNBAN'))).rejects.toBe(fatal);
    // The case was terminalized COMPLETED before the modlog attempt.
    expect(mocks.terminalizeScheduledCase).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'COMPLETED' }),
    );
  });

  it('swallows a non-auth modlog delivery failure after terminalizing', async () => {
    const { dispatcher, mocks } = harness('UNBAN');
    mocks.writeCase.mockRejectedValueOnce(
      Object.assign(new Error('modlog boom'), { status: 500 }),
    );
    await expect(dispatcher.dispatch(job('UNBAN'))).resolves.toBeUndefined();
    expect(mocks.terminalizeScheduledCase).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'COMPLETED' }),
    );
  });
});

describe('ScheduledModerationDispatcher UNMUTE case/modlog', () => {
  it('creates a SCHEDULED case, removes the role, terminalizes and emits modlog', async () => {
    const { dispatcher, mocks } = harness('UNMUTE');
    await dispatcher.dispatch(job('UNMUTE'));
    expect(mocks.createScheduledCase).toHaveBeenCalledOnce();
    // Active-mute ownership checks are preserved.
    expect(mocks.claimScheduledUnmute).toHaveBeenCalledOnce();
    expect(mocks.verifyScheduledUnmute).toHaveBeenCalledOnce();
    expect(mocks.removeRoleUnlocked).toHaveBeenCalledOnce();
    expect(mocks.completeScheduledUnmute).toHaveBeenCalledOnce();
    expect(mocks.terminalizeScheduledCase).toHaveBeenCalledOnce();
    expect(mocks.terminalizeScheduledCase).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: JOB_ID,
        executedCaseId: CASE_ID,
        status: 'COMPLETED',
      }),
    );
    expect(mocks.writeCase).toHaveBeenCalledOnce();
    expect(mocks.writeCase).toHaveBeenCalledWith(GUILD, CASE_ID);
  });

  it('treats an inactive mute as idempotent success (terminalize COMPLETED, one modlog)', async () => {
    const { dispatcher, mocks } = harness('UNMUTE');
    mocks.claimScheduledUnmute.mockResolvedValueOnce(false);
    await dispatcher.dispatch(job('UNMUTE'));
    expect(mocks.removeRoleUnlocked).not.toHaveBeenCalled();
    expect(mocks.terminalizeScheduledCase).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'COMPLETED' }),
    );
    expect(mocks.writeCase).toHaveBeenCalledOnce();
  });

  it('does not duplicate the case/modlog when an UNMUTE retry no longer owns the mute', async () => {
    const retry = harness('UNMUTE', { created: false, terminalizeWins: 0 });
    retry.mocks.claimScheduledUnmute.mockResolvedValueOnce(false);
    await retry.dispatcher.dispatch(job('UNMUTE'));
    // Terminalization does not win on retry → no modlog re-emitted.
    expect(retry.mocks.writeCase).not.toHaveBeenCalled();
    expect(retry.mocks.terminalizeScheduledCase).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'COMPLETED' }),
    );
  });

  it('rethrows a 401 during role removal without terminalizing (fatal propagates)', async () => {
    const { dispatcher, mocks } = harness('UNMUTE');
    const fatal = Object.assign(new Error('unauthorized'), { status: 401 });
    mocks.removeRoleUnlocked.mockRejectedValueOnce(fatal);
    await expect(dispatcher.dispatch(job('UNMUTE'))).rejects.toBe(fatal);
    // Ownership is restored for recovery, but the case is not terminalized.
    expect(mocks.restoreScheduledUnmute).toHaveBeenCalledOnce();
    expect(mocks.terminalizeScheduledCase).not.toHaveBeenCalled();
    expect(mocks.writeCase).not.toHaveBeenCalled();
  });

  it('terminalizes FAILED for a non-retryable role removal failure', async () => {
    const { dispatcher, mocks } = harness('UNMUTE');
    mocks.removeRoleUnlocked.mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), { status: 403 }),
    );
    await expect(dispatcher.dispatch(job('UNMUTE'))).rejects.toMatchObject({
      status: 403,
    });
    expect(mocks.terminalizeScheduledCase).toHaveBeenCalledOnce();
    expect(mocks.terminalizeScheduledCase).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILED' }),
    );
    expect(mocks.writeCase).toHaveBeenCalledOnce();
  });

  it('requires a successful mute-side CAS: a failed CAS after role removal retries unterminalized', async () => {
    const { dispatcher, mocks } = harness('UNMUTE');
    mocks.completeScheduledUnmute.mockResolvedValueOnce(false);
    await expect(dispatcher.dispatch(job('UNMUTE'))).rejects.toThrow(
      /ownership was lost/iu,
    );
    expect(mocks.removeRoleUnlocked).toHaveBeenCalledOnce();
    // Ownership is restored and the case is left PENDING for retry (no
    // COMPLETED terminalization without a successful mute-side CAS).
    expect(mocks.restoreScheduledUnmute).toHaveBeenCalledOnce();
    expect(mocks.terminalizeScheduledCase).not.toHaveBeenCalled();
    expect(mocks.writeCase).not.toHaveBeenCalled();
  });

  it('no-ops when the role is already absent: expires the mute, terminalizes COMPLETED', async () => {
    const { dispatcher, mocks } = harness('UNMUTE');
    mocks.hasRole.mockResolvedValueOnce(false);
    await dispatcher.dispatch(job('UNMUTE'));
    expect(mocks.removeRoleUnlocked).not.toHaveBeenCalled();
    expect(mocks.completeScheduledUnmute).toHaveBeenCalledOnce();
    expect(mocks.terminalizeScheduledCase).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'COMPLETED' }),
    );
    expect(mocks.writeCase).toHaveBeenCalledOnce();
  });

  it('terminalizes FAILED + modlog for a retryable UNMUTE failure at the final attempt', async () => {
    const { dispatcher, mocks } = harness('UNMUTE');
    mocks.removeRoleUnlocked.mockRejectedValueOnce(
      Object.assign(new Error('network'), { status: 500 }),
    );
    await expect(dispatcher.dispatch(job('UNMUTE', 5))).rejects.toMatchObject({
      status: 500,
    });
    expect(mocks.terminalizeScheduledCase).toHaveBeenCalledOnce();
    expect(mocks.terminalizeScheduledCase).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILED' }),
    );
    expect(mocks.writeCase).toHaveBeenCalledOnce();
  });

  it('rejects an invalid scheduled case request as a non-retryable failure', async () => {
    const { dispatcher, mocks } = harness('UNMUTE');
    mocks.createScheduledCase.mockResolvedValueOnce(
      err('INVALID_INPUT', 'Invalid scheduled case identity'),
    );
    await expect(dispatcher.dispatch(job('UNMUTE'))).rejects.toMatchObject({
      status: 400,
    });
    expect(mocks.terminalizeScheduledCase).not.toHaveBeenCalled();
  });
});
