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
import { createModerationCommands } from '../src/commands/moderation/index.js';

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

  it('does not register additional_targets for kick, but keeps it for ban', () => {
    const commands = createModerationCommands({} as ModerationService);
    const kick = commands.find((command) => command.name === 'kick');
    const ban = commands.find((command) => command.name === 'ban');

    const optionNames = (command: typeof kick) =>
      (command?.data.options as readonly { name: string }[]).map(
        (option) => option.name,
      );
    expect(optionNames(kick)).toEqual(['target', 'reason']);
    expect(optionNames(ban)).toContain('additional_targets');
  });

  it('executes kick with only its primary target and does not read additional_targets', async () => {
    const calls: Array<{ targets: readonly { id: string }[] }> = [];
    const service = {
      kick: (input: { targets: readonly { id: string }[] }) => {
        calls.push({ targets: input.targets });
        return Promise.resolve({
          ok: true,
          value: {
            outcomes: [{ targetId: input.targets[0]?.id ?? '', ok: true }],
          },
        });
      },
    } as unknown as ModerationService;
    const kick = createModerationCommands(service).find(
      (command) => command.name === 'kick',
    );
    let additionalRead = false;
    const interaction = {
      guildId: '12345678901234567',
      user: { id: '12345678901234568' },
      options: {
        getUser: (name: string) =>
          name === 'target' ? { id: '12345678901234569' } : null,
        getString: (name: string) => {
          if (name === 'additional_targets') additionalRead = true;
          return name === 'reason' ? null : null;
        },
        getInteger: () => null,
      },
      editReply: () => Promise.resolve(undefined),
    };

    await kick?.execute({ interaction } as never);

    expect(additionalRead).toBe(false);
    expect(calls).toEqual([{ targets: [{ id: '12345678901234569' }] }]);
  });

  it('shows kick target names and IDs for successful and failed outcomes', async () => {
    const replies: Array<{
      embeds?: readonly {
        fields?: readonly { name: string; value: string }[];
      }[];
    }> = [];
    let targetId = '12345678901234569';
    let successful = true;
    const service = {
      kick: () =>
        Promise.resolve({
          ok: true,
          value: {
            outcomes: [
              successful
                ? { targetId, ok: true }
                : { targetId, ok: false, code: 'DISCORD_API_ERROR' },
            ],
          },
        }),
    } as unknown as ModerationService;
    const kick = createModerationCommands(service).find(
      (command) => command.name === 'kick',
    );
    const interaction = {
      guildId: '12345678901234567',
      user: { id: '12345678901234568' },
      options: {
        getUser: () =>
          successful
            ? { id: targetId, username: 'fallback-user' }
            : { id: targetId },
        getMember: () => ({
          displayName: successful ? 'Successful User' : null,
        }),
        getString: () => null,
        getInteger: () => null,
      },
      editReply: (reply: {
        embeds?: readonly {
          fields?: readonly { name: string; value: string }[];
        }[];
      }) => {
        replies.push(reply);
        return Promise.resolve(undefined);
      },
    };

    await kick?.execute({ interaction } as never);
    targetId = '12345678901234570';
    successful = false;
    await kick?.execute({ interaction } as never);

    expect(replies[0]?.embeds?.[0]?.fields?.[0]).toEqual({
      name: 'Successful User (12345678901234569)',
      value: '成功',
    });
    expect(replies[1]?.embeds?.[0]?.fields?.[0]).toEqual({
      name: '12345678901234570',
      value: '失敗: DISCORD_API_ERROR',
    });
  });
});
