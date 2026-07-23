import { describe, expect, it, vi } from 'vitest';
import { AutomodService } from '../src/features/automod/service.js';
import { IgnoreService } from '../src/features/automod/ignore.js';
import { automodCommands } from '../src/features/automod/commands.js';
import { LoggingEventPipeline } from '../src/features/logging/pipeline.js';
import {
  antiReferral,
  antiInvites,
  copypastaMatch,
  DuplicateLru,
  parseCopypastaResource,
} from '../src/features/automod/domain.js';

const settings = (patch: Record<string, unknown> = {}) =>
  ({
    guildId: '1',
    antiInviteStrikes: 1,
    antiReferralStrikes: 0,
    antiEveryoneStrikes: 0,
    antiCopypastaStrikes: 0,
    duplicateEnabled: false,
    duplicateStrikes: 1,
    autoRaidEnabled: false,
    autoRaidJoinCount: 10,
    autoRaidWindowSeconds: 10,
    autoRaidIdleSeconds: 120,
    ...patch,
  }) as never;
const make = (patch: Record<string, unknown> = {}) => {
  const strike = vi.fn().mockResolvedValue({ ok: true });
  const deleteMessage = vi.fn().mockResolvedValue(undefined);
  const deleteMessages = vi.fn().mockResolvedValue(undefined);
  const dehoist = vi.fn().mockResolvedValue(undefined);
  const discord = {
    deleteMessage,
    deleteMessages,
    dehoist,
    getMember: vi
      .fn()
      .mockResolvedValue({ roleIds: [], canMentionEveryone: false }),
    getEffectiveMemberPermissions: vi.fn().mockResolvedValue([]),
    getBotUserId: vi.fn().mockResolvedValue('bot'),
  };
  const service = new AutomodService({
    settings: {
      getOrCreate: vi.fn().mockResolvedValue(settings(patch)),
      update: vi.fn(),
    },
    punishments: { list: vi.fn().mockResolvedValue([{ threshold: 1 }]) },
    strikes: { autoModStrike: strike },
    discord,
  });
  return { service, strike, discord, deleteMessage, deleteMessages, dehoist };
};
describe('AutoMod', () => {
  it('never passes an author ID as the legacy display', async () => {
    const { service, strike } = make();
    await service.evaluate({
      id: 'identity-no-display',
      guildId: '12345678901234567',
      channelId: '12345678901234568',
      authorId: '12345678901234569',
      content: 'discord.gg/abc',
    });
    expect(strike).toHaveBeenCalledWith(
      expect.not.objectContaining({ display: '12345678901234569' }),
    );
  });

  it('passes the actual member display as a canonical identity to StrikeService', async () => {
    const { service, strike, discord } = make();
    discord.getMember.mockResolvedValue({
      roleIds: [],
      canMentionEveryone: false,
      displayName: 'Actual Author',
    });
    await service.evaluate({
      id: 'identity-member',
      guildId: '12345678901234567',
      channelId: '12345678901234568',
      authorId: '12345678901234569',
      content: 'discord.gg/abc',
    });
    expect(strike).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: {
          userId: '12345678901234569',
          displayName: 'Actual Author',
        },
      }),
    );
  });

  it('skips AutoMod when the required member is missing', async () => {
    const { service, strike, discord } = make();
    discord.getMember.mockResolvedValue(null);
    await service.evaluate({
      id: 'identity-missing-member',
      guildId: '12345678901234567',
      channelId: '12345678901234568',
      authorId: '12345678901234569',
      content: 'discord.gg/abc',
    });
    expect(strike).not.toHaveBeenCalled();
  });

  it('propagates fatal Strike resolver authentication failures', async () => {
    const { service, strike } = make();
    strike.mockRejectedValueOnce(
      Object.assign(new Error('expired'), { status: 401 }),
    );
    await expect(
      service.evaluate({
        id: 'identity-auth-failure',
        guildId: '12345678901234567',
        channelId: '12345678901234568',
        authorId: '12345678901234569',
        content: 'discord.gg/abc',
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('excludes the author, bots, and duplicate users from max user mentions', async () => {
    const { service, strike } = make({ maxUserMentions: 2 });
    const message = {
      id: 'mentions',
      guildId: 'g',
      channelId: 'c',
      authorId: 'self',
      content: 'mentions',
      userMentions: [
        { id: 'self' },
        { id: 'bot', bot: true },
        { id: 'user-1' },
        { id: 'user-1' },
        { id: 'user-2' },
      ],
    } as const;
    await service.evaluate(message);
    expect(strike).not.toHaveBeenCalled();
    await service.evaluate({
      ...message,
      id: 'mentions-2',
      userMentions: [...message.userMentions, { id: 'user-3' }],
    });
    expect(strike).toHaveBeenCalledWith(expect.objectContaining({ amount: 1 }));
  });
  it('counts unique role mentions for max role mentions', async () => {
    const { service, strike } = make({ maxRoleMentions: 2 });
    await service.evaluate({
      id: 'roles',
      guildId: 'g',
      channelId: 'c',
      authorId: 'u',
      content: 'roles',
      roleMentions: ['r1', 'r1', 'r2'],
    });
    expect(strike).not.toHaveBeenCalled();
    await service.evaluate({
      id: 'roles-2',
      guildId: 'g',
      channelId: 'c',
      authorId: 'u',
      content: 'roles',
      roleMentions: ['r1', 'r1', 'r2', 'r3'],
    });
    expect(strike).toHaveBeenCalledWith(expect.objectContaining({ amount: 1 }));
  });
  it('isolates AutoMod pipeline failures and emits structured failure logs', async () => {
    const saveMessage = vi.fn().mockResolvedValue(undefined);
    const error = vi.fn();
    const pipeline = new LoggingEventPipeline({
      snapshots: {
        saveMessage,
        getMessage: vi.fn(),
        deleteMessage: vi.fn(),
        saveMember: vi.fn(),
        getMembersForUser: vi.fn(),
      },
      automod: {
        inspect: vi.fn().mockRejectedValue(new Error('automod down')),
      },
      events: { messageEdit: vi.fn().mockReturnValue(null) } as never,
      delivery: { deliver: vi.fn() } as never,
      timezone: vi.fn().mockResolvedValue('UTC'),
      logger: { error } as never,
    });
    await pipeline.messageCreate({
      guildId: 'g',
      channelId: 'c',
      messageId: 'm',
      author: 'user',
      authorId: 'u',
      content: 'hello',
      createdAt: new Date(),
    });
    expect(saveMessage).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'logging.pipeline.automod_create_failed',
        guildId: 'g',
        channelId: 'c',
        userId: 'u',
        errorName: 'Error',
      }),
      expect.any(String),
    );
  });
  it('edits the AutoDehoist command reply with its warning', async () => {
    const service = {
      update: vi.fn().mockResolvedValue({
        ok: true,
        value: { warning: '空白または英数字の置換文字です' },
      }),
    } as unknown as AutomodService;
    const command = automodCommands(service).find(
      (item) => item.name === 'autodehoist',
    );
    const interaction = {
      guildId: 'g',
      editReply: vi.fn().mockResolvedValue(undefined),
      options: {
        getSubcommand: vi.fn().mockReturnValue('set'),
        getString: vi.fn().mockReturnValue(' '),
      },
    };
    await command?.execute({ interaction } as never);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: '設定を更新しました。警告: 空白または英数字の置換文字です',
    });
  });
  it('reports automatic strong-role ignores as non-removable', async () => {
    const repository = {
      setRole: vi.fn(),
      setChannel: vi.fn(),
      removeRole: vi.fn(),
      removeChannel: vi.fn(),
      clearChannel: vi.fn(),
      listRoles: vi.fn().mockResolvedValue([]),
      listChannels: vi.fn().mockResolvedValue([]),
    };
    const service = new IgnoreService(repository);
    await expect(service.removeRole('1', '2', true)).resolves.toMatchObject({
      ok: false,
    });
    expect(repository.removeRole).not.toHaveBeenCalled();
  });
  it('detects every invite and loads copypasta definitions', () => {
    expect(antiInvites('discord . gg / abc discord dot gg / def')).toHaveLength(
      2,
    );
    expect(
      antiReferral('https://sub.example.test/path', [' example.test. ']),
    ).toBe(true);
    const definitions = parseCopypastaResource('spam|hello,world|optional|1');
    expect(copypastaMatch('hello world optional', definitions)?.name).toBe(
      'spam',
    );
  });
  it('uses channel-effective permissions for mentions and automatic ignores', async () => {
    const { service, strike, discord } = make({ antiEveryoneStrikes: 1 });
    discord.getEffectiveMemberPermissions
      .mockResolvedValueOnce(['MentionEveryone'])
      .mockResolvedValueOnce(['BanMembers']);
    await service.evaluate({
      id: 'mention-allowed',
      guildId: 'g',
      channelId: 'c',
      authorId: 'u',
      content: '@everyone',
      everyoneMentioned: true,
    });
    expect(strike).not.toHaveBeenCalled();
    const ignored = await service.evaluate({
      id: 'permission-ignored',
      guildId: 'g',
      channelId: 'c',
      authorId: 'u',
      content: 'discord.gg/abc',
    });
    expect(ignored).toMatchObject({ value: { strikes: 0, deleted: false } });
  });
  it('retries deletion failures and continues to strike on a permanent failure', async () => {
    const { service, strike, deleteMessage } = make();
    deleteMessage
      .mockRejectedValueOnce(
        Object.assign(new Error('temporary'), { status: 500 }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('forbidden'), { status: 403 }),
      );
    const result = await service.evaluate({
      id: 'delete-failure',
      guildId: 'g',
      channelId: 'c',
      authorId: 'u',
      content: 'discord.gg/abc',
    });
    expect(deleteMessage).toHaveBeenCalledTimes(2);
    expect(strike).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ value: { deleted: false, strikes: 1 } });
  });
  it('does not cache an edited rule when strike persistence fails', async () => {
    const { service, strike } = make();
    strike.mockRejectedValueOnce(new Error('strike unavailable'));
    const message = {
      id: 'edited',
      guildId: 'g',
      channelId: 'c',
      authorId: 'u',
      content: 'discord.gg/abc',
      isEdit: true,
    } as const;
    await service.evaluate(message, 1);
    await service.evaluate(message, 2);
    expect(strike).toHaveBeenCalledTimes(2);
  });
  it('warns for whitespace and alphanumeric autodehoist replacements', async () => {
    const { service } = make();
    const update = (
      service as unknown as {
        deps: { settings: { update: ReturnType<typeof vi.fn> } };
      }
    ).deps.settings.update;
    const whitespace = await service.update('g', {
      autodehoistCharacter: ' ',
    });
    expect(whitespace).toMatchObject({
      value: {
        warning: '空白または英数字を設定すると名前の先頭記号として機能しません',
      },
    });
    const alphanumeric = await service.update('g', {
      autodehoistCharacter: 'A',
    });
    expect(alphanumeric).toMatchObject({
      value: {
        warning: '空白または英数字を設定すると名前の先頭記号として機能しません',
      },
    });
    expect(update).toHaveBeenCalledTimes(2);
  });
  it('uses one delete and one bot-attributed strike for aggregated rules', async () => {
    const { service, strike, deleteMessage } = make({ maxLines: 1 });
    const result = await service.evaluate({
      id: 'm',
      guildId: 'g',
      channelId: 'c',
      authorId: 'u',
      content: 'discord.gg/abc\nextra',
    });
    expect(result).toMatchObject({
      ok: true,
      value: { deleted: true, strikes: 2 },
    });
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(strike).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'bot' }),
    );
  });
  describe('punishment prerequisite for strike-producing rules', () => {
    const noPunishments = (service: AutomodService) => {
      (
        service as unknown as {
          deps: { punishments: { list: ReturnType<typeof vi.fn> } };
        }
      ).deps.punishments.list.mockResolvedValue([]);
    };

    it('rejects each fixed strike rule without punishment', async () => {
      for (const field of [
        'antiInviteStrikes',
        'antiReferralStrikes',
        'antiEveryoneStrikes',
        'antiCopypastaStrikes',
      ] as const) {
        const { service } = make();
        noPunishments(service);
        await expect(
          service.update('g', { [field]: 3 }),
        ).resolves.toMatchObject({
          ok: false,
          error: { code: 'CONFIGURATION_MISSING' },
        });
      }
    });

    it('rejects maxUserMentions without punishment', async () => {
      const { service } = make();
      noPunishments(service);
      await expect(
        service.update('g', { maxUserMentions: 10 }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'CONFIGURATION_MISSING' },
      });
    });

    it('rejects maxRoleMentions without punishment', async () => {
      const { service } = make();
      noPunishments(service);
      await expect(
        service.update('g', { maxRoleMentions: 5 }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'CONFIGURATION_MISSING' },
      });
    });

    it('rejects maxLines without punishment', async () => {
      const { service } = make();
      noPunishments(service);
      await expect(
        service.update('g', { maxLines: 20 }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'CONFIGURATION_MISSING' },
      });
    });

    it('rejects duplicateEnabled without punishment', async () => {
      const { service } = make();
      noPunishments(service);
      await expect(
        service.update('g', { duplicateEnabled: true }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'CONFIGURATION_MISSING' },
      });
    });

    it('rejects when a later fixed rule is positive even if an earlier one is 0', async () => {
      // Regression: the old ?? chain only checked the first non-nullish value,
      // so antiInviteStrikes:0 + antiReferralStrikes:5 slipped through.
      const { service } = make();
      noPunishments(service);
      await expect(
        service.update('g', {
          antiInviteStrikes: 0,
          antiReferralStrikes: 5,
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'CONFIGURATION_MISSING' },
      });
    });

    it('allows disabling fixed rules without punishment', async () => {
      for (const field of [
        'antiInviteStrikes',
        'antiReferralStrikes',
        'antiEveryoneStrikes',
        'antiCopypastaStrikes',
      ] as const) {
        const { service } = make();
        noPunishments(service);
        await expect(
          service.update('g', { [field]: 0 }),
        ).resolves.toMatchObject({ ok: true });
      }
    });

    it('allows disabling maxmentions/maxlines (null) without punishment', async () => {
      const { service } = make();
      noPunishments(service);
      await expect(
        service.update('g', {
          maxUserMentions: null,
          maxRoleMentions: null,
          maxLines: null,
        }),
      ).resolves.toMatchObject({ ok: true });
    });

    it('allows disabling duplicate without punishment', async () => {
      const { service } = make();
      noPunishments(service);
      await expect(
        service.update('g', { duplicateEnabled: false }),
      ).resolves.toMatchObject({ ok: true });
    });

    it('allows non-strike settings (autodehoist) without punishment', async () => {
      const { service } = make();
      noPunishments(service);
      await expect(
        service.update('g', { autodehoistCharacter: '!' }),
      ).resolves.toMatchObject({ ok: true });
    });

    it('allows all strike-producing rules when punishment exists', async () => {
      const { service } = make();
      // Default make() has punishments: [{ threshold: 1 }]
      await expect(
        service.update('g', {
          antiInviteStrikes: 2,
          antiReferralStrikes: 1,
          antiEveryoneStrikes: 1,
          antiCopypastaStrikes: 1,
          maxUserMentions: 10,
          maxRoleMentions: 5,
          maxLines: 20,
          duplicateEnabled: true,
          duplicateStrikeThreshold: 3,
          duplicateStrikes: 1,
        }),
      ).resolves.toMatchObject({ ok: true });
    });

    it('calls punishments.list exactly once per update', async () => {
      const { service } = make();
      const list = (
        service as unknown as {
          deps: { punishments: { list: ReturnType<typeof vi.fn> } };
        }
      ).deps.punishments.list;
      await service.update('g', {
        antiInviteStrikes: 1,
        maxUserMentions: 10,
        duplicateEnabled: true,
      });
      expect(list).toHaveBeenCalledTimes(1);
    });
  });
  it('expires duplicate LRU entries and keeps bounded state', () => {
    const lru = new DuplicateLru(1, 30_000);
    lru.observe('a', 'x', 'c', '1', 0);
    lru.observe('a', 'x', 'c', '2', 1_000);
    expect(lru.get('a')?.ordinal).toBe(2);
    lru.observe('b', 'x', 'c', '3', 2_000);
    expect(lru.get('a')).toBeUndefined();
  });

  describe('fatal-401 propagation at every catch boundary', () => {
    const msg = {
      id: 'm1',
      guildId: 'g',
      channelId: 'c',
      authorId: 'u',
      content: 'discord.gg/abc',
    } as const;

    it('deleteWithRetry rethrows a direct status 401', async () => {
      const { service, deleteMessage } = make();
      deleteMessage.mockRejectedValue(
        Object.assign(new Error('unauthorized'), { status: 401 }),
      );
      await expect(service.evaluate(msg)).rejects.toMatchObject({
        status: 401,
      });
    });

    it('deleteWithRetry rethrows a code 401', async () => {
      const { service, deleteMessage } = make();
      deleteMessage.mockRejectedValue(
        Object.assign(new Error('unauthorized'), { code: 401 }),
      );
      await expect(service.evaluate(msg)).rejects.toMatchObject({ code: 401 });
    });

    it('deleteWithRetry rethrows a cause-wrapped 401', async () => {
      const { service, deleteMessage } = make();
      deleteMessage.mockRejectedValue(
        Object.assign(new Error('wrapper'), { cause: { status: 401 } }),
      );
      await expect(service.evaluate(msg)).rejects.toMatchObject({
        cause: { status: 401 },
      });
    });

    it('deleteBatchWithRetry rethrows a direct status 401', async () => {
      const { service, deleteMessages } = make({
        duplicateEnabled: true,
        duplicateStrikeThreshold: 2,
        duplicateDeleteThreshold: 2,
        duplicateStrikes: 1,
      });
      deleteMessages.mockRejectedValue(
        Object.assign(new Error('unauthorized'), { status: 401 }),
      );
      // Seed a prior duplicate so batch path is taken (ids.length > 1).
      await service.evaluate({ ...msg, id: 'seed' }, 1);
      await expect(
        service.evaluate({ ...msg, id: 'dup' }, 2),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('deleteBatchWithRetry rethrows a cause-wrapped 401', async () => {
      const { service, deleteMessages } = make({
        duplicateEnabled: true,
        duplicateStrikeThreshold: 2,
        duplicateDeleteThreshold: 2,
        duplicateStrikes: 1,
      });
      deleteMessages.mockRejectedValue(
        Object.assign(new Error('wrapper'), { cause: { code: 401 } }),
      );
      await service.evaluate({ ...msg, id: 'seed2' }, 1);
      await expect(
        service.evaluate({ ...msg, id: 'dup2' }, 2),
      ).rejects.toMatchObject({ cause: { code: 401 } });
    });

    it('strike catch rethrows a cause-wrapped 401', async () => {
      const { service, strike } = make();
      strike.mockRejectedValue(
        Object.assign(new Error('wrapper'), { cause: { status: 401 } }),
      );
      await expect(service.evaluate(msg)).rejects.toMatchObject({
        cause: { status: 401 },
      });
    });

    it('strike catch rethrows a code 401', async () => {
      const { service, strike } = make();
      strike.mockRejectedValue(
        Object.assign(new Error('unauthorized'), { code: 401 }),
      );
      await expect(service.evaluate(msg)).rejects.toMatchObject({ code: 401 });
    });

    it('autoDehoist rethrows a direct status 401', async () => {
      const { service, dehoist } = make({ autodehoistCharacter: '!' });
      dehoist.mockRejectedValue(
        Object.assign(new Error('unauthorized'), { status: 401 }),
      );
      await expect(
        service.autoDehoist('g', 'u', '.badname'),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('autoDehoist rethrows a cause-wrapped 401', async () => {
      const { service, dehoist } = make({ autodehoistCharacter: '!' });
      dehoist.mockRejectedValue(
        Object.assign(new Error('wrapper'), { cause: { code: 401 } }),
      );
      await expect(
        service.autoDehoist('g', 'u', '.badname'),
      ).rejects.toMatchObject({ cause: { code: 401 } });
    });
  });

  describe('non-auth errors preserve warning/fallback semantics', () => {
    const msg = {
      id: 'm1',
      guildId: 'g',
      channelId: 'c',
      authorId: 'u',
      content: 'discord.gg/abc',
    } as const;

    it('deleteWithRetry treats 403 as a permanent non-auth failure and still strikes', async () => {
      const { service, strike, deleteMessage } = make();
      deleteMessage.mockRejectedValue(
        Object.assign(new Error('forbidden'), { status: 403 }),
      );
      const result = await service.evaluate(msg);
      expect(result).toMatchObject({ value: { deleted: false, strikes: 1 } });
      expect(strike).toHaveBeenCalledTimes(1);
    });

    it('deleteWithRetry retries 500 then surfaces warning and still strikes', async () => {
      const { service, strike, deleteMessage } = make();
      deleteMessage.mockRejectedValue(
        Object.assign(new Error('server error'), { status: 500 }),
      );
      const result = await service.evaluate(msg);
      expect(deleteMessage).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({ value: { deleted: false, strikes: 1 } });
      expect(strike).toHaveBeenCalledTimes(1);
    });

    it('strike non-auth failure produces a warning, not a throw', async () => {
      const { service, strike } = make();
      strike.mockRejectedValue(new Error('strike db down'));
      const result = await service.evaluate(msg);
      expect(result).toMatchObject({ ok: true, value: { strikes: 1 } });
      expect(
        (result as { value: { warnings: readonly string[] } }).value.warnings,
      ).toContain('strike db down');
    });

    it('autoDehoist non-auth failure returns false with warning', async () => {
      const warning = vi.fn();
      const { service, dehoist } = make({ autodehoistCharacter: '!' });
      dehoist.mockRejectedValue(
        Object.assign(new Error('forbidden'), { status: 403 }),
      );
      (
        service as unknown as {
          deps: { warning: typeof warning };
        }
      ).deps.warning = warning;
      const result = await service.autoDehoist('g', 'u', '.badname');
      expect(result).toBe(false);
      expect(warning).toHaveBeenCalledWith('g', 'forbidden');
    });

    it('deleteWithRetry treats code 10008 (Unknown Message) as success', async () => {
      const { service, strike, deleteMessage } = make();
      deleteMessage.mockRejectedValue(
        Object.assign(new Error('unknown message'), { code: 10008 }),
      );
      const result = await service.evaluate(msg);
      expect(result).toMatchObject({ value: { deleted: true, strikes: 1 } });
      expect(strike).toHaveBeenCalledTimes(1);
    });
  });
});
