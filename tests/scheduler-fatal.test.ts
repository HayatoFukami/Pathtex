import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJobScheduler } from '../src/runtime/scheduler.js';
import type {
  JobDto,
  SchedulerRepository,
} from '../src/repositories/contracts.js';
import type { Logger } from 'pino';

const job = {
  id: '00000000-0000-4000-8000-000000000001',
  guildId: '12345678901234567',
  type: 'UNBAN',
  payload: {},
  executeAt: new Date(),
  status: 'RUNNING',
  attempts: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
} as JobDto;

const repository = (): SchedulerRepository => ({
  scheduleReplacing: vi.fn(),
  cancelTarget: vi.fn(),
  findPending: vi.fn(),
  getStatus: vi.fn(),
  recoverStale: vi.fn(() => Promise.resolve(0)),
  claimDue: vi.fn(() => Promise.resolve([job])),
  complete: vi.fn(() => Promise.resolve(true)),
  fail: vi.fn(() => Promise.resolve(true)),
  createScheduledCase: vi.fn(),
  terminalizeScheduledCase: vi.fn(),
});

const stubLogger = () =>
  ({
    fatal: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }) as unknown as Logger;

const spies = (log: Logger) => ({
  fatal: (log as unknown as { fatal: ReturnType<typeof vi.fn> }).fatal,
  error: (log as unknown as { error: ReturnType<typeof vi.fn> }).error,
});

/** Spies on process.emit while suppressing the real SIGTERM emission. The cast
 * sidesteps the overloaded emit signature whose return type varies by overload. */
const mockEmit = () =>
  vi.spyOn(process, 'emit').mockImplementation((() => true) as never);

const run = async (
  repo: SchedulerRepository,
  dispatch: () => Promise<void>,
  log: Logger,
) => {
  const scheduler = createJobScheduler(
    repo,
    { available: true, supports: () => true, dispatch },
    'worker',
    60_000,
    log,
  );
  await scheduler.start();
  await scheduler.stop();
};

describe('scheduler fatal-401 propagation', () => {
  const originalExitCode = process.exitCode;
  afterEach(() => {
    vi.restoreAllMocks();
    // The fatal path sets a nonzero exit status; restore it so the side effect
    // does not leak into the test runner's own exit code.
    process.exitCode = originalExitCode;
  });

  it('sets a nonzero exit status before emitting SIGTERM on fatal', async () => {
    let exitCodeAtEmit: typeof process.exitCode;
    const emit = vi.spyOn(process, 'emit').mockImplementation(((
      ...args: unknown[]
    ) => {
      if (args[0] === 'SIGTERM') exitCodeAtEmit = process.exitCode;
      return true;
    }) as never);
    const log = stubLogger();
    await run(
      repository(),
      () =>
        Promise.reject(
          Object.assign(new Error('unauthorized'), { status: 401 }),
        ),
      log,
    );
    expect(emit).toHaveBeenCalledWith('SIGTERM');
    // The exit status must already be nonzero when SIGTERM is emitted so the
    // graceful handler (which only defaults to 0 when unset) preserves it.
    expect(exitCodeAtEmit).toBe(1);
    expect(process.exitCode).toBe(1);
  });

  it('routes a status 401 dispatch failure to fatal, not a routine poll error', async () => {
    const emit = mockEmit();
    const log = stubLogger();
    await run(
      repository(),
      () =>
        Promise.reject(
          Object.assign(new Error('unauthorized'), { status: 401 }),
        ),
      log,
    );
    const { fatal, error } = spies(log);
    expect(fatal).toHaveBeenCalledOnce();
    expect(fatal).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'scheduler.fatal_discord_authentication',
      }),
      expect.any(String),
    );
    expect(emit).toHaveBeenCalledWith('SIGTERM');
    // The auth failure must not also be logged as a routine poll failure.
    expect(error).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'scheduler.poll_failed' }),
      expect.any(String),
    );
  });

  it('routes a code 401 dispatch failure to fatal without failing/re-queueing the job', async () => {
    const emit = mockEmit();
    const log = stubLogger();
    const repo = repository();
    await run(
      repo,
      () =>
        Promise.reject(Object.assign(new Error('unauthorized'), { code: 401 })),
      log,
    );
    const { fatal } = spies(log);
    // The service now classifies a direct/cause-wrapped status OR code 401 as
    // fatal, so the fatal handler fires exactly once.
    expect(fatal).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith('SIGTERM');
    // A fatal auth failure must never be recorded as a retryable fail/requeue.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repo.fail).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repo.complete).not.toHaveBeenCalled();
  });

  it('never fails/re-queues a status 401 (direct or cause-wrapped) fatal failure', async () => {
    for (const error of [
      Object.assign(new Error('unauthorized'), { status: 401 }),
      Object.assign(new Error('wrapper'), { cause: { status: 401 } }),
      Object.assign(new Error('wrapper'), { cause: { code: 401 } }),
    ]) {
      const emit = mockEmit();
      const log = stubLogger();
      const repo = repository();
      await run(repo, () => Promise.reject(error), log);
      const { fatal } = spies(log);
      expect(fatal).toHaveBeenCalledOnce();
      expect(emit).toHaveBeenCalledWith('SIGTERM');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(repo.fail).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(repo.complete).not.toHaveBeenCalled();
      emit.mockRestore();
    }
  });

  it('routes a cause-wrapped 401 dispatch failure to fatal', async () => {
    const emit = mockEmit();
    const log = stubLogger();
    await run(
      repository(),
      () =>
        Promise.reject(
          Object.assign(new Error('wrapper'), { cause: { status: 401 } }),
        ),
      log,
    );
    const { fatal } = spies(log);
    expect(fatal).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith('SIGTERM');
  });

  it('routes a 401 surfaced during claim to fatal rather than a routine poll error', async () => {
    const emit = mockEmit();
    const log = stubLogger();
    const repo = repository();
    (repo.claimDue as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('unauthorized'), { status: 401 }),
    );
    await run(repo, () => Promise.resolve(), log);
    const { fatal, error } = spies(log);
    expect(fatal).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith('SIGTERM');
    expect(error).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'scheduler.poll_failed' }),
      expect.any(String),
    );
  });

  it('keeps a non-auth dispatch failure retryable without going fatal', async () => {
    const emit = mockEmit();
    const log = stubLogger();
    const repo = repository();
    await run(repo, () => Promise.reject(new Error('network')), log);
    const { fatal } = spies(log);
    expect(fatal).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith('SIGTERM');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repo.fail).toHaveBeenCalledWith(job.id, 'worker', 'network', true);
  });

  it('logs a non-auth claim failure as a routine poll error without going fatal', async () => {
    const emit = mockEmit();
    const log = stubLogger();
    const repo = repository();
    (repo.claimDue as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('db down'),
    );
    await run(repo, () => Promise.resolve(), log);
    const { fatal, error } = spies(log);
    expect(fatal).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith('SIGTERM');
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'scheduler.poll_failed' }),
      expect.any(String),
    );
  });
});
