import type { Logger } from 'pino';

export interface LifecycleStep {
  readonly name: string;
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
}
export interface DiscordClientLifecycle {
  login(signal: AbortSignal): Promise<void>;
  destroy(): Promise<void>;
}
export interface IntakeLifecycle {
  start(signal: AbortSignal): Promise<void>;
  stopAccepting(): Promise<void>;
  drain(): Promise<void>;
}
export interface LifecycleDependencies {
  readonly database: LifecycleStep;
  readonly migrations: LifecycleStep;
  readonly resources: LifecycleStep;
  readonly recoverStaleJobs: LifecycleStep;
  readonly scheduler: LifecycleStep;
  readonly intake: IntakeLifecycle;
  readonly voice: LifecycleStep;
  readonly prisma: LifecycleStep;
  createDiscordClient(signal: AbortSignal): Promise<DiscordClientLifecycle>;
}
export interface Lifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

const STARTUP_ORDER = ['database', 'migrations', 'resources'] as const;
const SHUTDOWN_TIMEOUT_MS = 15_000;
class StartupAbortedError extends Error {
  public constructor() {
    super('bootstrap startup aborted');
    this.name = 'StartupAbortedError';
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new StartupAbortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new StartupAbortedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener('abort', onAbort);
      })
      .catch(() => undefined);
  });
}

/** Startup operations are cancellable; shutdown never waits on an operation that ignores cancellation. */
export function createLifecycle(
  logger: Logger,
  dependencies: LifecycleDependencies,
): Lifecycle {
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let stopping = false;
  const startupAbort = new AbortController();
  const completed: LifecycleStep[] = [];
  const clients = new Set<DiscordClientLifecycle>();
  const destroyedClients = new WeakSet<DiscordClientLifecycle>();
  const pendingUnderlying = new Set<Promise<unknown>>();
  const lateCleanup = new Set<Promise<void>>();
  let finalized = false;

  const trackUnderlying = <T>(operation: Promise<T>): Promise<T> => {
    pendingUnderlying.add(operation);
    operation.then(
      () => pendingUnderlying.delete(operation),
      () => pendingUnderlying.delete(operation),
    );
    return operation;
  };
  const trackLateCleanup = (operation: Promise<void>): void => {
    lateCleanup.add(operation);
    operation.then(
      () => lateCleanup.delete(operation),
      () => lateCleanup.delete(operation),
    );
  };
  const destroyClient = async (
    value: DiscordClientLifecycle,
  ): Promise<void> => {
    if (destroyedClients.has(value)) return;
    destroyedClients.add(value);
    try {
      await value.destroy();
    } catch {
      logger.error(
        { event: 'shutdown.discord_failed', errorName: 'shutdown_failure' },
        'Discord shutdown failed',
      );
    }
  };
  const settlePending = async (): Promise<void> => {
    if (pendingUnderlying.size === 0) return;
    await Promise.race([
      (async () => {
        while (pendingUnderlying.size > 0)
          await Promise.allSettled([...pendingUnderlying]);
      })(),
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
    ]);
  };

  const cleanup = (): Promise<void> => {
    if (cleanupPromise !== undefined) return cleanupPromise;
    cleanupPromise = (async () => {
      await settlePending();
      try {
        await dependencies.intake.stopAccepting();
        let timeout: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            dependencies.intake.drain(),
            new Promise<void>((resolve) => {
              timeout = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
            }),
          ]);
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }
      } catch {
        logger.error(
          { event: 'shutdown.drain_failed', errorName: 'shutdown_failure' },
          'Intake drain failed; continuing cleanup',
        );
      }
      for (const step of [dependencies.scheduler, dependencies.voice]) {
        try {
          await step.stop();
        } catch {
          logger.error(
            { event: 'shutdown.step_failed', errorName: 'shutdown_failure' },
            'Shutdown step failed',
          );
        }
      }
      for (const value of clients) await destroyClient(value);
      for (const step of [...completed].reverse()) {
        try {
          await step.stop();
        } catch {
          logger.error(
            {
              event: 'shutdown.resource_failed',
              errorName: 'shutdown_failure',
            },
            'Resource shutdown failed',
          );
        }
      }
      while (lateCleanup.size > 0) await Promise.allSettled([...lateCleanup]);
      try {
        await dependencies.prisma.stop();
      } catch {
        logger.error(
          { event: 'shutdown.prisma_failed', errorName: 'shutdown_failure' },
          'Prisma shutdown failed',
        );
      }
      finalized = true;
      logger.info({ event: 'bootstrap.stopped' }, 'Bootstrap stopped');
    })();
    return cleanupPromise;
  };
  const registerClient = (value: DiscordClientLifecycle): void => {
    if (finalized) return;
    clients.add(value);
    if (cleanupPromise !== undefined) trackLateCleanup(destroyClient(value));
  };
  const observeLateStep = (
    step: LifecycleStep,
    operation: Promise<void>,
  ): void => {
    operation.then(
      () => {
        if (stopping || cleanupPromise !== undefined)
          trackLateCleanup(step.stop().catch(() => undefined));
      },
      () => undefined,
    );
  };

  const stop = (): Promise<void> => {
    if (stopPromise !== undefined) return stopPromise;
    stopping = true;
    startupAbort.abort();
    stopPromise = cleanup();
    return stopPromise;
  };
  const start = (): Promise<void> => {
    if (stopping) return Promise.reject(new StartupAbortedError());
    if (startPromise !== undefined) return startPromise;
    startPromise = (async () => {
      try {
        const isStopping = (): boolean => stopping;
        for (const key of STARTUP_ORDER) {
          if (isStopping()) throw new StartupAbortedError();
          const step = dependencies[key];
          const operation = trackUnderlying(step.start(startupAbort.signal));
          observeLateStep(step, operation);
          await abortable(operation, startupAbort.signal);
          completed.push(step);
        }
        if (isStopping()) throw new StartupAbortedError();
        const created = trackUnderlying(
          dependencies.createDiscordClient(startupAbort.signal),
        );
        created.then(registerClient, () => undefined);
        const value = await abortable(created, startupAbort.signal);
        registerClient(value);
        const login = trackUnderlying(value.login(startupAbort.signal));
        login.catch(() => undefined);
        try {
          await abortable(
            trackUnderlying(
              dependencies.recoverStaleJobs.start(startupAbort.signal),
            ),
            startupAbort.signal,
          );
        } catch (error: unknown) {
          startupAbort.abort();
          throw error;
        }
        await abortable(login, startupAbort.signal);
        await abortable(
          trackUnderlying(dependencies.scheduler.start(startupAbort.signal)),
          startupAbort.signal,
        );
        await abortable(
          trackUnderlying(dependencies.intake.start(startupAbort.signal)),
          startupAbort.signal,
        );
        logger.info({ event: 'bootstrap.started' }, 'Bootstrap started');
      } catch (error: unknown) {
        logger.error(
          { event: 'bootstrap.failed', errorName: 'startup_failure' },
          'Bootstrap failed',
        );
        startupAbort.abort();
        await cleanup();
        throw error;
      }
    })();
    return startPromise;
  };
  return { start, stop };
}
