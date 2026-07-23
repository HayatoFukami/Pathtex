import { z } from 'zod';
import { err, ok } from './result.js';
import type { Result } from './result.js';

/** Maximum configurable MUTE duration: 28 days. Mirrors the
 * `punishments_mute_max_28_days` database check constraint. */
export const MUTE_MAX_DURATION_SECONDS = 2_419_200;
/** Maximum configurable BAN duration: 365 days. Mirrors the
 * `punishments_duration_valid` database check constraint. */
export const BAN_MAX_DURATION_SECONDS = 31_536_000;

/**
 * Configuration-time validity of an action/duration pair. Returns an error
 * message when the combination is impossible, or `null` when it is valid.
 * KICK and SOFTBAN are instantaneous and never accept a duration; MUTE is
 * capped at 28 days; BAN at 365 days. The domain schema, the public
 * configuration service, and the persistence write boundary all share this
 * single policy so they reject exactly the same newly saved rules. Existing
 * persisted rows are never clamped or reinterpreted here.
 */
export function punishmentDurationError(
  action: 'MUTE' | 'KICK' | 'SOFTBAN' | 'BAN',
  durationSeconds: number | null | undefined,
): string | null {
  if (durationSeconds === null || durationSeconds === undefined) return null;
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1)
    return 'Invalid duration';
  if (action === 'KICK' || action === 'SOFTBAN')
    return 'Duration is not allowed for this action';
  if (action === 'MUTE' && durationSeconds > MUTE_MAX_DURATION_SECONDS)
    return 'Mute duration exceeds 28 days';
  if (action === 'BAN' && durationSeconds > BAN_MAX_DURATION_SECONDS)
    return 'Ban duration exceeds 365 days';
  return null;
}

export const punishmentSchema = z
  .object({
    threshold: z.number().int().min(1).max(1_000_000),
    action: z.enum(['MUTE', 'KICK', 'SOFTBAN', 'BAN']),
    durationSeconds: z
      .number()
      .int()
      .min(1)
      .max(BAN_MAX_DURATION_SECONDS)
      .optional(),
  })
  .superRefine((punishment, context) => {
    const message = punishmentDurationError(
      punishment.action,
      punishment.durationSeconds,
    );
    if (message)
      context.addIssue({
        code: 'custom',
        path: ['durationSeconds'],
        message,
      });
  });
export type Punishment = z.infer<typeof punishmentSchema>;
export function selectPunishment(
  input: unknown,
): Result<Punishment | undefined> {
  const schema = z.object({
    before: z.number().int().min(0).max(1_000_000),
    after: z.number().int().min(0).max(1_000_000),
    punishments: z.array(punishmentSchema),
  });
  const parsed = schema.safeParse(input);
  if (!parsed.success || parsed.data.after < parsed.data.before)
    return err('INVALID_INPUT', 'Invalid strike range');
  const candidate = parsed.data.punishments
    .filter(
      (p) =>
        parsed.data.before < p.threshold && p.threshold <= parsed.data.after,
    )
    .sort((a, b) => b.threshold - a.threshold)[0];
  return ok(candidate);
}
