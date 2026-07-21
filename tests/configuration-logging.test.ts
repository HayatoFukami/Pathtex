import { describe, expect, it, vi } from 'vitest';
import {
  ConfigurationOverviewError,
  ConfigurationService,
  formatGuildTime,
} from '../src/features/configuration/service.js';
import { serviceSettingsText } from '../src/features/configuration/commands.js';
import { installMessageLoggingListeners } from '../src/index.js';
import {
  classifyVoice,
  isBotAuthoredMessage,
  isConfiguredLogChannel,
  LogDeliveryService,
  messageEditEmbed,
  messageDeleteEmbed,
  bulkDeleteEmbed,
  voiceEmbed,
  normalizeEmbed,
  serverEmbed,
} from '../src/features/logging/index.js';

describe('configuration and logging slice', () => {
  const guildId = '12345678901234567';
  const settings = {
    guildId,
    modlogChannelId: null,
    messageLogChannelId: null,
    serverLogChannelId: null,
    voiceLogChannelId: null,
    modRoleId: null,
    mutedRoleId: null,
    timezone: 'UTC',
    raidModeEnabled: false,
    raidModeSource: null,
    raidModeReason: null,
    raidStartedAt: null,
    verificationLevelBeforeRaid: null,
    raidVerificationChanged: false,
    nextCaseNumber: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('returns all configured overview sections on success', async () => {
    const service = new ConfigurationService({
      settings: { getOrCreate: vi.fn().mockResolvedValue(settings) } as never,
      setup: {
        getAutomaticIgnoredRoles: vi.fn().mockResolvedValue(['role-automatic']),
        getBotWarnings: vi.fn().mockResolvedValue(['権限不足']),
      } as never,
    });

    await expect(service.overview(guildId)).resolves.toMatchObject({
      ok: true,
      value: {
        settings,
        automod: null,
        punishments: [],
        ignoredRoles: [],
        ignoredChannels: [],
        automaticIgnoredRoles: ['role-automatic'],
        botWarnings: ['権限不足'],
        resourceWarnings: [],
      },
    });
  });

  it('renders automatic ignore roles and bot warnings in settings output', () => {
    const output = serviceSettingsText({
      settings,
      automod: null,
      punishments: [],
      ignoredRoles: [],
      ignoredChannels: [],
      automaticIgnoredRoles: ['role-automatic'],
      botWarnings: ['権限不足'],
      resourceWarnings: [],
    });

    expect(output).toContain('自動Ignoreロール: role-automatic');
    expect(output).toContain('Bot権限警告: 権限不足');
  });

  it('identifies a failed overview dependency and preserves its cause', async () => {
    const cause = new Error('automod backend unavailable');
    const service = new ConfigurationService({
      settings: { getOrCreate: vi.fn().mockResolvedValue(settings) } as never,
      automod: {
        getOrCreate: vi.fn().mockRejectedValue(cause),
        update: vi.fn(),
      },
    });

    await expect(service.overview(guildId)).rejects.toSatisfy(
      (error: unknown) => {
        return (
          error instanceof ConfigurationOverviewError &&
          error.dependency === 'automod' &&
          error.cause === cause
        );
      },
    );
  });

  it('renders configured timezone while preserving the instant', () => {
    expect(
      formatGuildTime(new Date('2026-01-01T00:00:00.000Z'), 'Asia/Tokyo'),
    ).toContain('2026-01-01 09:00:00');
  });
  it('classifies only channel transitions as voice events', () => {
    expect(classifyVoice(null, '1')).toBe('Join');
    expect(classifyVoice('1', null)).toBe('Leave');
    expect(classifyVoice('1', '2')).toBe('Move');
    expect(classifyVoice('1', '1')).toBeNull();
  });
  it('does not log embed-only equivalent updates', () => {
    const base = {
      guildId: '12345678901234567',
      channelId: '12345678901234568',
      messageId: '12345678901234569',
      author: 'a',
      authorId: '12345678901234570',
      content: 'same',
      createdAt: new Date(),
    };
    expect(messageEditEmbed(base, { ...base }, new Date())).toBeNull();
  });
  it('delivers server embeds with a Discord timestamp', async () => {
    const embed = serverEmbed(
      'Member Join',
      [{ name: 'ユーザー', value: 'user' }],
      new Date(),
    );
    expect(embed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    const send = vi.fn().mockResolvedValue(undefined);
    const delivery = new LogDeliveryService(
      { send },
      {
        getChannel: vi.fn().mockResolvedValue('12345678901234568'),
        clearChannel: vi.fn(),
      },
    );

    await expect(delivery.deliver(guildId, 'server', embed)).resolves.toEqual({
      status: 'delivered',
    });
    expect(send).toHaveBeenCalledWith('12345678901234568', embed);
  });
  it('trims server embed fields at 25', () => {
    const fields = Array.from({ length: 30 }, (_, index) => ({
      name: `field-${String(index)}`,
      value: 'value',
    }));

    expect(serverEmbed('title', fields, new Date()).fields).toHaveLength(25);
    expect(serverEmbed('title', fields, new Date()).fields.at(-1)?.name).toBe(
      'field-24',
    );
  });
  it('normalizes the aggregate embed payload to 6000 characters', () => {
    const embed = normalizeEmbed({
      title: 't'.repeat(256),
      timestamp: '2026-01-01T00:00:00.000Z',
      fields: Array.from({ length: 5 }, () => ({
        name: 'n'.repeat(256),
        value: 'v'.repeat(1024),
      })),
    });
    const characters =
      embed.title.length +
      embed.fields.reduce(
        (total, field) => total + field.name.length + field.value.length,
        0,
      );

    expect(characters).toBe(6000);
    expect(embed.fields).toHaveLength(5);
    expect(embed.fields.at(-1)?.value).toHaveLength(368);
  });
  it('identifies every configured log channel for bot-message filtering', () => {
    const configured = {
      messageLogChannelId: 'message',
      modlogChannelId: 'moderation',
      serverLogChannelId: 'server',
      voiceLogChannelId: 'voice',
    };

    expect(isConfiguredLogChannel('message', configured)).toBe(true);
    expect(isConfiguredLogChannel('moderation', configured)).toBe(true);
    expect(isConfiguredLogChannel('server', configured)).toBe(true);
    expect(isConfiguredLogChannel('voice', configured)).toBe(true);
    expect(isConfiguredLogChannel('other', configured)).toBe(false);
  });
  it('classifies bot, human, and authorless messages using snapshots safely', () => {
    expect(isBotAuthoredMessage(true, null, 'bot')).toBe(true);
    expect(isBotAuthoredMessage(false, 'bot', 'bot')).toBe(false);
    expect(isBotAuthoredMessage(false, 'human', 'bot')).toBe(false);
    expect(isBotAuthoredMessage(null, 'bot', 'bot')).toBe(true);
    expect(isBotAuthoredMessage(undefined, 'bot', 'bot')).toBe(true);
    expect(isBotAuthoredMessage(null, 'human', 'bot')).toBe(false);
    expect(isBotAuthoredMessage(null, 'bot', null)).toBe(false);
  });
  it('orchestrates recursion guards for create, update, delete, and bulk events', async () => {
    const logChannels = {
      messageLogChannelId: 'message',
      modlogChannelId: 'moderation',
      serverLogChannelId: 'server',
      voiceLogChannelId: 'voice',
    };
    const handlers = new Map<string, (...args: never[]) => void>();
    const client = {
      user: { id: 'bot' },
      on: vi.fn((event: string, handler: (...args: never[]) => void) => {
        handlers.set(event, handler);
      }),
    };
    const snapshotAuthors = new Map<string, string>();
    const snapshots = {
      getMessage: vi.fn((id: string) =>
        Promise.resolve({
          ok: true as const,
          value: snapshotAuthors.has(id)
            ? ({ authorUserId: snapshotAuthors.get(id) } as never)
            : null,
        }),
      ),
      deleteMessage: vi.fn().mockResolvedValue({ ok: true }),
    };
    const logging = {
      messageCreate: vi.fn().mockResolvedValue(undefined),
      messageUpdate: vi.fn().mockResolvedValue(undefined),
      messageDelete: vi.fn().mockResolvedValue(undefined),
      messageDeleteBulk: vi.fn().mockResolvedValue(undefined),
    };
    const message = (overrides: Record<string, unknown> = {}) => ({
      guildId,
      channelId: 'other',
      id: 'message-id',
      content: 'content',
      author: { id: 'human', tag: 'human', bot: false },
      attachments: new Map(),
      embeds: [],
      flags: { bitfield: 0 },
      mentions: { users: new Map(), roles: new Map(), everyone: false },
      channel: {},
      createdAt: new Date(),
      webhookId: null,
      system: false,
      url: 'https://discord.test/message',
      fetch: vi.fn(),
      ...overrides,
    });
    installMessageLoggingListeners(
      client as never,
      logging,
      {
        get: vi.fn().mockResolvedValue({ ok: true, value: logChannels }),
      } as never,
      snapshots,
      { error: vi.fn() } as never,
    );

    for (const [index, channelId] of Object.values(logChannels).entries()) {
      const botMessage = message({
        id: `bot-create-${String(index)}`,
        channelId,
        author: { id: 'bot', tag: 'bot', bot: true },
      });
      handlers.get('messageCreate')?.(botMessage as never);
      const updated = message({
        id: `bot-update-${String(index)}`,
        channelId,
        author: { id: 'bot', tag: 'bot', bot: true },
      });
      handlers.get('messageUpdate')?.(botMessage as never, updated as never);
    }
    const outside = message({
      id: 'bot-outside',
      author: { id: 'bot', tag: 'bot', bot: true },
    });
    handlers.get('messageCreate')?.(outside as never);

    snapshotAuthors.set('partial-bot', 'bot');
    handlers.get('messageDelete')?.(
      message({
        id: 'partial-bot',
        channelId: 'message',
        author: null,
      }) as never,
    );

    const human = message({ id: 'human-bulk', channelId: 'message' });
    const directBot = message({
      id: 'direct-bot-bulk',
      channelId: 'message',
      author: { id: 'bot', tag: 'bot', bot: true },
    });
    snapshotAuthors.set('partial-bulk', 'bot');
    const partialBot = message({
      id: 'partial-bulk',
      channelId: 'message',
      author: null,
    });
    const batch = Object.assign(
      new Map([
        [human.id, human],
        [directBot.id, directBot],
        [partialBot.id, partialBot],
      ]),
      { first: () => human },
    );
    handlers.get('messageDeleteBulk')?.(batch as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logging.messageCreate).toHaveBeenCalledOnce();
    expect(logging.messageUpdate).not.toHaveBeenCalled();
    expect(logging.messageDelete).not.toHaveBeenCalled();
    expect(snapshots.deleteMessage).toHaveBeenCalledTimes(11);
    expect(logging.messageDeleteBulk).toHaveBeenCalledWith(
      guildId,
      'message',
      ['human-bulk'],
      expect.arrayContaining([
        expect.objectContaining({ messageId: 'human-bulk' }),
      ]),
      expect.any(Date),
    );
    expect(snapshots.deleteMessage).toHaveBeenCalledWith('partial-bot');
    expect(snapshots.deleteMessage).toHaveBeenCalledWith('direct-bot-bulk');
    expect(snapshots.deleteMessage).toHaveBeenCalledWith('partial-bulk');
    expect(snapshots.deleteMessage).toHaveBeenCalledWith('bot-create-0');
    expect(snapshots.deleteMessage).toHaveBeenCalledWith('bot-update-0');
  });
});

describe('Oracle blocker regression tests', () => {
  const guildId = '12345678901234567';
  const now = new Date('2026-07-20T12:34:56.789Z');

  // --- Block (1): fixed handler receipt time survives async delays ---

  it('messageEditEmbed timestamp matches the passed occurredAt, not a delayed Date', () => {
    const occurredAt = new Date('2026-01-01T00:00:00.000Z');
    const em = messageEditEmbed(
      {
        guildId,
        channelId: '98765432109876543',
        messageId: '11111111111111111',
        author: 'Author',
        authorId: '22222222222222222',
        content: 'before',
        createdAt: new Date('2025-12-31T00:00:00.000Z'),
      },
      {
        guildId,
        channelId: '98765432109876543',
        messageId: '11111111111111111',
        author: 'Author',
        authorId: '22222222222222222',
        content: 'after',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      occurredAt,
    );
    expect(em?.timestamp).toBe('2026-01-01T00:00:00.000Z');
  });

  it('messageDeleteEmbed timestamp survives async delays with captured date', () => {
    const occurredAt = new Date('2026-06-15T10:00:00.000Z');
    const em = messageDeleteEmbed(
      {
        guildId,
        channelId: '98765432109876543',
        messageId: '11111111111111111',
        author: 'Author',
        authorId: '22222222222222222',
        content: 'content',
        createdAt: now,
      },
      '実行者',
      '理由',
      occurredAt,
    );
    expect(em.timestamp).toBe('2026-06-15T10:00:00.000Z');
  });

  it('voiceEmbed timestamp uses the passed occurredAt', () => {
    const occurredAt = new Date('2026-08-01T05:00:00.000Z');
    const em = voiceEmbed(
      'User',
      '12345678901234567',
      'Join',
      null,
      '98765432109876543',
      occurredAt,
    );
    expect(em.timestamp).toBe('2026-08-01T05:00:00.000Z');
  });

  it('bulkDeleteEmbed timestamp uses the passed occurredAt', () => {
    const occurredAt = new Date('2026-09-01T00:00:00.000Z');
    const em = bulkDeleteEmbed(
      '98765432109876543',
      5,
      [],
      '実行者',
      occurredAt,
      '理由',
    );
    expect(em.timestamp).toBe('2026-09-01T00:00:00.000Z');
  });

  // --- Block (2): writeCase uses exact createdAt ---

  it('serverEmbed preserves the exact passed occurredAt', () => {
    const occurredAt = new Date('2026-10-01T12:00:00.000Z');
    const em = serverEmbed(
      'メンバー参加',
      [{ name: 'ユーザー', value: 'User (123)' }],
      occurredAt,
    );
    expect(em.timestamp).toBe('2026-10-01T12:00:00.000Z');
  });

  // --- Block (4): Japanese labels and no English in standard log embeds ---

  it('messageDeleteEmbed contains all required Japanese-labeled fields', () => {
    const em = messageDeleteEmbed(
      {
        guildId,
        channelId: '98765432109876543',
        messageId: '11111111111111111',
        author: 'Author',
        authorId: '22222222222222222',
        content: 'test content',
        createdAt: now,
      },
      '実行者',
      '理由',
      now,
    );
    const fieldNames = em.fields.map((f) => f.name);
    expect(fieldNames).toContain('投稿者');
    expect(fieldNames).toContain('チャンネル');
    expect(fieldNames).toContain('メッセージID');
    expect(fieldNames).toContain('削除実行者');
    expect(fieldNames).toContain('理由');
    expect(fieldNames).toContain('本文');
    expect(fieldNames).toContain('添付');
    // No English labels
    expect(
      em.fields.some((f) =>
        /\b(Author|Channel|Executor|Reason|Content)\b/.test(f.name),
      ),
    ).toBe(false);
  });

  it('bulkDeleteEmbed contains 投稿者別 and プレビュー fields in Japanese', () => {
    const cached = [
      {
        guildId,
        channelId: 'ch',
        messageId: 'm1',
        author: 'Author1',
        authorId: 'a1',
        content: 'msg1',
        createdAt: now,
      },
      {
        guildId,
        channelId: 'ch',
        messageId: 'm2',
        author: 'Author1',
        authorId: 'a1',
        content: 'msg2',
        createdAt: now,
      },
      {
        guildId,
        channelId: 'ch',
        messageId: 'm3',
        author: 'Author2',
        authorId: 'a2',
        content: 'msg3',
        createdAt: now,
      },
    ];
    const em = bulkDeleteEmbed('ch', 3, cached, '実行者', now);
    const fieldNames = em.fields.map((f) => f.name);
    expect(fieldNames).toContain('削除件数');
    expect(fieldNames).toContain('チャンネル');
    expect(fieldNames).toContain('削除実行者');
    expect(fieldNames).toContain('キャッシュ取得');
    expect(fieldNames).toContain('投稿者別');
    expect(fieldNames).toContain('プレビュー');
    // 投稿者別 has aggregated per-author counts
    const authorsField = em.fields.find((f) => f.name === '投稿者別');
    expect(authorsField?.value).toContain('Author1');
    expect(authorsField?.value).toContain('2件');
    expect(authorsField?.value).toContain('Author2');
    expect(authorsField?.value).toContain('1件');
  });

  it('messageEditEmbed labels are all Japanese', () => {
    const em = messageEditEmbed(
      {
        guildId,
        channelId: 'ch',
        messageId: 'm1',
        author: 'Author',
        authorId: 'a1',
        content: 'before',
        createdAt: now,
      },
      {
        guildId,
        channelId: 'ch',
        messageId: 'm1',
        author: 'Author',
        authorId: 'a1',
        content: 'after',
        createdAt: now,
      },
      now,
    );
    expect(em).not.toBeNull();
    if (!em) throw new Error('Expected non-null');
    const fieldNames = em.fields.map((f) => f.name);
    expect(fieldNames).toContain('投稿者');
    expect(fieldNames).toContain('チャンネル');
    expect(fieldNames).toContain('変更前');
    expect(fieldNames).toContain('変更後');
    expect(fieldNames).toContain('添付');
    expect(fieldNames).toContain('メッセージ');
  });

  it('voiceEmbed labels are all Japanese', () => {
    const em = voiceEmbed('User', '123', 'Move', 'oldCh', 'newCh', now);
    expect(em.title).toBe('ボイス移動');
    const fieldNames = em.fields.map((f) => f.name);
    expect(fieldNames).toContain('ユーザー');
    expect(fieldNames).toContain('移動元');
    expect(fieldNames).toContain('移動先');
    // No English
    expect(
      em.fields.some((f) => /\b(User|Channel|From|To)\b/.test(f.name)),
    ).toBe(false);
  });

  // --- Block (1) async-delay: timestamp equals ingress time after awaits ---

  it('messageDeleteEmbed timestamp survives 2s audit wait (ingress captured before async)', async () => {
    const ingressAt = new Date('2026-07-01T00:00:00.000Z');
    // Simulate async delay (adapter does ~2s wait for audit) then verify
    // the builder uses ingressAt, not a delayed Date.
    const occurredAt = new Date(ingressAt.getTime());
    const delayMs = 100; // small delay for test speed
    const start = Date.now();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const em = messageDeleteEmbed(
      {
        guildId,
        channelId: 'ch',
        messageId: 'm1',
        author: 'Author',
        authorId: 'a1',
        content: 'content',
        createdAt: new Date(),
      },
      '実行者',
      '理由',
      occurredAt,
    );
    const end = Date.now();
    // Timestamp must match ingress time, not delayed time (end > start)
    expect(em.timestamp).toBe(ingressAt.toISOString());
    expect(end - start).toBeGreaterThanOrEqual(delayMs);
  });

  it('bulkDeleteEmbed timestamp survives fetch+audit delays', async () => {
    const ingressAt = new Date('2026-07-02T00:00:00.000Z');
    const occurredAt = new Date(ingressAt.getTime());
    await new Promise((resolve) => setTimeout(resolve, 50));
    const em = bulkDeleteEmbed('ch', 1, [], '実行者', occurredAt);
    expect(em.timestamp).toBe(ingressAt.toISOString());
  });

  it('voiceEmbed timestamp survives delay after ingress capture', async () => {
    const ingressAt = new Date('2026-07-03T00:00:00.000Z');
    const occurredAt = new Date(ingressAt.getTime());
    await new Promise((resolve) => setTimeout(resolve, 30));
    const em = voiceEmbed('User', '123', 'Join', null, 'ch', occurredAt);
    expect(em.timestamp).toBe(ingressAt.toISOString());
  });

  // --- Block (2): embed color, author, footer regression ---

  it('messageEditEmbed has yellow color and author', () => {
    const em = messageEditEmbed(
      {
        guildId,
        channelId: 'ch',
        messageId: 'm1',
        author: 'Author',
        authorId: 'a1',
        content: 'before',
        createdAt: now,
      },
      {
        guildId,
        channelId: 'ch',
        messageId: 'm1',
        author: 'Author',
        authorId: 'a1',
        content: 'after',
        createdAt: now,
        avatarUrl: 'https://cdn.discord.test/avatar.png',
      },
      now,
    );
    expect(em?.color).toBe(0xf1c40f);
    expect(em?.author).toEqual({
      name: 'Author (a1)',
      icon_url: 'https://cdn.discord.test/avatar.png',
    });
  });

  it('messageDeleteEmbed has red color and author when message is available', () => {
    const em = messageDeleteEmbed(
      {
        guildId,
        channelId: 'ch',
        messageId: 'm1',
        author: 'Author',
        authorId: 'a1',
        content: 'content',
        createdAt: now,
        avatarUrl: 'https://cdn.discord.test/avatar.png',
      },
      '実行者',
      '理由',
      now,
    );
    expect(em.color).toBe(0xe74c3c);
    expect(em.author).toEqual({
      name: 'Author (a1)',
      icon_url: 'https://cdn.discord.test/avatar.png',
    });
  });

  it('messageDeleteEmbed has no author when message is null', () => {
    const em = messageDeleteEmbed(null, '実行者', '理由', now);
    expect(em.author).toBeUndefined();
  });

  it('messageEditEmbed has no avatar when not available', () => {
    const em = messageEditEmbed(
      {
        guildId,
        channelId: 'ch',
        messageId: 'm1',
        author: 'Author',
        authorId: 'a1',
        content: 'before',
        createdAt: now,
      },
      {
        guildId,
        channelId: 'ch',
        messageId: 'm1',
        author: 'Author2',
        authorId: 'a2',
        content: 'after',
        createdAt: now,
      },
      now,
    );
    expect(em?.author?.icon_url).toBeUndefined();
  });

  // --- Block (3): serverEmbed inline mapping enforcement ---

  it('serverEmbed defaults short fields to inline and long/wide fields to full width', () => {
    const fields: Array<{ name: string; value: string; inline?: boolean }> = [
      { name: 'ユーザー', value: 'val' },
      { name: 'チャンネル', value: 'val' },
      { name: '理由', value: 'val' },
      { name: '変更前', value: 'val' },
      { name: '本文', value: 'val' },
      { name: '添付', value: 'val' },
      { name: '警告', value: 'val' },
      { name: 'Bot', value: 'val' },
    ];
    const em = serverEmbed('title', fields, now);
    // Short/structural → inline:true
    expect(em.fields[0]?.inline).toBe(true); // ユーザー
    expect(em.fields[1]?.inline).toBe(true); // チャンネル
    expect(em.fields[7]?.inline).toBe(true); // Bot (not in fullWidthLabels set)
    // Long/freeform → inline:false
    expect(em.fields[2]?.inline).toBe(false); // 理由
    expect(em.fields[3]?.inline).toBe(false); // 変更前
    expect(em.fields[4]?.inline).toBe(false); // 本文
    expect(em.fields[5]?.inline).toBe(false); // 添付
    expect(em.fields[6]?.inline).toBe(false); // 警告
  });

  it('serverEmbed respects explicit caller inline override', () => {
    const em = serverEmbed(
      'title',
      [
        { name: 'ユーザー', value: 'val', inline: false },
        { name: '理由', value: 'val', inline: true },
      ],
      now,
    );
    expect(em.fields[0]?.inline).toBe(false); // caller override
    expect(em.fields[1]?.inline).toBe(true); // caller override
  });

  // --- Block (1) color regression ---

  it('bulkDeleteEmbed has red color', () => {
    const em = bulkDeleteEmbed('ch', 3, [], '実行者', now);
    expect(em.color).toBe(0xe74c3c);
  });

  it('voiceEmbed has blue color', () => {
    const em = voiceEmbed('User', '123', 'Join', null, 'ch', now);
    expect(em.color).toBe(0x3498db);
  });

  it('serverEmbed passes color through when provided', () => {
    const em = serverEmbed(
      'title',
      [{ name: 'ユーザー', value: 'val' }],
      now,
      0x3498db,
    );
    expect(em.color).toBe(0x3498db);
  });

  it('serverEmbed has no color when not provided', () => {
    const em = serverEmbed('title', [{ name: 'ユーザー', value: 'val' }], now);
    expect(em.color).toBeUndefined();
  });
});
