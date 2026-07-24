import { err, ok, type Result } from '../../domain/result.js';
import {
  clampBulkTargetLimit,
  DEFAULT_BULK_TARGET_LIMIT,
} from '../../domain/parsers.js';

const snowflake = /^\d{17,20}$/u;
export function parseVoiceTargets(
  targetId: string | null | undefined,
  additional: string | null | undefined,
  max: number = DEFAULT_BULK_TARGET_LIMIT,
): Result<readonly string[]> {
  const extraText = additional ?? '';
  const extraTokens = extraText.split(/[\s,]+/u).filter(Boolean);
  // Static Discord/API-facing ceilings: `additional_targets` carries at most 19
  // tokens and 400 characters. These are independent of, and never weakened by,
  // the deployment-configurable bulk-target limit.
  if (extraText.length > 400 || extraTokens.length > 19)
    return err('INVALID_INPUT', '追加対象が不正です');
  const raw = [...(targetId ? [targetId] : []), ...extraTokens];
  if (raw.length === 0)
    return err('INVALID_INPUT', '対象を1件以上指定してください');
  const ids = raw.map((value) => value.replace(/^<@!?|>$/gu, ''));
  if (ids.some((id) => !snowflake.test(id)))
    return err('INVALID_INPUT', '対象IDが不正です');
  const unique = [...new Set(ids)];
  const limit = clampBulkTargetLimit(max);
  if (unique.length > limit)
    return err('INVALID_INPUT', `対象は最大${String(limit)}件です`);
  return ok(unique);
}
