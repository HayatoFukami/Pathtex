import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import {
  DEFAULT_DEDUPE_MAX_SIZE,
  InteractionDedupe,
} from '../src/runtime/dedupe.js';
import {
  GatewayOverloadedError,
  GatewayWorkTracker,
} from '../src/runtime/gateway-work.js';
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

/** Flushes pending microtasks so the tracker's asynchronous bookkeeping (which
 * removes a task from the in-flight set on a microtask) settles before asserts. */
const flush = async (): Promise<void> => {
  for (let index = 0; index < 4; index++)
    await new Promise<void>((resolve) => setImmediate(resolve));
};

describe('InteractionDedupe bounded regression', () => {
  it('accepts once, rejects duplicates within TTL, re-accepts after expiry', () => {
    let now = 0;
    const dedupe = new InteractionDedupe(300_000, () => now);
    expect(dedupe.accept('i')).toBe(true);
    expect(dedupe.accept('i')).toBe(false);
    now = 300_000;
    expect(dedupe.accept('i')).toBe(true);
  });

  it('never exceeds maxSize even under a flood of unique IDs', () => {
    const maxSize = 16;
    const dedupe = new InteractionDedupe(300_000, () => 0, maxSize);
    for (let index = 0; index < 10_000; index++)
      dedupe.accept(`id-${String(index)}`);
    expect(dedupe.size).toBeLessThanOrEqual(maxSize);
  });

  it('fails closed for new IDs at capacity instead of evicting unexpired entries', () => {
    const dedupe = new InteractionDedupe(300_000, () => 0, 2);
    expect(dedupe.accept('a')).toBe(true);
    expect(dedupe.accept('b')).toBe(true);
    // At capacity with unexpired entries: a new ID is rejected (fail closed)
    // rather than displacing a still-protected entry.
    expect(dedupe.accept('c')).toBe(false);
    expect(dedupe.size).toBe(2);
    // The accepted IDs remain rejected; none was evicted to make room.
    expect(dedupe.accept('a')).toBe(false);
    expect(dedupe.accept('b')).toBe(false);
  });

  it('keeps an accepted ID rejected for its full TTL even under a unique-ID flood at capacity', () => {
    let now = 0;
    const dedupe = new InteractionDedupe(100, () => now, 2);
    expect(dedupe.accept('a')).toBe(true);
    expect(dedupe.accept('b')).toBe(true);
    // A flood of new unique IDs at capacity must not displace 'a' or 'b'.
    for (let index = 0; index < 100; index++)
      dedupe.accept(`x-${String(index)}`);
    expect(dedupe.accept('a')).toBe(false);
    expect(dedupe.accept('b')).toBe(false);
    expect(dedupe.size).toBe(2);
    // Once the TTL elapses, expired entries are pruned and IDs re-accepted.
    now = 100;
    expect(dedupe.accept('a')).toBe(true);
  });

  it('prefers dropping expired entries before unexpired ones', () => {
    let now = 0;
    const dedupe = new InteractionDedupe(100, () => now, 2);
    dedupe.accept('a'); // expires at 100
    now = 50;
    dedupe.accept('b'); // expires at 150
    // At capacity. Age past 'a's expiry but not 'b's, then admit 'c'.
    now = 101;
    dedupe.accept('c');
    // The expired 'a' was evicted to make room; the unexpired 'b' survived.
    expect(dedupe.accept('b')).toBe(false);
  });

  it('exposes a generous default bound', () => {
    expect(DEFAULT_DEDUPE_MAX_SIZE).toBeGreaterThan(0);
    const dedupe = new InteractionDedupe();
    expect(dedupe.size).toBe(0);
  });
});

