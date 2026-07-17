export interface DiscordRequestError extends Error {
  readonly status?: number;
  readonly code?: string | number;
  readonly retryable?: boolean;
}
export interface DiscordRetryPort<T> {
  request(): Promise<T>;
}
export interface DiscordRetryOptions {
  readonly delaysMs?: readonly number[];
  readonly sleep?: (ms: number) => Promise<void>;
}
export class DiscordRetryError extends Error {
  public readonly status: number | undefined;
  public constructor(
    message: string,
    public override readonly cause: unknown,
  ) {
    super(message);
    this.name = 'DiscordRetryError';
    this.status =
      typeof cause === 'object' && cause !== null && 'status' in cause
        ? (cause as { status?: number }).status
        : undefined;
  }
}
export async function withDiscordRetry<T>(
  request: () => Promise<T>,
  options: DiscordRetryOptions = {},
): Promise<T> {
  const delays = options.delaysMs ?? [1000, 2000, 4000];
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request();
    } catch (error: unknown) {
      const status =
        typeof error === 'object' && error !== null && 'status' in error
          ? (error as { status?: number }).status
          : undefined;
      // discord.js already owns rate-limit scheduling. A service must never
      // create a second, competing 429 retry loop.
      if (
        status === 401 ||
        status === 400 ||
        status === 403 ||
        status === 429 ||
        (status !== undefined && status < 500)
      )
        throw new DiscordRetryError('Discord request failed', error);
      if (attempt >= delays.length)
        throw new DiscordRetryError(
          'Discord request failed after retries',
          error,
        );
      await sleep(delays[attempt] ?? 0);
    }
  }
}
