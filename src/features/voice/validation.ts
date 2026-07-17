import { err, ok, type Result } from '../../domain/result.js';

const snowflake = /^\d{17,20}$/u;
export function parseVoiceTargets(
  targetId: string | null | undefined,
  additional: string | null | undefined,
): Result<readonly string[]> {
  const raw = [
    ...(targetId ? [targetId] : []),
    ...(additional ?? '').split(/[\s,]+/u).filter(Boolean),
  ];
  if (raw.length === 0)
    return err('INVALID_INPUT', '対象を1件以上指定してください');
  const ids = raw.map((value) => value.replace(/^<@!?|>$/gu, ''));
  if (ids.some((id) => !snowflake.test(id)))
    return err('INVALID_INPUT', '対象IDが不正です');
  const unique = [...new Set(ids)];
  if (unique.length > 20) return err('INVALID_INPUT', '対象は最大20件です');
  return ok(unique);
}
