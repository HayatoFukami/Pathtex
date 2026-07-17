import { describe, expect, it } from 'vitest';
import {
  parseReason,
  parseTargets,
  parseDuration,
} from '../src/domain/parsers.js';
import {
  validateDeleteDays,
  validateSlowmode,
  resolveUserIds,
} from '../src/features/moderation/validation.js';
import { ModerationService } from '../src/features/moderation/moderation-service.js';

describe('moderation validation', () => {
  it('normalizes and bounds bulk targets', () => {
    const parsed = parseTargets(
      '<@12345678901234567>',
      '12345678901234568, 12345678901234567',
    );
    expect(parsed.ok && parsed.value).toEqual([
      '12345678901234567',
      '12345678901234568',
    ]);
    expect(parseTargets(undefined, 'not-a-snowflake').ok).toBe(false);
  });
  it('validates durations, reasons and channel controls', () => {
    expect(parseDuration('1h30m', 28 * 86400)).toEqual({
      ok: true,
      value: 5400,
    });
    expect(parseDuration('1 month').ok).toBe(false);
    expect(parseReason('  理由  ')).toEqual({ ok: true, value: '理由' });
    expect(validateDeleteDays(8).ok).toBe(false);
    expect(validateSlowmode(21600)).toEqual({ ok: true, value: 21600 });
  });
  it('accepts at most twenty unban snowflakes and rejects mentions', () => {
    const id = '12345678901234567';
    expect(
      resolveUserIds(Array.from({ length: 20 }, () => id).join(',')).ok,
    ).toBe(true);
    expect(resolveUserIds('<@12345678901234567>').ok).toBe(false);
    expect(
      resolveUserIds(
        Array.from(
          { length: 21 },
          (_, index) => `1234567890123${String(index).padStart(4, '0')}`,
        ).join(' '),
      ).ok,
    ).toBe(false);
  });
  it('rejects invalid service options before Discord or persistence access', async () => {
    let touched = false;
    const service = new ModerationService({
      discord: {} as never,
      cases: {} as never,
      scheduler: {} as never,
      activeMutes: {} as never,
      settings: {} as never,
    });
    const result = await service.ban({
      guildId: '12345678901234567',
      actorId: '12345678901234567',
      targets: [{ id: 'bad' }],
      durationSeconds: 366 * 86400,
    });
    touched = result.ok;
    expect(touched).toBe(false);
  });
});
