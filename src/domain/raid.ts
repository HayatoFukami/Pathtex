import { z } from 'zod';
import { err, ok } from './result.js';
import type { Result } from './result.js';
export function raidWindowCount(input: unknown): Result<number> {
  const parsed = z
    .object({
      timestamps: z.array(z.number()),
      now: z.number(),
      windowSeconds: z.number().int().min(2).max(300),
    })
    .safeParse(input);
  if (!parsed.success) return err('INVALID_INPUT', 'Invalid raid window');
  return ok(
    parsed.data.timestamps.filter(
      (time) =>
        time >= parsed.data.now - parsed.data.windowSeconds * 1000 &&
        time <= parsed.data.now,
    ).length,
  );
}
export const shouldActivateRaid = (
  count: unknown,
  threshold: unknown,
): Result<boolean> => {
  const parsed = z
    .object({
      count: z.number().int().nonnegative(),
      threshold: z.number().int().min(3).max(100),
    })
    .safeParse({ count, threshold });
  return parsed.success
    ? ok(parsed.data.count >= parsed.data.threshold)
    : err('INVALID_INPUT', 'Invalid raid threshold');
};
export const raidDisableAt = (lastJoin: unknown): Result<number> =>
  typeof lastJoin === 'number' && Number.isFinite(lastJoin)
    ? ok(lastJoin + 120_000)
    : err('INVALID_INPUT', 'Invalid raid timestamp');