describe('GatewayWorkTracker backpressure and drain', () => {
  it('runs an operation and resolves with its outcome', async () => {
    const tracker = new GatewayWorkTracker();
    const ran: string[] = [];
    await tracker.run(() => {
      ran.push('work');
      return Promise.resolve();
    });
    expect(ran).toEqual(['work']);
    await flush();
    expect(tracker.pending).toBe(0);
  });

  it('propagates an operation rejection while still clearing the task', async () => {
    const tracker = new GatewayWorkTracker();
    await expect(
      tracker.run(() => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    await flush();
    expect(tracker.pending).toBe(0);
  });

  it('bounds concurrency so operations run serially at maxConcurrency=1', async () => {
    const tracker = new GatewayWorkTracker({ maxConcurrency: 1 });
    let active = 0;
    let maxActive = 0;
    const make = () =>
      tracker.run(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      });
    await Promise.all([make(), make(), make()]);
    expect(maxActive).toBe(1);
  });

  it('sheds the newest task with GatewayOverloadedError when saturated', async () => {
    const tracker = new GatewayWorkTracker({ maxConcurrency: 1, maxQueued: 0 });
    let release!: () => void;
    const first = tracker.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    // The single slot is taken and the queue is full, so this is shed.
    await expect(tracker.run(() => Promise.resolve())).rejects.toBeInstanceOf(
      GatewayOverloadedError,
    );
    release();
    await first;
  });

  it('never sheds a critical task when both the slot and the queue are full', async () => {
    const tracker = new GatewayWorkTracker({ maxConcurrency: 1, maxQueued: 0 });
    let release!: () => void;
    const first = tracker.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    // A non-critical task is shed under the same saturation...
    await expect(tracker.run(() => Promise.resolve())).rejects.toBeInstanceOf(
      GatewayOverloadedError,
    );
    // ...but a critical state transition is preserved (queued, not shed).
    let criticalRan = false;
    const critical = tracker.runCritical(() => {
      criticalRan = true;
      return Promise.resolve();
    });
    await flush();
    expect(criticalRan).toBe(false); // still queued behind the active slot
    expect(tracker.queued).toBe(1);
    release();
    await first;
    await critical;
    expect(criticalRan).toBe(true);
    await flush();
    expect(tracker.pending).toBe(0);
  });

  it('queues critical tasks beyond maxQueued while non-critical tasks are shed', async () => {
    const tracker = new GatewayWorkTracker({ maxConcurrency: 1, maxQueued: 1 });
    let release!: () => void;
    const first = tracker.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    // Fill the single queue slot with a non-critical task.
    const queuedNonCritical = tracker.run(() => Promise.resolve());
    // The next non-critical task is shed...
    await expect(tracker.run(() => Promise.resolve())).rejects.toBeInstanceOf(
      GatewayOverloadedError,
    );
    // ...while any number of critical tasks keep queueing past the bound.
    const ran: string[] = [];
    const criticals = [
      tracker.runCritical(() => {
        ran.push('c1');
        return Promise.resolve();
      }),
      tracker.runCritical(() => {
        ran.push('c2');
        return Promise.resolve();
      }),
    ];
    await flush();
    expect(ran).toEqual([]);
    release();
    await Promise.all([first, queuedNonCritical, ...criticals]);
    expect(ran).toEqual(['c1', 'c2']);
  });

  it('drain waits for queued critical tasks to settle', async () => {
    const tracker = new GatewayWorkTracker({ maxConcurrency: 1, maxQueued: 0 });
    let release!: () => void;
    const first = tracker.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let criticalRan = false;
    const critical = tracker.runCritical(() => {
      criticalRan = true;
      return Promise.resolve();
    });
    let drained = false;
    const draining = tracker.drain(1_000).then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(drained).toBe(false);
    release();
    await Promise.all([first, critical]);
    await draining;
    expect(criticalRan).toBe(true);
    expect(drained).toBe(true);
  });

  it('drains only after every in-flight task settles', async () => {
    const tracker = new GatewayWorkTracker();
    let release!: () => void;
    const pending = tracker.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let drained = false;
    const draining = tracker.drain(1_000).then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(drained).toBe(false);
    release();
    await pending;
    await draining;
    expect(drained).toBe(true);
  });

  it('bounds drain by its timeout so a stuck task cannot hang shutdown', async () => {
    vi.useFakeTimers();
    try {
      const tracker = new GatewayWorkTracker();
      void tracker.run(() => new Promise<void>(() => undefined));
      const draining = tracker.drain(15_000);
      let settled = false;
      void draining.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(15_000);
      await draining;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('retention scheduler', () => {
  const port = (
    runAll: ReturnType<typeof vi.fn>,
  ): { runAll: ReturnType<typeof vi.fn> } => ({ runAll });

  it('runs an initial sweep on start', async () => {
    const runAll = vi
      .fn()
      .mockResolvedValue(
        ok({ snapshots: 1, raidEvents: 0, scheduledActions: 0 }),
      );
    const scheduler = createRetentionScheduler(port(runAll), {
      intervalMs: 60_000,
      logger: silentLogger(),
    });
    await scheduler.start();
    expect(runAll).toHaveBeenCalledOnce();
    await scheduler.stop();
  });

  it('sweeps periodically on the configured cadence', async () => {
    vi.useFakeTimers();
    try {
      const runAll = vi
        .fn()
        .mockResolvedValue(
          ok({ snapshots: 0, raidEvents: 0, scheduledActions: 0 }),
        );
      const scheduler = createRetentionScheduler(port(runAll), {
        intervalMs: 60_000,
        logger: silentLogger(),
      });
      await scheduler.start();
      expect(runAll).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runAll).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runAll).toHaveBeenCalledTimes(3);
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is failure-safe: a throwing sweep never propagates or stops the cadence', async () => {
    vi.useFakeTimers();
    try {
      const logger = silentLogger();
      const runAll = vi.fn().mockRejectedValue(new Error('db down'));
      const scheduler = createRetentionScheduler(port(runAll), {
        intervalMs: 60_000,
        logger,
      });
      await expect(scheduler.start()).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runAll).toHaveBeenCalledTimes(2);
      expect(
        (logger as unknown as { error: ReturnType<typeof vi.fn> }).error,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'retention.sweep_failed' }),
        expect.any(String),
      );
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes sweeps: a slow sweep causes the next tick to be skipped', async () => {
    vi.useFakeTimers();
    try {
      let resolveSweep!: () => void;
      let calls = 0;
      const runAll = vi.fn().mockImplementation(() => {
        calls += 1;
        return new Promise<{
          snapshots: number;
          raidEvents: number;
          scheduledActions: number;
        }>((resolve) => {
          resolveSweep = () => {
            resolve({ snapshots: 0, raidEvents: 0, scheduledActions: 0 });
          };
        });
      });
      const scheduler = createRetentionScheduler(port(runAll), {
        intervalMs: 1_000,
        logger: silentLogger(),
      });
      const starting = scheduler.start();
      // The initial sweep is in flight and never resolves yet.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toBe(1);
      resolveSweep();
      await starting;
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop awaits an in-flight sweep before returning', async () => {
    let resolveSweep!: () => void;
    let finished = false;
    const runAll = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSweep = () => {
            finished = true;
            resolve();
          };
        }),
    );
    const scheduler = createRetentionScheduler(port(runAll), {
      intervalMs: 60_000,
      logger: silentLogger(),
    });
    const starting = scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const stopping = scheduler.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(stopped).toBe(false);
    resolveSweep();
    await starting;
    await stopping;
    expect(finished).toBe(true);
    expect(stopped).toBe(true);
  });

  it('does not install the sweep interval when stop races the initial sweep', async () => {
    vi.useFakeTimers();
    try {
      let resolveSweep!: () => void;
      const runAll = vi.fn().mockImplementation(
        () =>
          new Promise<{
            snapshots: number;
            raidEvents: number;
            scheduledActions: number;
          }>((resolve) => {
            resolveSweep = () => {
              resolve({ snapshots: 0, raidEvents: 0, scheduledActions: 0 });
            };
          }),
      );
      const scheduler = createRetentionScheduler(port(runAll), {
        intervalMs: 1_000,
        logger: silentLogger(),
      });
      // The initial sweep is in flight when stop is requested.
      const starting = scheduler.start();
      const stopping = scheduler.stop();
      resolveSweep();
      await starting;
      await stopping;
      expect(runAll).toHaveBeenCalledOnce();
      // No interval may have been installed after the raced stop.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(runAll).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes start and stop idempotent', async () => {
    vi.useFakeTimers();
    try {
      const runAll = vi
        .fn()
        .mockResolvedValue(
          ok({ snapshots: 0, raidEvents: 0, scheduledActions: 0 }),
        );
      const scheduler = createRetentionScheduler(port(runAll), {
        intervalMs: 1_000,
        logger: silentLogger(),
      });
      await scheduler.start();
      await scheduler.start(); // second start is a no-op
      expect(runAll).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_000);
      // A single interval (not two) is running.
      expect(runAll).toHaveBeenCalledTimes(2);
      await scheduler.stop();
      await scheduler.stop(); // second stop is a no-op
      await vi.advanceTimersByTimeAsync(5_000);
      expect(runAll).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('serialized scheduler polls', () => {
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

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('never overlaps two dispatch cycles even when ticks fire fast', async () => {
    vi.useFakeTimers();
    try {
      let active = 0;
      let maxActive = 0;
      let first = true;
      const repo = repository(() => {
        // Return one job only on the first claim so the poll does real work.
        return Promise.resolve(first ? ((first = false), [job]) : []);
      });
      const dispatch = vi.fn().mockImplementation(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
      });
      const scheduler = createJobScheduler(
        repo,
        { available: true, supports: () => true, dispatch },
        'worker',
        5,
        silentLogger(),
      );
      const started = scheduler.start();
      await vi.advanceTimersByTimeAsync(100);
      await scheduler.stop();
      await started;
      expect(maxActive).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not install the polling interval when stop races the initial run', async () => {
    vi.useFakeTimers();
    try {
      let resolveClaim!: (jobs: JobDto[]) => void;
      const repo = repository(
        () =>
          new Promise<JobDto[]>((resolve) => {
            resolveClaim = resolve;
          }),
      );
      const dispatch = vi.fn();
      const scheduler = createJobScheduler(
        repo,
        { available: true, supports: () => true, dispatch },
        'worker',
        5,
        silentLogger(),
      );
      // The initial poll suspends on claimDue; stop is requested before it
      // resolves, so no interval may be installed afterwards.
      const starting = scheduler.start();
      const stopping = scheduler.stop();
      resolveClaim([]);
      await starting;
      await stopping;
      const claims = (repo.claimDue as ReturnType<typeof vi.fn>).mock.calls
        .length;
      await vi.advanceTimersByTimeAsync(100);
      expect(
        (repo.claimDue as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBe(claims);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes start and stop idempotent', async () => {
    vi.useFakeTimers();
    try {
      let first = true;
      const repo = repository(() =>
        Promise.resolve(first ? ((first = false), [job]) : []),
      );
      const dispatch = vi.fn().mockResolvedValue(undefined);
      const scheduler = createJobScheduler(
        repo,
        { available: true, supports: () => true, dispatch },
        'worker',
        5,
        silentLogger(),
      );
      await scheduler.start();
      await scheduler.start(); // second start is a no-op
      const claimsAfterStart = (repo.claimDue as ReturnType<typeof vi.fn>).mock
        .calls.length;
      await vi.advanceTimersByTimeAsync(20);
      const claimsPerTick =
        (repo.claimDue as ReturnType<typeof vi.fn>).mock.calls.length -
        claimsAfterStart;
      await scheduler.stop();
      await scheduler.stop(); // second stop is a no-op
      const claimsAfterStop = (repo.claimDue as ReturnType<typeof vi.fn>).mock
        .calls.length;
      await vi.advanceTimersByTimeAsync(100);
      // A single interval ran before stop, and none after.
      expect(claimsPerTick).toBeGreaterThan(0);
      expect(
        (repo.claimDue as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBe(claimsAfterStop);
    } finally {
      vi.useRealTimers();
    }
  });
});
