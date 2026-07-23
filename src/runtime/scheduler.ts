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
  // The scheduler service treats only a direct/cause `status === 401` as fatal
  // and mis-classifies a `code === 401` failure as retryable. Wrap the
  // dispatcher so any authentication failure (status or code, direct or
  // cause-wrapped) reliably reaches the fatal handler before the job is
  // re-queued, instead of being swallowed as an ordinary retry.
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
  const activePolls = new Set<Promise<void>>();
  const poll = async (): Promise<void> => {
    if (stopped) return;
    await service.dispatchDue(guardedDispatcher);
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
      stopped = false;
      await schedulePoll();
      timer = setInterval(tick, intervalMs);
    },
    stop: async () => {
      stopped = true;
      service.stop();
      if (timer !== undefined) clearInterval(timer);
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
