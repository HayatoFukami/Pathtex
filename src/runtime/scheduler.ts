import type { JobDto, SchedulerRepository } from '../repositories/contracts.js';
import type { Logger } from 'pino';
import { SchedulerService } from '../services/scheduler-service.js';
import { isUnauthorized } from '../features/logging/adapters.js';

export interface JobDispatcher {
  supports(job: JobDto): boolean;
  readonly supportedTypes?: readonly JobDto['type'][];
  dispatch(job: JobDto): Promise<void>;
  readonly available?: boolean;
}
export interface SchedulerRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  recover(): Promise<number>;
}

export function createJobScheduler(
  repository: SchedulerRepository,
  dispatcher: JobDispatcher,
  workerId: string,
  intervalMs = 5_000,
  logger?: Logger,
  pollTimeoutMs = 15_000,
): SchedulerRuntime {
  let fatalRaised = false;
  const fatal = (error: unknown): void => {
    if (fatalRaised) return;
    fatalRaised = true;
    logger?.fatal(
      {
        event: 'scheduler.fatal_discord_authentication',
        errorName: error instanceof Error ? error.name : 'unknown',
      },
      'Fatal Discord authentication failure; requesting runtime shutdown',
    );
    // Mark a nonzero exit status before requesting shutdown so the graceful
    // SIGTERM handler (which only defaults the code to 0 when unset) preserves
    // the failure instead of exiting cleanly.
    process.exitCode = 1;
    process.emit('SIGTERM');
  };
  const service = new SchedulerService(repository, {
    workerId,
    onFatal: fatal,
  });
  // Defense in depth: SchedulerService.classify already treats a direct/cause
  // `status === 401` or `code === 401` as fatal, but wrap the dispatcher too so
  // the fatal handler fires as early as possible (before the service's own
  // classification runs) and stays correct even if that classification ever
  // regresses. `fatal` is idempotent, so this can never double-report.
  const guardedDispatcher: JobDispatcher = {
    ...dispatcher,
    dispatch: async (job: JobDto): Promise<void> => {
      try {
        await dispatcher.dispatch(job);
      } catch (error) {
        if (isUnauthorized(error)) fatal(error);
        throw error;
      }
    },
  };
  let timer: NodeJS.Timeout | undefined;
  let stopped = true;
  // Monotonic lifecycle generation. Every start() and stop() advances it, so an
  // initial poll that settles after a concurrent stop→restart can recognize
  // itself as stale and refuse to install its interval. A bare `stopped` flag
  // cannot distinguish "the stop that raced me" from "a newer start that
  // re-cleared the flag", which previously let a stale start install a leaked
  // (or duplicate) interval after stop() then start().
  let generation = 0;
  // Serializes polls: a tick that fires while a previous poll is still
  // dispatching is skipped instead of overlapping. Overlapping polls could
  // double-claim under a slow database and pile up unbounded in-flight work.
  let polling = false;
  const activePolls = new Set<Promise<void>>();
  const poll = async (): Promise<void> => {
    if (stopped || polling) return;
    polling = true;
    try {
      await service.dispatchDue(guardedDispatcher);
    } finally {
      polling = false;
    }
  };
  const schedulePoll = (): Promise<void> => {
    const operation = poll().catch((error: unknown) => {
      // A fatal authentication failure is routed to the fatal handler rather
      // than being logged as a routine poll failure.
      if (isUnauthorized(error)) {
        fatal(error);
        return;
      }
      logger?.error(
        {
          event: 'scheduler.poll_failed',
          errorName: error instanceof Error ? error.name : 'unknown',
        },
        'Scheduler poll failed',
      );
    });
    activePolls.add(operation);
    void operation
      .finally(() => activePolls.delete(operation))
      .catch(() => undefined);
    return operation;
  };
  const tick = (): void => {
    if (!stopped) void schedulePoll();
  };
  return {
    start: async () => {
      if (dispatcher.available !== true) {
        logger?.warn(
          {
            event: 'scheduler.disabled',
            reason: 'no_full_supported_dispatcher',
          },
          'Scheduler disabled',
        );
        return;
      }
      // Idempotent: a second start while already running is a no-op.
      if (!stopped) return;
      stopped = false;
      const gen = ++generation;
      await schedulePoll();
      // Install the interval only if this start is still the current lifecycle
      // generation. A concurrent stop() or a newer start() advances
      // `generation`, so a stale initial poll never installs (or overwrites)
      // the live timer after a stop→restart race. Reading the generation (not
      // the `stopped` flag) is what makes this race-safe: stop() always bumps
      // the generation synchronously, so a stale start is always detectable
      // even after a newer start has re-cleared `stopped`.
      if (gen !== generation) return;
      timer = setInterval(tick, intervalMs);
    },
    stop: async () => {
      // Idempotent: stopping an already-stopped scheduler only (re)drains any
      // settled in-flight polls and clears no live timer. Advance the
      // generation synchronously (before any await) so an in-flight initial
      // start settles as stale and skips installing its interval.
      generation++;
      stopped = true;
      service.stop();
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...activePolls]),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, pollTimeoutMs);
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },
    recover: () => repository.recoverStale(),
  };
}
