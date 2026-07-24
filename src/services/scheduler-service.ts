import type {
  JobDto,
  ScheduledCaseCreationResult,
  ScheduledCaseTerminalizationInput,
  ScheduledActionInput,
  SchedulerRepository,
} from '../repositories/contracts.js';
import { ScheduledActionInputSchema } from '../repositories/contracts.js';
import { err, ok, type Result } from '../domain/result.js';
import { z } from 'zod';
import type { JobDispatcher } from '../runtime/scheduler.js';
import { WorkerIdSchema } from '../repositories/contracts.js';
export interface SchedulerServiceOptions {
  readonly workerId: string;
  readonly clock?: () => Date;
  readonly onFatal?: (error: unknown) => void;
}
const snowflake = z.string().regex(/^\d{17,20}$/u);
const CancellationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('UNBAN'),
    guildId: snowflake,
    targetUserId: snowflake,
    channelId: z.null(),
  }),
  z.object({
    type: z.literal('UNMUTE'),
    guildId: snowflake,
    targetUserId: snowflake,
    channelId: z.null(),
  }),
  z.object({
    type: z.literal('RESTORE_SLOWMODE'),
    guildId: snowflake,
    targetUserId: z.null(),
    channelId: snowflake,
  }),
  z.object({
    type: z.literal('DISABLE_RAIDMODE'),
    guildId: snowflake,
    targetUserId: z.null(),
    channelId: z.null(),
  }),
]);
export class SchedulerService {
  private readonly clock: () => Date;
  private readonly workerId: string;
  private readonly onFatal: ((error: unknown) => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  public constructor(
    private readonly repository: SchedulerRepository,
    options: SchedulerServiceOptions,
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.workerId = WorkerIdSchema.parse(options.workerId);
    this.onFatal = options.onFatal;
  }
  public async schedule(input: ScheduledActionInput): Promise<Result<JobDto>> {
    const parsed = ScheduledActionInputSchema.safeParse(input);
    if (!parsed.success)
      return err('INVALID_INPUT', 'Invalid scheduled action');
    return ok(await this.repository.scheduleReplacing(parsed.data));
  }
  public async cancel(
    input: Pick<
      ScheduledActionInput,
      'guildId' | 'targetUserId' | 'channelId' | 'type'
    >,
  ): Promise<Result<number>> {
    const parsed = CancellationSchema.safeParse(input);
    if (!parsed.success)
      return err('INVALID_INPUT', 'Invalid cancellation target');
    return ok(await this.repository.cancelTarget(input));
  }
  public async claimDue(
    limit = 50,
    supportedTypes?: readonly JobDto['type'][],
  ): Promise<Result<JobDto[]>> {
    if (!Number.isInteger(limit) || limit < 1)
      return err('INVALID_INPUT', 'Invalid scheduler limit');
    return ok(
      await this.repository.claimDue(
        Math.min(50, Math.max(1, limit)),
        this.workerId,
        this.clock(),
        supportedTypes,
      ),
    );
  }
  public async complete(id: string): Promise<Result<boolean>> {
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) return err('INVALID_INPUT', 'Invalid job ID');
    return ok(await this.repository.complete(id, this.workerId));
  }
  public async createScheduledCase(
    jobId: string,
    fallbackModeratorUserId: string,
  ): Promise<Result<ScheduledCaseCreationResult>> {
    const parsedId = z.uuid().safeParse(jobId);
    const parsedModerator = snowflake.safeParse(fallbackModeratorUserId);
    if (!parsedId.success || !parsedModerator.success)
      return err('INVALID_INPUT', 'Invalid scheduled case identity');
    return ok(
      await this.repository.createScheduledCase(
        jobId,
        this.workerId,
        fallbackModeratorUserId,
      ),
    );
  }
  public async terminalizeScheduledCase(
    input: Omit<ScheduledCaseTerminalizationInput, 'workerId'>,
  ): Promise<Result<boolean>> {
    const parsed = z
      .object({
        jobId: z.uuid(),
        executedCaseId: z.uuid(),
        status: z.enum(['COMPLETED', 'FAILED']),
        errorCode: z.string().max(64).nullish(),
      })
      .safeParse(input);
    if (!parsed.success) return err('INVALID_INPUT', 'Invalid terminalization');
    return ok(
      await this.repository.terminalizeScheduledCase({
        ...parsed.data,
        workerId: this.workerId,
      }),
    );
  }
  private fail(
    id: string,
    error: string,
    retryable: boolean,
  ): Promise<boolean> {
    return this.repository.fail(id, this.workerId, error, retryable);
  }
  public recoverStale(): Promise<number> {
    return this.repository.recoverStale(this.clock());
  }
  public classify(
    error: unknown,
  ): 'IDEMPOTENT_SUCCESS' | 'FAILED' | 'RETRYABLE' | 'FATAL' {
    const source =
      error instanceof Error && 'cause' in error
        ? (error as Error & { cause?: unknown }).cause
        : error;
    const status =
      typeof source === 'object' && source !== null && 'status' in source
        ? (source as { status?: number }).status
        : undefined;
    const code =
      typeof source === 'object' && source !== null && 'code' in source
        ? (source as { code?: unknown }).code
        : undefined;
    if (code === 'NOT_APPLIED' || code === 'ALREADY_APPLIED')
      return 'IDEMPOTENT_SUCCESS';
    if (status === 404) return 'IDEMPOTENT_SUCCESS';
    // A direct or cause-wrapped `status === 401` OR `code === 401` is a fatal
    // Discord authentication failure, not a retryable job outcome.
    if (status === 401 || code === 401) return 'FATAL';
    if (status === 403 || status === 400 || status === 429) return 'FAILED';
    if (status === undefined || status >= 500) return 'RETRYABLE';
    return 'FAILED';
  }
  public async dispatchDue(
    dispatcher: JobDispatcher,
    limit = 50,
  ): Promise<void> {
    const claimed = await this.claimDue(limit, dispatcher.supportedTypes);
    if (!claimed.ok) return;
    const jobs = claimed.value;
    for (const job of jobs) {
      if (!dispatcher.supports(job)) {
        await this.fail(job.id, 'Unsupported scheduled action', false);
        continue;
      }
      try {
        await dispatcher.dispatch(job);
        const completed = await this.complete(job.id);
        if (!completed.ok) continue;
      } catch (error: unknown) {
        const classification = this.classify(error);
        if (classification === 'FATAL') {
          // A direct/cause-wrapped status OR code 401 is fatal: escalate to the
          // runtime shutdown handler and abandon the job WITHOUT fail/requeue
          // bookkeeping, so an auth failure is never mistaken for retryable work.
          this.onFatal?.(error);
          throw error;
        }
        if (classification === 'IDEMPOTENT_SUCCESS')
          await this.complete(job.id);
        else
          await this.fail(
            job.id,
            error instanceof Error ? error.message : 'scheduled action failed',
            classification === 'RETRYABLE',
          );
      }
    }
  }
  public async start(
    dispatcher: JobDispatcher,
    intervalMs = 5_000,
  ): Promise<void> {
    await this.dispatchDue(dispatcher);
    // Serialize interval polls: skip a tick whose predecessor is still
    // dispatching so a slow database cannot overlap concurrent claim cycles.
    let dispatching = false;
    this.timer = setInterval(() => {
      if (dispatching) return;
      dispatching = true;
      void this.dispatchDue(dispatcher).finally(() => {
        dispatching = false;
      });
    }, intervalMs);
  }
  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
