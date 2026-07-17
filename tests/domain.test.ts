import { describe, expect, it } from 'vitest';
import {
  aggregateViolations,
  duplicateOrdinal,
  parseDuration,
  parseTargets,
  selectPunishment,
  splitEmbedFields,
  topicDisabledRules,
  raidWindowCount,
  auditReason,
  canManageMember,
} from '../src/domain/index.js';

describe('shared domain', () => {
  it('parses strict durations and targets', () => {
    expect(parseDuration('1h30m')).toMatchObject({ ok: true, value: 5400 });
    expect(parseDuration('1 month')).toMatchObject({ ok: false });
    expect(
      parseTargets(
        '12345678901234567',
        '<@!12345678901234568> 12345678901234567',
      ),
    ).toMatchObject({
      ok: true,
      value: ['12345678901234567', '12345678901234568'],
    });
    expect(
      parseTargets(
        '12345678901234567',
        Array.from({ length: 20 }, () => '12345678901234568').join(' '),
      ),
    ).toMatchObject({ ok: false });
    expect(
      auditReason(1, 'ok\u0000\n😀'.replace('\\u0000', '\u0000')),
    ).toMatchObject({ ok: true, value: '[Pathtex Case #1] ok 😀' });
  });
  it('selects only the greatest crossed punishment', () => {
    expect(
      selectPunishment({
        before: 1,
        after: 5,
        punishments: [
          { threshold: 2, action: 'MUTE' },
          { threshold: 5, action: 'BAN' },
        ],
      }),
    ).toMatchObject({ ok: true, value: { threshold: 5 } });
  });
  it('aggregates violations once and respects topic switches', () => {
    expect(
      aggregateViolations([
        {
          rule: 'ANTI_INVITE',
          matched: true,
          deleteMessage: true,
          strikes: 80,
          reason: 'A',
        },
        {
          rule: 'MAX_LINES',
          matched: true,
          deleteMessage: false,
          strikes: 40,
          reason: 'B',
        },
      ]),
    ).toMatchObject({
      value: { strikes: 100, deleteMessage: true, reason: 'A; B' },
    });
    expect(topicDisabledRules('Rules {SPAM}')).toMatchObject({
      value: new Set([
        'ANTI_EVERYONE',
        'ANTI_COPYPASTA',
        'MAX_LINES',
        'ANTI_DUPLICATE',
      ]),
    });
  });
  it('uses sliding raid windows, duplicate windows, and embed limits', () => {
    expect(
      raidWindowCount({
        timestamps: [0, 9_000, 10_001],
        now: 10_000,
        windowSeconds: 10,
      }),
    ).toMatchObject({ ok: true, value: 2 });
    expect(
      duplicateOrdinal({
        content: ' Hello ',
        previousContent: 'hello',
        previousAt: 1_000,
        now: 2_000,
        previousOrdinal: 2,
      }),
    ).toMatchObject({ ok: true, value: 3 });
    const split = splitEmbedFields(
      Array.from({ length: 26 }, (_, i) => ({ name: String(i), value: 'x' })),
    );
    expect(split.ok).toBe(true);
    if (split.ok) expect(split.value).toHaveLength(2);
    expect(
      splitEmbedFields([{ name: 'x'.repeat(257), value: 'x' }]),
    ).toMatchObject({ ok: false });
  });

  it('handles hierarchy ties, application bot protection, and strike owner exception', () => {
    const base = {
      actorId: '12345678901234567',
      targetId: '12345678901234568',
      botId: '12345678901234569',
      botTopRole: 5,
      targetTopRole: 5,
      actorTopRole: 6,
      botTopRoleId: '12345678901234570',
      targetTopRoleId: '12345678901234569',
      actorTopRoleId: '12345678901234571',
      owner: false,
      targetOwner: false,
    };
    expect(canManageMember({ ...base, targetBot: true })).toMatchObject({
      ok: true,
      value: true,
    });
    expect(
      canManageMember({ ...base, targetId: base.botId, targetBot: true }),
    ).toMatchObject({ ok: true, value: false });
    expect(
      canManageMember({ ...base, targetOwner: true, action: 'STRIKE' }),
    ).toMatchObject({ ok: true, value: true });
  });
});
