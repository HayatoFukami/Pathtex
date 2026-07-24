import { z } from 'zod';
import { err, ok } from './result.js';
import type { Result } from './result.js';
import { t } from '../i18n/index.js';

export const snowflakeSchema = z.string().regex(/^\d{17,20}$/);
export type Snowflake = z.infer<typeof snowflakeSchema>;
export const parseSnowflake = (value: unknown): Result<Snowflake> => {
  const parsed = snowflakeSchema.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err('INVALID_INPUT', 'Invalid Discord Snowflake');
};

/** Default and absolute ceiling for multi-user ("bulk") command targets. The
 * deployment-configurable limit (`MAX_BULK_TARGETS`) may lower this but never
 * raise it, so the static Discord/API-facing cap of 20 is always preserved. */
export const DEFAULT_BULK_TARGET_LIMIT = 20;
export const MAX_BULK_TARGET_LIMIT = 20;
/** Normalizes an injected bulk-target limit to a safe integer in `[1, 20]`,
 * falling back to the default for `undefined`/non-integer input so a missing or
 * malformed configuration can never weaken the static ceiling. */
export function clampBulkTargetLimit(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value))
    return DEFAULT_BULK_TARGET_LIMIT;
  return Math.min(Math.max(value, 1), MAX_BULK_TARGET_LIMIT);
}

const token = z.string().trim().min(1);
export function parseTargets(
  target: unknown,
  additional: unknown,
  max: number = DEFAULT_BULK_TARGET_LIMIT,
): Result<Snowflake[]> {
  const primary = target === undefined || target === null ? [] : [target];
  const extra =
    additional === undefined || additional === null
      ? []
      : typeof additional === 'string'
        ? additional.split(/[\s,]+/u).filter(Boolean)
        : null;
  if (
    extra === null ||
    (typeof additional === 'string' &&
      (additional.length > 400 || extra.length > 19))
  )
    return err('INVALID_INPUT', 'Invalid additional targets');
  const values = [...primary, ...extra];
  if (values.length === 0)
    return err('INVALID_INPUT', 'At least one target is required');
  const result: Snowflake[] = [];
  for (const value of values) {
    if (typeof value !== 'string')
      return err('INVALID_INPUT', 'Invalid target');
    const normalized = value.replace(/^<@!?([^>]+)>$/u, '$1');
    if (!snowflakeSchema.safeParse(normalized).success)
      return err('INVALID_INPUT', 'Invalid target Snowflake');
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result.length <= clampBulkTargetLimit(max)
    ? ok(result)
    : err('INVALID_INPUT', 'Too many targets');
}

const units = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 } as const;
export function parseDuration(
  value: unknown,
  maxSeconds?: number,
): Result<number> {
  if (!token.safeParse(value).success)
    return err('INVALID_INPUT', 'Invalid duration');
  const text = (value as string).trim().toLowerCase();
  const parts: { amount: number; unit: keyof typeof units }[] = [];
  if (/\s/u.test(text)) {
    const match = [
      ...text.matchAll(/(\d+)\s*(seconds?|minutes?|hours?|days?|weeks?)/giu),
    ];
    if (
      match.length === 0 ||
      match
        .map((m) => m[0])
        .join('')
        .replace(/\s/gu, '') !== text.replace(/\s/gu, '')
    )
      return err('INVALID_INPUT', 'Invalid duration');
    const map = {
      second: 's',
      seconds: 's',
      minute: 'm',
      minutes: 'm',
      hour: 'h',
      hours: 'h',
      day: 'd',
      days: 'd',
      week: 'w',
      weeks: 'w',
    } as const;
    for (const matchItem of match) {
      const rawUnit = matchItem[2];
      if (rawUnit === undefined)
        return err('INVALID_INPUT', 'Invalid duration');
      const unit = map[rawUnit.toLowerCase() as keyof typeof map];
      parts.push({ amount: Number(matchItem[1]), unit });
    }
  } else {
    let consumed = '';
    for (const match of text.matchAll(/(\d+)(s|m|h|d|w)/giu)) {
      consumed += match[0];
      const amount = match[1];
      const unit = match[2];
      if (amount === undefined || unit === undefined)
        return err('INVALID_INPUT', 'Invalid duration');
      parts.push({
        amount: Number(amount),
        unit: unit.toLowerCase() as keyof typeof units,
      });
    }
    if (consumed !== text) return err('INVALID_INPUT', 'Invalid duration');
  }
  if (
    parts.some(
      (part) => !Number.isSafeInteger(part.amount) || part.amount <= 0,
    ) ||
    new Set(parts.map((p) => p.unit)).size !== parts.length
  )
    return err('INVALID_INPUT', 'Invalid duration');
  const seconds = parts.reduce(
    (sum, part) => sum + part.amount * units[part.unit],
    0,
  );
  return Number.isSafeInteger(seconds) &&
    seconds > 0 &&
    (maxSeconds === undefined || seconds <= maxSeconds)
    ? ok(seconds)
    : err('INVALID_INPUT', 'Duration is out of range');
}

export function parseReason(value: unknown, required = false): Result<string> {
  if (value === undefined || value === null)
    return required
      ? err('INVALID_INPUT', 'Reason is required')
      : ok(t('moderation:defaultReason'));
  if (typeof value !== 'string') return err('INVALID_INPUT', 'Invalid reason');
  const reason = value.trim();
  if (reason.length === 0 || Array.from(reason).length > 1000)
    return err('INVALID_INPUT', 'Invalid reason');
  return ok(reason);
}

export function auditReason(
  caseNumber: number,
  reason: string,
): Result<string> {
  const parsed = z
    .object({ caseNumber: z.number().int().positive(), reason: z.string() })
    .safeParse({ caseNumber, reason });
  if (!parsed.success) return err('INVALID_INPUT', 'Invalid audit reason');
  const sanitized = Array.from(reason)
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
        ? ' '
        : character;
    })
    .join('')
    .replace(/\s+/gu, ' ');
  return ok(
    Array.from(`[Pathtex Case #${String(caseNumber)}] ${sanitized}`)
      .slice(0, 512)
      .join(''),
  );
}
