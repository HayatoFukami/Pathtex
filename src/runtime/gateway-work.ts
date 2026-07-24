/** Raised when the gateway work tracker sheds a task because both its
 * concurrency slots and its bounded queue are full. This is deliberate
 * backpressure: under a runaway event burst the bot drops the newest
 * *non-critical* work instead of growing memory without bound. Callers log it
 * and continue. Critical state transitions (see `runCritical`) are never shed
 * with this error. */
export class GatewayOverloadedError extends Error {
  public constructor() {
    super('gateway work tracker is saturated');
    this.name = 'GatewayOverloadedError';
  }
}

export interface GatewayWorkOptions {
  /** Maximum operations executing at once. Defaults to 32. */
  readonly maxConcurrency?: number;
  /** Maximum *non-critical* operations waiting for a slot before new non-critical
   * work is shed. Defaults to 1024. Critical work (`runCritical`) is always
   * queued and does not count against this bound. */
  readonly maxQueued?: number;
}

/** Bounded global tracker for gateway-originated async work.
 *
 * Gateway event handlers are synchronous callbacks that kick off async work
 * (logging, case creation, moderation restores). Left untracked, that work is
 * unbounded and can still be in flight when the runtime disconnects Prisma on
 * shutdown, causing queries to fail mid-flight. This tracker:
 *
 * - bounds concurrency (`maxConcurrency`) and queues overflow up to `maxQueued`,
 *   shedding the newest *non-critical* task with `GatewayOverloadedError` beyond
 *   that (backpressure);
 * - keeps every in-flight task in a set so `drain()` can wait for all of it to
 *   settle, bounded by a timeout so shutdown never hangs.
 *
 * ## Admission, queueing, and capacity
 *
 * `run(operation)` admits a non-critical task. When fewer than `maxConcurrency`
 * tasks are active it starts immediately; otherwise it waits in a FIFO queue.
 * Once the queue holds `maxQueued` waiting tasks, further non-critical tasks are
 * rejected synchronously-scheduled with `GatewayOverloadedError` (the newest
 * work is shed). This is the backpressure valve for high-volume, droppable work
 * such as message logging.
 *
 * `runCritical(operation)` admits a *critical state transition* — work whose
 * loss would let the bot's state diverge from Discord (mute restoration, raid
 * detection, external case creation, lifecycle markers, voice-session tracking,
 * channel/guild state). Critical tasks obey the same `maxConcurrency` bound but
 * are **never shed**: when the concurrency slots are full they queue without
 * counting against `maxQueued`, so an accepted critical transition is always
 * eventually executed rather than silently dropped under overload.
 *
 * ## Drain
 *
 * `drain()` waits for every active and queued task (critical or not) to settle,
 * bounded by `timeoutMs` so a stuck dependency cannot block shutdown
 * indefinitely. Because queued tasks are tracked from the moment they are
 * admitted, `drain()` observes them too. The lifecycle calls `drain()` after
 * intake admission is closed and drained, and before voice/client/DB teardown,
 * so in-flight work finishes its Discord I/O and database writes while those
 * resources are still alive.
 *
 * The tracker is failure-agnostic: a rejected task is still tracked and removed
 * on settlement; error classification (fatal 401 vs. routine) stays with the
 * caller's `report` helper. */
export class GatewayWorkTracker {
  private readonly maxConcurrency: number;
  private readonly maxQueued: number;
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly inflight = new Set<Promise<void>>();

  public constructor(options: GatewayWorkOptions = {}) {
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 32);
    this.maxQueued = Math.max(0, options.maxQueued ?? 1024);
  }

  /** Number of operations currently executing or queued. */
  public get pending(): number {
    return this.inflight.size;
  }

  /** Number of operations waiting for a concurrency slot. */
  public get queued(): number {
    return this.queue.length;
  }

  /** Runs a non-critical `operation` under the concurrency bound.
   * Resolves/rejects with the operation's outcome, or rejects
   * synchronously-scheduled with `GatewayOverloadedError` when both the
   * concurrency slots and the bounded queue are full (backpressure shed). The
   * task is tracked until it settles regardless of outcome. */
  public run(operation: () => Promise<void>): Promise<void> {
    return this.submit(operation, false);
  }

  /** Runs a *critical state transition* under the concurrency bound. Behaves
   * like `run` except it is never shed: when the concurrency slots are full it
   * queues without counting against `maxQueued`, so the transition is preserved
   * under overload instead of being silently dropped. */
  public runCritical(operation: () => Promise<void>): Promise<void> {
    return this.submit(operation, true);
  }

  private submit(
    operation: () => Promise<void>,
    critical: boolean,
  ): Promise<void> {
    const task = new Promise<void>((resolve, reject) => {
      const start = (): void => {
        this.active += 1;
        let outcome: Promise<void>;
        try {
          outcome = operation();
        } catch (error) {
          this.release();
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        outcome.then(
          () => {
            this.release();
            resolve();
          },
          (error: unknown) => {
            this.release();
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      };
      if (this.active < this.maxConcurrency) start();
      else if (critical || this.queue.length < this.maxQueued)
        this.queue.push(start);
      else reject(new GatewayOverloadedError());
    });
    // Track a never-rejecting mirror so an unhandled rejection in the caller's
    // chain cannot leak, and so `drain` observes the task to completion.
    const tracked = task.then(
      () => undefined,
      () => undefined,
    );
    this.inflight.add(tracked);
    void tracked.finally(() => this.inflight.delete(tracked));
    return task;
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next !== undefined) next();
  }

  /** Waits for every in-flight and queued task (critical or not) to settle,
   * bounded by `timeoutMs` so a stuck dependency cannot block shutdown
   * indefinitely. */
  public async drain(timeoutMs = 15_000): Promise<void> {
    if (this.inflight.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        (async () => {
          while (this.inflight.size > 0)
            await Promise.allSettled([...this.inflight]);
        })(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
