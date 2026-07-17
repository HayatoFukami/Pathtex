import { z } from 'zod';
import { err, ok, type Result } from '../../domain/result.js';
import {
  parseDuration,
  parseReason,
  parseTargets,
} from '../../domain/parsers.js';

export const ModerationInputSchema = z.object({
  guildId: z.string().regex(/^\d{17,20}$/u),
  actorId: z.string().regex(/^\d{17,20}$/u),
});

export const resolveTargets = (target: unknown, additional: unknown) =>
  parseTargets(target, additional, 20);
export const resolveUserIds = (value: unknown): Result<string[]> => {
  if (typeof value !== 'string' || value.length > 400)
    return err('INVALID_INPUT', 'Invalid user IDs');
  const values = value.split(/[\s,]+/u).filter(Boolean);
  if (
    values.length === 0 ||
    values.length > 20 ||
    values.some((id) => !/^\d{17,20}$/u.test(id))
  )
    return err('INVALID_INPUT', 'Invalid user IDs');
  return ok([...new Set(values)]);
};
export const resolveReason = (value: unknown, required = false) =>
  parseReason(value, required);
export const resolveDuration = (value: unknown, max: number) =>
  parseDuration(value, max);

export function validateDeleteDays(
  value: unknown,
  fallback = 7,
): Result<number> {
  const days = value === undefined ? fallback : value;
  return typeof days === 'number' &&
    Number.isInteger(days) &&
    days >= 0 &&
    days <= 7
    ? ok(days)
    : err('INVALID_INPUT', 'delete_messages must be between 0 and 7');
}

export function validateSlowmode(value: unknown): Result<number> {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 21600
    ? ok(value)
    : err('INVALID_INPUT', 'interval must be between 0 and 21600');
}
