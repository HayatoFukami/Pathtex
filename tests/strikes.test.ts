import { describe, expect, it, vi } from 'vitest';
import {
  parseAdditionalTargets,
  StrikeService,
} from '../src/features/strikes/strike-service.js';
import { strikesCommands } from '../src/features/strikes/commands.js';
import type { StrikeResult } from '../src/repositories/contracts.js';

const id = '12345678901234567';

describe('strikes', () => {
  it('parses additional targets and enforces the bulk boundary', () => {
    const parsed = parseAdditionalTargets(`<@!${id}>, ${id}`);
    expect(parsed.ok ? parsed.value : []).toEqual([id]);
    expect(parseAdditionalTargets(new Array(20).fill(id).join(' ')).ok).toBe(
      false,
    );
  });

  it('exposes a public AutoMod strike source', async () => {
    const result: StrikeResult = {
      beforeCount: 0,
      afterCount: 1,
      delta: 1,
      crossedPunishments: [],
      transaction: null,
    };
    const changeLocked = vi.fn().mockResolvedValue(result);
    const service = new StrikeService({
      strikes: { changeLocked, history: vi.fn().mockResolvedValue([]) },
      cases: {} as never,
      punishments: { list: vi.fn().mockResolvedValue([]) },
      moderation: {} as never,
      discord: {
        getUser: vi.fn().mockResolvedValue({ id }),
        getMember: vi.fn().mockResolvedValue(null),
        isBanned: vi.fn().mockResolvedValue(false),
        sendDm: vi.fn().mockResolvedValue(undefined),
      },
    });
    await service.autoModStrike({
      guildId: id,
      userId: '12345678901234568',
      actorId: '12345678901234569',
      amount: 1,
      reason: 'spam',
    });
    const call = changeLocked.mock.calls[0]?.[0] as {
      source: string;
      caseInput: { source: string };
    };
    expect(call.source).toBe('AUTOMOD');
    expect(call.caseInput.source).toBe('AUTOMOD');
  });

  it('keeps check user independent from strike target option', () => {
    const commands = strikesCommands({} as StrikeService);
    const check = commands.find((command) => command.name === 'check');
    const options = (
      check?.data as { options: Array<{ name: string; required?: boolean }> }
    ).options;
    expect(options).toEqual([
      {
        name: 'user',
        description: '確認するユーザー',
        type: 6,
        required: true,
      },
    ]);
  });

  it('executes automatic punishment successfully without synthesizing a case', async () => {
    const auto = vi.fn().mockResolvedValue({
      ok: true,
      value: { outcomes: [{ targetId: '12345678901234568', ok: true }] },
    });
    const cases = fakeCases();
    const service = makeService({
      cases,
      moderation: { execute: auto },
      crossedPunishments: [punishment('BAN')],
    });
    await service.strike({
      guildId: id,
      userId: '12345678901234568',
      actorId: '12345678901234569',
      amount: 1,
      reason: 'spam',
    });
    expect(auto).toHaveBeenCalled();
    expect(cases.create).not.toHaveBeenCalled();
  });

  it('synthesizes only a precondition-failure case and avoids duplicates', async () => {
    const cases = fakeCases();
    const service = makeService({
      cases,
      crossedPunishments: [punishment('KICK')],
      moderation: {
        execute: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            outcomes: [
              {
                targetId: '12345678901234568',
                ok: false,
                code: 'DISCORD_API_ERROR',
              },
            ],
          },
        }),
      },
    });
    await service.strike({
      guildId: id,
      userId: '12345678901234568',
      actorId: '12345678901234569',
      amount: 1,
      reason: 'spam',
    });
    expect(cases.create).toHaveBeenCalledTimes(1);
    const suppliedCase = { id: '00000000-0000-4000-8000-000000000012' };
    const existing = fakeCases();
    const withCase = makeService({
      cases: existing,
      crossedPunishments: [punishment('KICK')],
      moderation: {
        execute: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            outcomes: [
              {
                targetId: '12345678901234568',
                ok: false,
                code: '403',
                case: suppliedCase,
              },
            ],
          },
        }),
      },
    });
    await withCase.strike({
      guildId: id,
      userId: '12345678901234568',
      actorId: '12345678901234569',
      amount: 1,
      reason: 'spam',
    });
    expect(existing.create).not.toHaveBeenCalled();
  });

  it('executes multi-target strikes independently', async () => {
    const changeLocked = vi.fn().mockResolvedValue({
      beforeCount: 0,
      afterCount: 1,
      delta: 1,
      crossedPunishments: [],
      transaction: null,
    });
    const service = makeService({ changeLocked });
    const results = await service.strikeMany({
      guildId: id,
      userIds: ['12345678901234568', '12345678901234569'],
      actorId: '12345678901234570',
      amount: 1,
      reason: 'spam',
    });
    expect(Array.isArray(results)).toBe(true);
    expect(changeLocked).toHaveBeenCalledTimes(2);
  });

  it('renders mute and ban expiry in the check response', async () => {
    const mute = new Date('2026-01-01T00:00:00.000Z');
    const ban = new Date('2026-01-02T00:00:00.000Z');
    const service = {
      check: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          count: 2,
          muted: true,
          banned: true,
          muteExpiresAt: mute,
          banExpiresAt: ban,
          history: [],
          next: null,
        },
      }),
    } as unknown as StrikeService;
    const check = strikesCommands(service).find(
      (command) => command.name === 'check',
    );
    const reply = vi.fn();
    await check?.execute({
      interaction: {
        guildId: id,
        user: { id },
        options: {
          getUser: vi.fn().mockReturnValue({ id: '12345678901234568' }),
        },
        editReply: reply,
      } as never,
      receivedAt: Date.now(),
    });
    expect(reply.mock.calls[0]?.[0]).toContain(mute.toISOString());
    expect(reply.mock.calls[0]?.[0]).toContain(ban.toISOString());
  });
});

function punishment(action: 'BAN' | 'KICK') {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    guildId: id,
    threshold: 1,
    action,
    durationSeconds: null,
    createdBy: id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function fakeCases() {
  return {
    create: vi.fn().mockResolvedValue({
      ok: true,
      value: { id: '00000000-0000-4000-8000-000000000010' },
    }),
    updateStatus: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    updateMetadata: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    get: vi.fn().mockResolvedValue({ ok: true, value: { caseNumber: 1 } }),
  };
}

function makeService(
  overrides: {
    cases?: unknown;
    moderation?: unknown;
    crossedPunishments?: unknown[];
    changeLocked?: unknown;
  } = {},
) {
  return new StrikeService({
    strikes: {
      changeLocked: (overrides.changeLocked ??
        vi.fn().mockResolvedValue({
          beforeCount: 0,
          afterCount: 1,
          delta: 1,
          crossedPunishments: overrides.crossedPunishments ?? [],
          transaction: { modCaseId: '00000000-0000-4000-8000-000000000011' },
        })) as never,
      history: vi.fn().mockResolvedValue([]),
    },
    cases: (overrides.cases ?? fakeCases()) as never,
    punishments: { list: vi.fn().mockResolvedValue([]) },
    moderation: (overrides.moderation ?? { execute: vi.fn() }) as never,
    discord: {
      getUser: vi.fn().mockResolvedValue({ id }),
      getMember: vi.fn().mockResolvedValue(null),
      isBanned: vi.fn().mockResolvedValue(false),
      sendDm: vi.fn().mockResolvedValue(undefined),
    },
  });
}
