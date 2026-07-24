import type { Logger } from 'pino';
import type { Result } from '../domain/result.js';
import type { RetentionCleanupResult } from '../services/retention-service.js';

/** Default retention sweep cadence: hourly (spec `01-platform-and-data.md
 * §4.17`). Retention windows are measured in days/minutes, so an hourly sweep
 * removes expired rows promptly without pressuring the database. */
export const DEFAULT_RETENTION_INTERVAL_MS = 60 * 60 * 1000;

/** Minimal retention contract the scheduler depends on (satisfied by
 * `RetentionService`). Kept structural so the scheduler is unit-testable
 * without a database. */
export interface RetentionPort {
  runAll(now?: Date): Promise<Result<RetentionCleanupResult>>;
}

export interface RetentionSchedulerOptions {
  /** Sweep cadence in milliseconds. Defaults to one hour. */
  readonly intervalMs?: number;
  /** Reference-time source; defaults to the current time at each sweep. */
  readonly now?: () => Date;
  readonly logger?: Logger;
}

export interface RetentionSchedulerRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Periodic, failure-safe retention sweep scheduler.
 *
 * Runs `RetentionService.runAll` on a fixed cadence (default hourly). It is:
 *
 * - **failure-safe**: a rejected or thrown sweep is logged and swallowed — a
 *   retention hiccup must never crash the runtime or abort startup;
 * - **serialized**: a new sweep is skipped while the previous one is still in
 *   flight, so a slow database cannot produce overlapping delete storms;
 * - **clean on shutdown**: `stop()` clears the timer and awaits any in-flight
 *   sweep so retention does not race the Prisma disconnect. */
export function createRetentionScheduler(
  retention: RetentionPort,
  options: RetentionSchedulerOptions = {},
): RetentionSchedulerRuntime {
  const intervalMs = Math.max(
    1_000,
    options.intervalMs ?? DEFAULT_RETENTION_INTERVAL_MS,
  );
  const logger = options.logger;
  let timer: NodeJS.Timeout | undefined;
  let stopped = true;
  let running = false;
  let inflight: Promise<void> | undefined;
  // Monotonic lifecycle generation. Every start() and stop() advances it, so an
  // initial sweep that settles after a concurrent stop→restart can recognize
  // itself as stale and refuse to install its interval. A bare `stopped` flag
  // cannot distinguish "the stop that raced me" from "a newer start that
  // re-cleared the flag", which previously let a stale start install a leaked
  // (or duplicate) interval after stop() then start().
  let generation = 0;

  const sweep = (): Promise<void> => {
    if (stopped || running) return Promise.resolve();
    running = true;
    inflight = (async () => {
      try {
        const result = await retention.runAll(options.now?.());
        if (result.ok) {
          logger?.info(
            {
              event: 'retention.sweep',
              snapshots: result.value.snapshots,
              raidEvents: result.value.raidEvents,
              scheduledActions: result.value.scheduledActions,
            },
            'Retention sweep completed',
          );
        } else {
          logger?.warn(
            { event: 'retention.sweep_rejected', code: result.error.code },
            'Retention sweep rejected its input',
          );
        }
      } catch (error: unknown) {
        logger?.error(
          {
            event: 'retention.sweep_failed',
            errorName: error instanceof Error ? error.name : 'unknown',
          },
          'Retention sweep failed',
        );
      } finally {
        running = false;
      }
    })();
    return inflight;
  };

  return {
    start: async () => {
      // Idempotent: a second start while already running is a no-op.
      if (!stopped) return;
      stopped = false;
      const gen = ++generation;
      await sweep();
      // Install the interval only if this start is still the current lifecycle
      // generation. A concurrent stop() or a newer start() advances
      // `generation`, so a stale initial sweep never installs (or overwrites)
      // the live timer after a stop→restart race. Reading the generation (not
      // the `stopped` flag) is what makes this race-safe: stop() always bumps
      // the generation synchronously, so a stale start is always detectable
      // even after a newer start has re-cleared `stopped`.
      if (gen !== generation) return;
      timer = setInterval(() => {
        void sweep();
      }, intervalMs);
    },
    stop: async () => {
      // Idempotent: stopping an already-stopped scheduler only (re)awaits any
      // settled in-flight sweep and clears no live timer. Advance the
      // generation synchronously (before any await) so an in-flight initial
      // start settles as stale and skips installing its interval.
      generation++;
      stopped = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      if (inflight !== undefined) await inflight.catch(() => undefined);
    },
  };
}
