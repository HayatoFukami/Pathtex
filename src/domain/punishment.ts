import { z } from 'zod';
import { err, ok } from './result.js';
import type { Result } from './result.js';
export const punishmentSchema = z
  .object({
    threshold: z.number().int().min(1).max(1_000_000),
    action: z.enum(['MUTE', 'KICK', 'SOFTBAN', 'BAN']),
    durationSeconds: z.number().int().min(1).max(31_536_000).optional(),
  })
  .superRefine((punishment, context) => {
    if (
      (punishment.action === 'KICK' || punishment.action === 'SOFTBAN') &&
      punishment.durationSeconds !== undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['durationSeconds'],
        message: 'Duration is not allowed for this action',
      });
    }
    if (
      punishment.action === 'MUTE' &&
      punishment.durationSeconds !== undefined &&
      punishment.durationSeconds > 2_419_200
    ) {
      context.addIssue({
        code: 'custom',
        path: ['durationSeconds'],
        message: 'Mute duration exceeds 28 days',
      });
    }
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
