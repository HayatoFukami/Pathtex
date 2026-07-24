import type { RetentionRepository } from '../repositories/contracts.js';
import { err, ok, type Result } from '../domain/result.js';
import type { Logger } from 'pino';

/** Aggregate count of rows purged by a full retention sweep. */
export interface RetentionCleanupResult {
  readonly snapshots: number;
  readonly raidEvents: number;
  readonly scheduledActions: number;
}

export interface RetentionServiceOptions {
  /** Optional sink for per-purge failure diagnostics (sweep observability). */
  readonly logger?: Logger;
}

function validCleanupTime(now?: Date): boolean {
  return (
    now === undefined || (now instanceof Date && !Number.isNaN(now.valueOf()))
  );
}

/** Extracts a fulfilled purge count; a rejected purge contributes zero so one
 * failure cannot mask the others' results. */
function settledCount(result: PromiseSettledResult<number>): number {
  return result.status === 'fulfilled' ? result.value : 0;
}

/** Data-retention cleanup surface (spec `01-platform-and-data.md §4.17`).
 *
 * Wraps the `RetentionRepository` so the periodic purge of expired message
 * snapshots, stale raid join events, and terminal scheduled actions is callable
 * through a service contract rather than only through the raw repository. The
 * retention periods themselves are enforced by the repository (snapshot
 * `expires_at`, the 5-minute raid-event window, and the 30/90-day scheduled
 * action windows); this service validates the optional reference time and
 * delegates. Wiring this into a scheduler/job is intentionally done elsewhere. */
export class RetentionService {
  private readonly logger: Logger | undefined;
  public constructor(
    private readonly repository: RetentionRepository,
    options: RetentionServiceOptions = {},
  ) {
    this.logger = options.logger;
  }

  public async cleanupExpiredSnapshots(now?: Date): Promise<Result<number>> {
    if (!validCleanupTime(now))
      return err('INVALID_INPUT', 'Invalid cleanup time');
    return ok(await this.repository.deleteExpiredSnapshots(now));
  }

  public async cleanupOldRaidEvents(now?: Date): Promise<Result<number>> {
    if (!validCleanupTime(now))
      return err('INVALID_INPUT', 'Invalid cleanup time');
    return ok(await this.repository.deleteOldRaidEvents(now));
  }

  public async cleanupOldScheduledActions(now?: Date): Promise<Result<number>> {
    if (!validCleanupTime(now))
      return err('INVALID_INPUT', 'Invalid cleanup time');
    return ok(await this.repository.deleteOldScheduledActions(now));
  }

  /** Runs every retention purge independently; one failing purge does not
   * prevent the others from running. The reference time is validated once. */
  public async runAll(now?: Date): Promise<Result<RetentionCleanupResult>> {
    if (!validCleanupTime(now))
      return err('INVALID_INPUT', 'Invalid cleanup time');
    // allSettled (not all): a rejecting purge must neither abort nor hide the
    // others (spec §4.17). Each failure is logged for observability and counted
    // as zero, so the aggregate Result stays compatible with the sweep cadence.
    const [snapshots, raidEvents, scheduledActions] = await Promise.allSettled([
      this.repository.deleteExpiredSnapshots(now),
      this.repository.deleteOldRaidEvents(now),
      this.repository.deleteOldScheduledActions(now),
    ]);
    for (const [target, result] of [
      ['snapshots', snapshots],
      ['raidEvents', raidEvents],
      ['scheduledActions', scheduledActions],
    ] as const) {
      if (result.status === 'rejected')
        this.logger?.warn(
          {
            event: 'retention.purge_failed',
            target,
            errorName:
              result.reason instanceof Error ? result.reason.name : 'unknown',
          },
          'Retention purge failed',
        );
    }
    return ok({
      snapshots: settledCount(snapshots),
      raidEvents: settledCount(raidEvents),
      scheduledActions: settledCount(scheduledActions),
    });
  }
}
