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

describe('canManageMember authorization policy', () => {
  const base = {
    actorId: '200000000000000001',
    targetId: '200000000000000002',
    botId: '200000000000000003',
    botTopRole: 10,
    targetTopRole: 5,
    actorTopRole: 8,
    botTopRoleId: '200000000000000010',
    targetTopRoleId: '200000000000000011',
    actorTopRoleId: '200000000000000012',
    owner: false,
    targetOwner: false,
  };
  const allows = (input: unknown): void => {
    expect(canManageMember(input)).toMatchObject({ ok: true, value: true });
  };
  const denies = (input: unknown): void => {
    expect(canManageMember(input)).toMatchObject({ ok: true, value: false });
  };

  it('manages a non-managed target outranked by bot and actor', () => {
    allows(base);
    allows({ ...base, targetTopRoleManaged: false });
  });

  it('blocks every action when the target top role is managed', () => {
    denies({ ...base, targetTopRoleManaged: true });
    denies({ ...base, targetTopRoleManaged: true, action: 'STRIKE' });
    denies({ ...base, targetTopRoleManaged: true, action: 'PARDON' });
  });

  it('does not exempt the managed-role guard for owner actors', () => {
    denies({ ...base, targetTopRoleManaged: true, owner: true });
    denies({
      ...base,
      targetTopRoleManaged: true,
      owner: true,
      action: 'STRIKE',
    });
  });

  it('keeps self, application-bot, and owner-target protections', () => {
    denies({ ...base, targetId: base.actorId });
    denies({ ...base, targetId: base.botId, targetBot: true });
    denies({ ...base, targetOwner: true });
    allows({ ...base, targetOwner: true, action: 'STRIKE' });
    allows({ ...base, targetOwner: true, action: 'PARDON' });
  });

  it('allows moderating other bots when hierarchy is satisfied', () => {
    allows({ ...base, targetBot: true });
  });

  it('requires the bot to outrank the target even for owners and strikes', () => {
    denies({ ...base, botTopRole: 3 });
    denies({ ...base, botTopRole: 3, owner: true });
    denies({ ...base, botTopRole: 3, action: 'STRIKE' });
  });

  it('exempts only owner actors from the actor-side hierarchy check', () => {
    denies({ ...base, actorTopRole: 3 });
    allows({ ...base, actorTopRole: 3, owner: true });
    allows({ ...base, actorTopRole: 3, action: 'STRIKE' });
    allows({ ...base, actorTopRole: 3, action: 'PARDON' });
  });

  it('breaks role-position ties by role id', () => {
    const tied = { ...base, botTopRole: 5, targetTopRole: 5, actorTopRole: 5 };
    allows({
      ...tied,
      botTopRoleId: '200000000000000099',
      targetTopRoleId: '200000000000000011',
      actorTopRoleId: '200000000000000098',
    });
    denies({
      ...tied,
      botTopRoleId: '200000000000000001',
      targetTopRoleId: '200000000000000011',
    });
  });

  it('rejects malformed hierarchy input', () => {
    expect(canManageMember({})).toMatchObject({ ok: false });
    expect(
      canManageMember({ ...base, actorId: 'not-a-snowflake' }),
    ).toMatchObject({ ok: false });
    const result = canManageMember({ ...base, botTopRole: 'high' });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error.code).toBe('INVALID_INPUT');
  });
});
