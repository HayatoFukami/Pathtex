import { describe, expect, it, vi } from 'vitest';
import {
  BAN_MAX_DURATION_SECONDS,
  MUTE_MAX_DURATION_SECONDS,
  punishmentDurationError,
  punishmentSchema,
} from '../src/domain/index.js';
import { PunishmentParametersSchema } from '../src/repositories/contracts.js';
import { StrikeService } from '../src/features/strikes/strike-service.js';

const id = '12345678901234567';
const actor = '12345678901234568';
const DAY = 86_400;

type Action = 'MUTE' | 'KICK' | 'SOFTBAN' | 'BAN';

describe('punishment action-duration configuration policy', () => {
  describe('punishmentDurationError (shared policy)', () => {
    const accepted: ReadonlyArray<readonly [Action, number | null]> = [
      ['MUTE', null],
      ['MUTE', 600],
      ['MUTE', MUTE_MAX_DURATION_SECONDS],
      ['BAN', null],
      ['BAN', 600],
      ['BAN', BAN_MAX_DURATION_SECONDS],
      ['KICK', null],
      ['SOFTBAN', null],
    ];
    it.each(accepted)('accepts %s with duration %s', (action, duration) => {
      expect(punishmentDurationError(action, duration)).toBeNull();
    });

    const rejected: ReadonlyArray<readonly [Action, number, string]> = [
      ['KICK', 1, 'Duration is not allowed for this action'],
      ['KICK', 600, 'Duration is not allowed for this action'],
      ['SOFTBAN', 600, 'Duration is not allowed for this action'],
      [
        'SOFTBAN',
        MUTE_MAX_DURATION_SECONDS,
        'Duration is not allowed for this action',
      ],
      ['MUTE', MUTE_MAX_DURATION_SECONDS + 1, 'Mute duration exceeds 28 days'],
      ['MUTE', 30 * DAY, 'Mute duration exceeds 28 days'],
      ['MUTE', BAN_MAX_DURATION_SECONDS, 'Mute duration exceeds 28 days'],
      ['BAN', BAN_MAX_DURATION_SECONDS + 1, 'Ban duration exceeds 365 days'],
      ['MUTE', 0, 'Invalid duration'],
      ['BAN', -5, 'Invalid duration'],
      ['MUTE', 1.5, 'Invalid duration'],
    ];
    it.each(rejected)(
      'rejects %s with duration %s',
      (action, duration, message) => {
        expect(punishmentDurationError(action, duration)).toBe(message);
      },
    );
  });

  describe('punishmentSchema (domain)', () => {
    const parse = (action: Action, durationSeconds?: number) =>
      punishmentSchema.safeParse({ threshold: 3, action, durationSeconds });

    it('accepts valid action-duration combinations', () => {
      expect(parse('MUTE', 600).success).toBe(true);
      expect(parse('MUTE', MUTE_MAX_DURATION_SECONDS).success).toBe(true);
      expect(parse('MUTE').success).toBe(true);
      expect(parse('BAN', 600).success).toBe(true);
      expect(parse('BAN', BAN_MAX_DURATION_SECONDS).success).toBe(true);
      expect(parse('BAN').success).toBe(true);
      expect(parse('KICK').success).toBe(true);
      expect(parse('SOFTBAN').success).toBe(true);
    });

    it('rejects KICK/SOFTBAN carrying any duration', () => {
      const kick = parse('KICK', 600);
      expect(kick.success).toBe(false);
      const softban = parse('SOFTBAN', 600);
      expect(softban.success).toBe(false);
      if (!kick.success)
        expect(kick.error.issues[0]?.message).toBe(
          'Duration is not allowed for this action',
        );
    });

    it('rejects MUTE beyond 28 days with the action-specific message', () => {
      const result = parse('MUTE', MUTE_MAX_DURATION_SECONDS + 1);
      expect(result.success).toBe(false);
      if (!result.success)
        expect(result.error.issues[0]?.message).toBe(
          'Mute duration exceeds 28 days',
        );
    });

    it('rejects BAN beyond 365 days', () => {
      expect(parse('BAN', BAN_MAX_DURATION_SECONDS + 1).success).toBe(false);
    });
  });

  describe('PunishmentParametersSchema (persistence write boundary)', () => {
    const parse = (action: Action, durationSeconds: number | null) =>
      PunishmentParametersSchema.safeParse({
        guildId: id,
        threshold: 3,
        action,
        durationSeconds,
        actor,
      });

    it('accepts valid action-duration combinations', () => {
      expect(parse('MUTE', 600).success).toBe(true);
      expect(parse('MUTE', MUTE_MAX_DURATION_SECONDS).success).toBe(true);
      expect(parse('MUTE', null).success).toBe(true);
      expect(parse('BAN', 600).success).toBe(true);
      expect(parse('BAN', BAN_MAX_DURATION_SECONDS).success).toBe(true);
      expect(parse('BAN', null).success).toBe(true);
      expect(parse('KICK', null).success).toBe(true);
      expect(parse('SOFTBAN', null).success).toBe(true);
    });

    it('rejects impossible combinations before persistence', () => {
      const kick = parse('KICK', 600);
      expect(kick.success).toBe(false);
      if (!kick.success)
        expect(kick.error.issues[0]?.message).toBe(
          'Duration is not allowed for this action',
        );
      expect(parse('SOFTBAN', 600).success).toBe(false);

      const mute = parse('MUTE', MUTE_MAX_DURATION_SECONDS + 1);
      expect(mute.success).toBe(false);
      if (!mute.success)
        expect(mute.error.issues[0]?.message).toBe(
          'Mute duration exceeds 28 days',
        );

      const ban = parse('BAN', BAN_MAX_DURATION_SECONDS + 1);
      expect(ban.success).toBe(false);
      if (!ban.success)
        expect(ban.error.issues[0]?.message).toBe(
          'Ban duration exceeds 365 days',
        );
    });
  });

  describe('StrikeService.setPunishment (public service)', () => {
    function makeService() {
      const set = vi.fn().mockResolvedValue({
        id: '00000000-0000-4000-8000-000000000001',
        guildId: id,
        threshold: 3,
        action: 'MUTE',
        durationSeconds: 600,
        createdBy: actor,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const remove = vi.fn().mockResolvedValue(true);
      const service = new StrikeService({
        strikes: {} as never,
        cases: {} as never,
        punishments: { list: vi.fn().mockResolvedValue([]), set, remove },
        moderation: {} as never,
        discord: {} as never,
      });
      return { service, set, remove };
    }

    const input = (
      action: 'MUTE' | 'KICK' | 'SOFTBAN' | 'BAN',
      durationSeconds?: number | string | null,
    ) => ({
      guildId: id,
      actorId: actor,
      threshold: 3,
      action,
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
    });

    it('accepts valid combinations and persists them unchanged', async () => {
      const cases: ReadonlyArray<
        readonly [
          'MUTE' | 'KICK' | 'SOFTBAN' | 'BAN',
          number | null,
          number | null,
        ]
      > = [
        ['MUTE', 600, 600],
        ['MUTE', MUTE_MAX_DURATION_SECONDS, MUTE_MAX_DURATION_SECONDS],
        ['MUTE', null, null],
        ['BAN', 600, 600],
        ['BAN', BAN_MAX_DURATION_SECONDS, BAN_MAX_DURATION_SECONDS],
        ['BAN', null, null],
        ['KICK', null, null],
        ['SOFTBAN', null, null],
      ];
      for (const [action, duration, persisted] of cases) {
        const { service, set } = makeService();
        const result = await service.setPunishment(input(action, duration));
        expect(result.ok, `${action} ${String(duration)}`).toBe(true);
        expect(set).toHaveBeenCalledWith(id, 3, action, persisted, actor);
      }
    });

    it('accepts a valid string duration for MUTE and BAN', async () => {
      const mute = makeService();
      const muteResult = await mute.service.setPunishment(input('MUTE', '7d'));
      expect(muteResult.ok).toBe(true);
      expect(mute.set).toHaveBeenCalledWith(id, 3, 'MUTE', 7 * DAY, actor);

      const ban = makeService();
      const banResult = await ban.service.setPunishment(input('BAN', '30d'));
      expect(banResult.ok).toBe(true);
      expect(ban.set).toHaveBeenCalledWith(id, 3, 'BAN', 30 * DAY, actor);
    });

    it('rejects impossible combinations without persisting', async () => {
      const rejectedCases: ReadonlyArray<
        readonly ['MUTE' | 'KICK' | 'SOFTBAN' | 'BAN', number | string, string]
      > = [
        ['KICK', 600, 'Duration is not allowed for this action'],
        ['SOFTBAN', 600, 'Duration is not allowed for this action'],
        ['KICK', '1h', 'Duration is not allowed for this action'],
        [
          'MUTE',
          MUTE_MAX_DURATION_SECONDS + 1,
          'Mute duration exceeds 28 days',
        ],
        ['MUTE', '30d', 'Mute duration exceeds 28 days'],
        ['BAN', BAN_MAX_DURATION_SECONDS + 1, 'Ban duration exceeds 365 days'],
      ];
      for (const [action, duration, message] of rejectedCases) {
        const { service, set } = makeService();
        const result = await service.setPunishment(input(action, duration));
        expect(result.ok, `${action} ${String(duration)}`).toBe(false);
        if (!result.ok) expect(result.error.message).toBe(message);
        expect(set).not.toHaveBeenCalled();
      }
    });

    it('rejects a string duration beyond the 365 day parse bound', async () => {
      const { service, set } = makeService();
      const result = await service.setPunishment(input('BAN', '400d'));
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error.message).toBe('Duration is out of range');
      expect(set).not.toHaveBeenCalled();
    });
  });
});
