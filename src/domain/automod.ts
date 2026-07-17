import { z } from 'zod';
import { err, ok } from './result.js';
import type { Result } from './result.js';

export const automodRuleSchema = z.object({
  rule: z.enum([
    'ANTI_INVITE',
    'ANTI_REFERRAL',
    'ANTI_EVERYONE',
    'ANTI_COPYPASTA',
    'MAX_USER_MENTIONS',
    'MAX_ROLE_MENTIONS',
    'MAX_LINES',
    'ANTI_DUPLICATE',
  ]),
  matched: z.boolean(),
  deleteMessage: z.boolean(),
  strikes: z.number().int().min(0),
  reason: z.string().min(1),
  evidence: z.unknown().optional(),
  warning: z.string().nullable().optional(),
});
export type AutomodRuleResult = z.infer<typeof automodRuleSchema>;
export function aggregateViolations(input: unknown): Result<{
  deleteMessage: boolean;
  strikes: number;
  reason: string;
  evidence: unknown[];
  rules: AutomodRuleResult[];
}> {
  const parsed = z.array(automodRuleSchema).safeParse(input);
  if (!parsed.success) return err('INVALID_INPUT', 'Invalid AutoMod result');
  const rules = parsed.data.filter((r) => r.matched);
  return ok({
    deleteMessage: rules.some((r) => r.deleteMessage),
    strikes: Math.min(
      100,
      rules.reduce((n, r) => n + r.strikes, 0),
    ),
    reason: rules.map((r) => r.reason).join('; '),
    evidence: rules.map((r) => r.evidence),
    rules,
  });
}

export function topicDisabledRules(topic: unknown): Result<Set<string>> {
  if (typeof topic !== 'string')
    return err('INVALID_INPUT', 'Invalid channel topic');
  const lower = topic.toLocaleLowerCase();
  const result = new Set<string>();
  if (lower.includes('{invites}')) result.add('ANTI_INVITE');
  if (lower.includes('{spam}'))
    for (const rule of [
      'ANTI_EVERYONE',
      'ANTI_COPYPASTA',
      'MAX_LINES',
      'ANTI_DUPLICATE',
    ])
      result.add(rule);
  return ok(result);
}

export const normalizeDuplicateContent = (input: unknown): Result<string> => {
  if (typeof input !== 'string')
    return err('INVALID_INPUT', 'Invalid duplicate content');
  return ok(
    input
      .normalize('NFKC')
      .replace(/[\u200B-\u200D\uFEFF]/gu, '')
      .replace(/\s+/gu, ' ')
      .trim()
      .toLocaleLowerCase(),
  );
};
export function duplicateOrdinal(input: unknown): Result<number> {
  const schema = z.object({
    previousContent: z.string().optional(),
    content: z.string(),
    previousAt: z.number().optional(),
    now: z.number(),
    previousOrdinal: z.number().int().positive().optional(),
  });
  const parsed = schema.safeParse(input);
  if (!parsed.success) return err('INVALID_INPUT', 'Invalid duplicate input');
  const current = normalizeDuplicateContent(parsed.data.content);
  if (!current.ok) return current;
  const previous =
    parsed.data.previousContent === undefined
      ? undefined
      : normalizeDuplicateContent(parsed.data.previousContent);
  if (
    current.value === '' ||
    previous === undefined ||
    !previous.ok ||
    previous.value !== current.value ||
    parsed.data.previousAt === undefined ||
    parsed.data.now - parsed.data.previousAt > 30_000 ||
    parsed.data.now < parsed.data.previousAt
  )
    return ok(1);
  return ok((parsed.data.previousOrdinal ?? 1) + 1);
}
export const duplicateActions = (
  ordinal: unknown,
  deleteThreshold: unknown,
  strikeThreshold: unknown,
): Result<{ deleteMessage: boolean; strikes: boolean }> => {
  const parsed = z
    .object({
      ordinal: z.number().int().positive(),
      deleteThreshold: z.number().int().min(2).max(20),
      strikeThreshold: z.number().int().min(2).max(20),
    })
    .safeParse({ ordinal, deleteThreshold, strikeThreshold });
  return parsed.success
    ? ok({
        deleteMessage: parsed.data.ordinal >= parsed.data.deleteThreshold,
        strikes: parsed.data.ordinal >= parsed.data.strikeThreshold,
      })
    : err('INVALID_INPUT', 'Invalid duplicate thresholds');
};
export const lineStrikeCount = (
  content: unknown,
  maximum: unknown,
): Result<number> => {
  const parsed = z
    .object({
      content: z.string(),
      maximum: z.number().int().positive().max(500),
    })
    .safeParse({ content, maximum });
  if (!parsed.success) return err('INVALID_INPUT', 'Invalid line input');
  const lines = parsed.data.content.split(/\r\n|\r|\n/u).length;
  return ok(
    lines > parsed.data.maximum
      ? Math.ceil((lines - parsed.data.maximum) / parsed.data.maximum)
      : 0,
  );
};
