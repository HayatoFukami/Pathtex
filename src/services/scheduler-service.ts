import type {
  JobDto,
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
    if (status === 401) return 'FATAL';
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
        if (this.status(error) === 401) {
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
  private status(error: unknown): number | undefined {
    const source =
      error instanceof Error && 'cause' in error
        ? (error as Error & { cause?: unknown }).cause
        : error;
    return typeof source === 'object' && source !== null && 'status' in source
      ? (source as { status?: number }).status
      : undefined;
  }
  public async start(
    dispatcher: JobDispatcher,
    intervalMs = 5_000,
  ): Promise<void> {
    await this.dispatchDue(dispatcher);
    this.timer = setInterval(() => {
      void this.dispatchDue(dispatcher);
    }, intervalMs);
  }
  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
