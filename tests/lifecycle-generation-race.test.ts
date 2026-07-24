import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { createRetentionScheduler } from '../src/runtime/retention.js';
import { createJobScheduler } from '../src/runtime/scheduler.js';
import type {
  JobDto,
  SchedulerRepository,
} from '../src/repositories/contracts.js';
import { ok } from '../src/domain/result.js';

const silentLogger = () =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  }) as unknown as Logger;

describe('start→stop→start generation race', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  describe('job scheduler', () => {
    const repository = (
      claimDue: () => Promise<JobDto[]>,
    ): SchedulerRepository => ({
      scheduleReplacing: vi.fn(),
      cancelTarget: vi.fn(),
      findPending: vi.fn(),
      getStatus: vi.fn(),
      recoverStale: vi.fn(() => Promise.resolve(0)),
      claimDue: vi.fn(claimDue),
      complete: vi.fn(() => Promise.resolve(true)),
      fail: vi.fn(() => Promise.resolve(true)),
      createScheduledCase: vi.fn(),
      terminalizeScheduledCase: vi.fn(),
    });

    const claimCalls = (repo: SchedulerRepository) =>
      (repo.claimDue as ReturnType<typeof vi.fn>).mock.calls.length;

    it('a stale initial run never installs an interval after stop then restart', async () => {
      vi.useFakeTimers();
      try {
        let resolveClaim!: (jobs: JobDto[]) => void;
        let claimed = false;
        // The first claim suspends so the initial poll is still in flight when
        // stop() and the restart interleave; later claims resolve immediately.
        const repo = repository(() => {
          if (!claimed) {
            claimed = true;
            return new Promise<JobDto[]>((resolve) => {
              resolveClaim = resolve;
            });
          }
          return Promise.resolve([]);
        });
        const dispatch = vi.fn();
        const scheduler = createJobScheduler(
          repo,
          { available: true, supports: () => true, dispatch },
          'worker',
          5,
          silentLogger(),
        );
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

        // start → stop → start, all before the initial poll settles.
        const firstStart = scheduler.start();
        const stopping = scheduler.stop();
        const secondStart = scheduler.start();

        // The initial poll settles last, after the restart has already begun.
        resolveClaim([]);
        await firstStart;
        await stopping;
        await secondStart;

        // Exactly one interval was installed (by the latest start). The stale
        // initial run recognized itself as superseded and did NOT install a
        // leaked/duplicate interval that a later stop could never clear.
        expect(setIntervalSpy).toHaveBeenCalledTimes(1);

        // The scheduler is running on that single interval: a tick polls again.
        const claimsBeforeTick = claimCalls(repo);
        await vi.advanceTimersByTimeAsync(5);
        expect(claimCalls(repo)).toBeGreaterThan(claimsBeforeTick);

        // A final stop clears the single live interval; nothing leaks after it.
        await scheduler.stop();
        const claimsAfterStop = claimCalls(repo);
        await vi.advanceTimersByTimeAsync(100);
        expect(claimCalls(repo)).toBe(claimsAfterStop);
      } finally {
        vi.useRealTimers();
      }
    });

    it('restart after a settled stop installs exactly one fresh interval', async () => {
      vi.useFakeTimers();
      try {
        const repo = repository(() => Promise.resolve([]));
        const dispatch = vi.fn();
        const scheduler = createJobScheduler(
          repo,
          { available: true, supports: () => true, dispatch },
          'worker',
          5,
          silentLogger(),
        );
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

        await scheduler.start();
        await scheduler.stop();
        await scheduler.start();
        expect(setIntervalSpy).toHaveBeenCalledTimes(2);

        // Only the latest interval is live: one poll per tick, not two.
        const claimsBefore = claimCalls(repo);
        await vi.advanceTimersByTimeAsync(5);
        expect(claimCalls(repo)).toBe(claimsBefore + 1);

        await scheduler.stop();
        const claimsAfterStop = claimCalls(repo);
        await vi.advanceTimersByTimeAsync(100);
        expect(claimCalls(repo)).toBe(claimsAfterStop);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('retention scheduler', () => {
    const cleanup = { snapshots: 0, raidEvents: 0, scheduledActions: 0 };
    const port = (
      runAll: ReturnType<typeof vi.fn>,
    ): { runAll: ReturnType<typeof vi.fn> } => ({ runAll });

    it('a stale initial sweep never installs an interval after stop then restart', async () => {
      vi.useFakeTimers();
      try {
        let resolveSweep!: () => void;
        let sweeps = 0;
        // The first sweep suspends so it is still in flight when stop() and the
        // restart interleave; later sweeps resolve immediately.
        const runAll = vi.fn().mockImplementation(() => {
          sweeps += 1;
          if (sweeps === 1)
            return new Promise<typeof cleanup>((resolve) => {
              resolveSweep = () => {
                resolve(cleanup);
              };
            });
          return Promise.resolve(ok(cleanup));
        });
        const scheduler = createRetentionScheduler(port(runAll), {
          intervalMs: 1_000,
          logger: silentLogger(),
        });
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

        // start → stop → start, all before the initial sweep settles.
        const firstStart = scheduler.start();
        const stopping = scheduler.stop();
        const secondStart = scheduler.start();

        // The initial sweep settles last, after the restart has already begun.
        resolveSweep();
        await firstStart;
        await stopping;
        await secondStart;

        // Exactly one interval was installed (by the latest start); the stale
        // initial sweep did NOT install a leaked/duplicate interval.
        expect(setIntervalSpy).toHaveBeenCalledTimes(1);
        expect(runAll).toHaveBeenCalledOnce();

        // The scheduler is running on that single interval: a tick sweeps again.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(runAll).toHaveBeenCalledTimes(2);

        // A final stop clears the single live interval; nothing leaks after it.
        await scheduler.stop();
        const sweepsAfterStop = runAll.mock.calls.length;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(runAll.mock.calls.length).toBe(sweepsAfterStop);
      } finally {
        vi.useRealTimers();
      }
    });

    it('restart after a settled stop installs exactly one fresh interval', async () => {
      vi.useFakeTimers();
      try {
        const runAll = vi.fn().mockResolvedValue(ok(cleanup));
        const scheduler = createRetentionScheduler(port(runAll), {
          intervalMs: 1_000,
          logger: silentLogger(),
        });
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

        await scheduler.start(); // initial sweep (call 1)
        await scheduler.stop();
        await scheduler.start(); // initial sweep (call 2)
        expect(setIntervalSpy).toHaveBeenCalledTimes(2);

        // Only the latest interval is live: exactly one sweep per cadence.
        const sweepsBefore = runAll.mock.calls.length;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(runAll.mock.calls.length).toBe(sweepsBefore + 1);

        await scheduler.stop();
        const sweepsAfterStop = runAll.mock.calls.length;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(runAll.mock.calls.length).toBe(sweepsAfterStop);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
