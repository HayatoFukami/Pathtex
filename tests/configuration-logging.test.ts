import { describe, expect, it, vi } from 'vitest';
import {
  ConfigurationOverviewError,
  ConfigurationService,
  formatGuildTime,
} from '../src/features/configuration/service.js';
import { serviceSettingsText } from '../src/features/configuration/commands.js';
import {
  installGatewayListeners,
  installMessageLoggingListeners,
  matchMessageDeleteAudit,
} from '../src/index.js';
import { MessageLaneQueue } from '../src/features/logging/message-queue.js';
import {
  classifyVoice,
  isBotAuthoredMessage,
  isConfiguredLogChannel,
  isUnauthorized,
  LogDeliveryService,
  LogEmbedSchema,
  LoggingEventAdapter,
  LoggingEventPipeline,
  messageChanged,
  messageEditEmbed,
  messageDeleteEmbed,
  bulkDeleteEmbed,
  voiceEmbed,
  normalizeEmbed,
  serverEmbed,
  type MessageView,
} from '../src/features/logging/index.js';
import type { MemberSnapshotDto } from '../src/repositories/contracts.js';
import { PrismaSnapshotRepository } from '../src/repositories/prisma-repositories.js';

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
      vi.fn(),
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

describe('Phase 1A logging fixes', () => {
  const guildId = '12345678901234567';
  const channelId = '98765432109876543';
  const now = new Date('2026-07-20T12:34:56.789Z');
  const noWait = (): Promise<void> => Promise.resolve();
  const view = (overrides: Partial<MessageView> = {}): MessageView => ({
    guildId,
    channelId,
    messageId: '11111111111111111',
    author: 'Author',
    authorId: '22222222222222222',
    content: 'hello',
    createdAt: now,
    ...overrides,
  });

  // --- Fix 1: audit lookup failure must not block delivery (except 401) ---

  it('messageDelete continues with unknown executor when audit lookup fails (non-401)', async () => {
    const findMessageDelete = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('audit backend error'), { status: 500 }),
      );
    const adapter = new LoggingEventAdapter({ findMessageDelete }, noWait);

    const embed = await adapter.messageDelete(view(), now);

    expect(findMessageDelete).toHaveBeenCalledOnce();
    expect(embed.fields.find((f) => f.name === '削除実行者')?.value).toBe(
      '不明',
    );
  });

  it('bulkDelete continues with unknown executor when audit lookup fails (non-401)', async () => {
    const findMessageDelete = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('audit backend error'), { status: 503 }),
      );
    const adapter = new LoggingEventAdapter({ findMessageDelete }, noWait);

    const embed = await adapter.bulkDelete(
      guildId,
      channelId,
      ['m1', 'm2'],
      [],
      now,
    );

    expect(embed.fields.find((f) => f.name === '削除実行者')?.value).toBe(
      '不明',
    );
  });

  it('messageDelete propagates a fatal 401 from audit lookup', async () => {
    const unauthorized = Object.assign(new Error('unauthorized'), {
      status: 401,
    });
    const findMessageDelete = vi.fn().mockRejectedValue(unauthorized);
    const adapter = new LoggingEventAdapter({ findMessageDelete }, noWait);

    await expect(adapter.messageDelete(view(), now)).rejects.toBe(unauthorized);
  });

  it('bulkDelete propagates a fatal 401 from audit lookup', async () => {
    const unauthorized = Object.assign(new Error('unauthorized'), {
      status: 401,
    });
    const findMessageDelete = vi.fn().mockRejectedValue(unauthorized);
    const adapter = new LoggingEventAdapter({ findMessageDelete }, noWait);

    await expect(
      adapter.bulkDelete(guildId, channelId, ['m1'], [], now),
    ).rejects.toBe(unauthorized);
  });

  // --- Fix 2: audit matching uses the captured gateway receipt occurredAt ---

  it('messageDelete forwards the captured occurredAt to the audit port', async () => {
    const occurredAt = new Date('2026-07-01T00:00:00.000Z');
    const findMessageDelete = vi.fn().mockResolvedValue(null);
    const adapter = new LoggingEventAdapter({ findMessageDelete }, noWait);

    await adapter.messageDelete(view(), occurredAt);

    expect(findMessageDelete).toHaveBeenCalledWith(
      guildId,
      channelId,
      ['11111111111111111'],
      '22222222222222222',
      occurredAt,
    );
  });

  it('bulkDelete forwards the captured occurredAt to the audit port', async () => {
    const occurredAt = new Date('2026-07-02T00:00:00.000Z');
    const findMessageDelete = vi.fn().mockResolvedValue(null);
    const adapter = new LoggingEventAdapter({ findMessageDelete }, noWait);

    await adapter.bulkDelete(guildId, channelId, ['m1', 'm2'], [], occurredAt);

    expect(findMessageDelete).toHaveBeenCalledWith(
      guildId,
      channelId,
      ['m1', 'm2'],
      undefined,
      occurredAt,
    );
  });

  // --- Fix 3: persisted before-snapshots lacking flags/mentions ---

  it('does not treat a persisted before-snapshot lacking flags/mentions as an edit', () => {
    const before = view({ content: 'same', attachments: [], embeds: [] });
    const after = view({
      content: 'same',
      attachments: [],
      embeds: [],
      flags: 0,
      mentions: [{ id: 'u1', bot: false }],
      roleMentions: ['r1'],
      everyoneMentioned: false,
    });

    expect(messageChanged(before, after)).toBe(false);
    expect(messageEditEmbed(before, after, now)).toBeNull();
  });

  it('still detects content, attachment, and major embed changes', () => {
    const base = view({ content: 'x', attachments: [], embeds: [] });

    expect(messageChanged(base, view({ ...base, content: 'y' }))).toBe(true);
    expect(
      messageChanged(base, view({ ...base, attachments: [{ url: 'u' }] })),
    ).toBe(true);
    expect(
      messageChanged(base, view({ ...base, embeds: [{ title: 't' }] })),
    ).toBe(true);
  });

  // --- Fix 4: valid non-empty, <=1024-char body/attachment fields ---

  it('renders a non-empty body for attachment-only deleted messages and passes strict validation', () => {
    const embed = messageDeleteEmbed(
      view({ content: '', attachments: ['https://cdn.discord.test/a.png'] }),
      '実行者',
      '理由',
      now,
    );

    expect(embed.fields.find((f) => f.name === '本文')?.value).toBe('(空)');
    expect(embed.fields.find((f) => f.name === '添付')?.value).toBe(
      'https://cdn.discord.test/a.png',
    );
    for (const field of embed.fields) {
      expect(field.value.length).toBeGreaterThan(0);
      expect(field.value.length).toBeLessThanOrEqual(1024);
    }
    expect(LogEmbedSchema.safeParse(embed).success).toBe(true);
  });

  it('bounds the attachment field to 1024 characters for many attachments', () => {
    const attachments = Array.from(
      { length: 30 },
      (_, index) =>
        `https://cdn.discord.test/attachment-${String(index)}-${'x'.repeat(60)}.png`,
    );
    const embed = messageDeleteEmbed(
      view({ content: 'content', attachments }),
      '実行者',
      '理由',
      now,
    );

    const field = embed.fields.find((f) => f.name === '添付');
    expect(field?.value.length).toBeGreaterThan(0);
    expect(field?.value.length).toBeLessThanOrEqual(1024);
    expect(LogEmbedSchema.safeParse(embed).success).toBe(true);
  });
});

describe('Phase 1 Oracle remediation', () => {
  const guildId = '12345678901234567';
  const channelId = '98765432109876543';
  const now = new Date('2026-07-20T12:34:56.789Z');

  // --- Blocker 1: audit reader compares against forwarded occurredAt ---

  it('matches a delete audit entry within ±5s of occurredAt even when far from Date.now()', () => {
    const occurredAt = new Date('2026-01-01T00:00:00.000Z');
    const entry = {
      action: '72',
      createdTimestamp: occurredAt.getTime() + 3_000,
      target: { id: 'author-1' },
      extra: { channel: { id: channelId }, count: 1 },
      executor: { tag: 'Mod#0001' },
      executorId: 'mod-1',
      reason: 'spam',
    };

    expect(
      matchMessageDeleteAudit(
        [entry],
        channelId,
        ['msg-1'],
        'author-1',
        occurredAt,
      ),
    ).toEqual({ executor: 'Mod#0001', reason: 'spam' });
  });

  it('rejects a delete audit entry outside the ±5s occurredAt window', () => {
    const occurredAt = new Date('2026-01-01T00:00:00.000Z');
    const entry = {
      action: '72',
      createdTimestamp: occurredAt.getTime() + 6_000,
      target: { id: 'author-1' },
      extra: { channel: { id: channelId }, count: 1 },
      executor: { tag: 'Mod#0001' },
      executorId: 'mod-1',
      reason: 'spam',
    };

    expect(
      matchMessageDeleteAudit(
        [entry],
        channelId,
        ['msg-1'],
        'author-1',
        occurredAt,
      ),
    ).toBeNull();
  });

  it('matches a bulk-delete audit entry by channel target and count within the window', () => {
    const occurredAt = new Date('2026-01-01T00:00:00.000Z');
    const entry = {
      action: '73',
      createdTimestamp: occurredAt.getTime() - 2_000,
      target: { id: channelId },
      extra: { channel: { id: channelId }, count: 2 },
      executor: { tag: 'Mod#0001' },
      executorId: 'mod-1',
      reason: 'clean',
    };

    expect(
      matchMessageDeleteAudit(
        [entry],
        channelId,
        ['m1', 'm2'],
        undefined,
        occurredAt,
      ),
    ).toEqual({ executor: 'Mod#0001', reason: 'clean' });
  });

  // --- Blocker 2: unauthorized detection + fatal wiring ---

  it('detects 401 via direct status, direct code, and exactly one cause layer', () => {
    expect(isUnauthorized({ status: 401 })).toBe(true);
    expect(isUnauthorized({ code: 401 })).toBe(true);
    expect(isUnauthorized({ cause: { status: 401 } })).toBe(true);
    expect(isUnauthorized({ cause: { code: 401 } })).toBe(true);
    expect(isUnauthorized({ status: 500 })).toBe(false);
    expect(isUnauthorized({ code: 500 })).toBe(false);
    expect(isUnauthorized({ cause: { cause: { status: 401 } } })).toBe(false);
    expect(isUnauthorized(null)).toBe(false);
    expect(isUnauthorized(undefined)).toBe(false);
    expect(isUnauthorized('401')).toBe(false);
  });

  const gatewayMessage = (): Record<string, unknown> => ({
    guildId,
    channelId: 'other',
    id: 'msg-1',
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
  });

  const installWithDeleteRejection = (rejection: unknown) => {
    const handlers = new Map<string, (...args: never[]) => void>();
    const client = {
      user: { id: 'bot' },
      on: vi.fn((event: string, handler: (...args: never[]) => void) => {
        handlers.set(event, handler);
      }),
    };
    const logging = {
      messageCreate: vi.fn().mockResolvedValue(undefined),
      messageUpdate: vi.fn().mockResolvedValue(undefined),
      messageDelete: vi.fn().mockRejectedValue(rejection),
      messageDeleteBulk: vi.fn().mockResolvedValue(undefined),
    };
    const snapshots = {
      getMessage: vi.fn().mockResolvedValue({ ok: true, value: null }),
      deleteMessage: vi.fn().mockResolvedValue({ ok: true }),
    };
    const logger = { error: vi.fn() };
    const fatal = vi.fn();
    installMessageLoggingListeners(
      client as never,
      logging,
      { get: vi.fn().mockResolvedValue({ ok: true, value: {} }) } as never,
      snapshots,
      logger as never,
      fatal,
    );
    return { handlers, logger, fatal };
  };

  it('routes a direct 401 from messageDelete to fatal instead of logging', async () => {
    const unauthorized = Object.assign(new Error('unauthorized'), {
      status: 401,
    });
    const { handlers, logger, fatal } =
      installWithDeleteRejection(unauthorized);

    handlers.get('messageDelete')?.(gatewayMessage() as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fatal).toHaveBeenCalledWith(unauthorized);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('routes a cause-wrapped 401 from messageDelete to fatal', async () => {
    const wrapped = Object.assign(new Error('wrapped'), {
      cause: { code: 401 },
    });
    const { handlers, logger, fatal } = installWithDeleteRejection(wrapped);

    handlers.get('messageDelete')?.(gatewayMessage() as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fatal).toHaveBeenCalledWith(wrapped);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('keeps non-401 messageDelete failures on the report/log fallback', async () => {
    const failure = Object.assign(new Error('boom'), { status: 500 });
    const { handlers, logger, fatal } = installWithDeleteRejection(failure);

    handlers.get('messageDelete')?.(gatewayMessage() as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fatal).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledOnce();
  });

  // --- Blocker 3: deterministic stable-key serialization ---

  const baseView: MessageView = {
    guildId,
    channelId,
    messageId: 'm1',
    author: 'A',
    authorId: 'a1',
    content: 'same',
    attachments: [],
    embeds: [],
    createdAt: now,
  };

  it('treats attachments/embeds with reordered object keys as unchanged', () => {
    const before: MessageView = {
      ...baseView,
      attachments: [{ url: 'u', filename: 'f', size: 1 }],
      embeds: [{ title: 't', description: 'd' }],
    };
    const after: MessageView = {
      ...baseView,
      attachments: [{ size: 1, filename: 'f', url: 'u' }],
      embeds: [{ description: 'd', title: 't' }],
    };

    expect(messageChanged(before, after)).toBe(false);
    expect(messageEditEmbed(before, after, now)).toBeNull();
  });

  it('retains array order so a reordered attachment list is still a change', () => {
    const before: MessageView = {
      ...baseView,
      attachments: [{ id: '1' }, { id: '2' }],
    };
    const after: MessageView = {
      ...baseView,
      attachments: [{ id: '2' }, { id: '1' }],
    };

    expect(messageChanged(before, after)).toBe(true);
  });

  it('still detects a real attachment value change under stable serialization', () => {
    const before: MessageView = {
      ...baseView,
      attachments: [{ url: 'u1', filename: 'f' }],
    };
    const after: MessageView = {
      ...baseView,
      attachments: [{ url: 'u2', filename: 'f' }],
    };

    expect(messageChanged(before, after)).toBe(true);
  });

  it('renders 添付 as なし for a content change with key-reordered-but-equal attachments', () => {
    const before: MessageView = {
      ...baseView,
      content: 'before',
      attachments: [{ url: 'u', filename: 'f' }],
    };
    const after: MessageView = {
      ...baseView,
      content: 'after',
      attachments: [{ filename: 'f', url: 'u' }],
    };

    const embed = messageEditEmbed(before, after, now);

    expect(embed).not.toBeNull();
    expect(embed?.fields.find((f) => f.name === '添付')?.value).toBe('なし');
  });
});

describe('Phase 2 per-message serialization', () => {
  const guildId = '12345678901234567';
  const flushMicrotasks = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

  // --- MessageLaneQueue unit behavior (deterministic deferred promises) ---

  it('runs same-message-ID tasks FIFO so a delete cannot overtake a prior delayed update', async () => {
    const queue = new MessageLaneQueue();
    const order: string[] = [];
    let resolveUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => {
      resolveUpdate = resolve;
    });

    const update = queue.run('msg-1', async () => {
      await updateGate;
      order.push('update');
    });
    const del = queue.run('msg-1', () => {
      order.push('delete');
      return Promise.resolve();
    });

    await flushMicrotasks();
    expect(order).toEqual([]);

    resolveUpdate();
    await Promise.all([update, del]);
    expect(order).toEqual(['update', 'delete']);
  });

  it('does not serialize independent message IDs together', async () => {
    const queue = new MessageLaneQueue();
    const events: string[] = [];
    let resolveA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      resolveA = resolve;
    });

    const a = queue.run('msg-A', async () => {
      await gateA;
      events.push('A');
    });
    const b = queue.run('msg-B', () => {
      events.push('B');
      return Promise.resolve();
    });

    await b;
    expect(events).toEqual(['B']);

    resolveA();
    await a;
    expect(events).toEqual(['B', 'A']);
  });

  it('does not poison later same-ID tasks when an earlier task fails', async () => {
    const queue = new MessageLaneQueue();
    const order: string[] = [];
    const failing = queue.run('msg-1', () => {
      order.push('fail');
      return Promise.reject(new Error('boom'));
    });
    const next = queue.run('msg-1', () => {
      order.push('next');
      return Promise.resolve();
    });

    await expect(failing).rejects.toThrow('boom');
    await next;
    expect(order).toEqual(['fail', 'next']);
  });

  it('cleans up lane state after the queue drains', async () => {
    const queue = new MessageLaneQueue();
    expect(queue.size).toBe(0);
    const done = queue.run('msg-1', () => Promise.resolve());
    expect(queue.size).toBe(1);
    await done;
    await flushMicrotasks();
    expect(queue.size).toBe(0);
  });

  it('runMany reserves each member lane and cannot deadlock with single-message handlers', async () => {
    const queue = new MessageLaneQueue();
    const order: string[] = [];
    let resolveDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });

    const single = queue.run('msg-1', async () => {
      await deleteGate;
      order.push('single-delete-msg-1');
    });
    const bulk = queue.runMany(['msg-1', 'msg-2'], () => {
      order.push('bulk');
      return Promise.resolve();
    });

    await flushMicrotasks();
    expect(order).toEqual([]);

    resolveDelete();
    await Promise.all([single, bulk]);
    expect(order).toEqual(['single-delete-msg-1', 'bulk']);
  });

  it('runMany executes the bulk task exactly once across multiple lanes', async () => {
    const queue = new MessageLaneQueue();
    let calls = 0;
    await queue.runMany(['a', 'b', 'c', 'a'], () => {
      calls += 1;
      return Promise.resolve();
    });
    expect(calls).toBe(1);
  });

  it('runMany propagates a bulk task failure to the caller', async () => {
    const queue = new MessageLaneQueue();
    await expect(
      queue.runMany(['a', 'b'], () => Promise.reject(new Error('bulk-fail'))),
    ).rejects.toThrow('bulk-fail');
  });

  it('runMany runs a synchronously throwing task exactly once, rejects callers, and keeps lanes usable', async () => {
    const queue = new MessageLaneQueue();
    let calls = 0;
    const throwingTask = (): Promise<void> => {
      calls += 1;
      throw new Error('sync-boom');
    };

    await expect(queue.runMany(['a', 'b', 'c'], throwingTask)).rejects.toThrow(
      'sync-boom',
    );
    // Exactly-once: the synchronous throw must not re-execute on other lanes.
    expect(calls).toBe(1);

    // Lanes drain and clean up even after the failure.
    await flushMicrotasks();
    expect(queue.size).toBe(0);

    // Subsequent work on the same keys remains usable.
    const order: string[] = [];
    await queue.run('a', () => {
      order.push('a-after');
      return Promise.resolve();
    });
    await queue.run('b', () => {
      order.push('b-after');
      return Promise.resolve();
    });
    expect(order).toEqual(['a-after', 'b-after']);
    await flushMicrotasks();
    expect(queue.size).toBe(0);
  });

  // --- Gateway listener wiring ---

  const gatewayMessage = (id: string): Record<string, unknown> => ({
    guildId,
    channelId: 'other',
    id,
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
  });

  const installListeners = (logging: Record<string, unknown>) => {
    const handlers = new Map<string, (...args: never[]) => void>();
    const client = {
      user: { id: 'bot' },
      on: vi.fn((event: string, handler: (...args: never[]) => void) => {
        handlers.set(event, handler);
      }),
    };
    const snapshots = {
      getMessage: vi.fn().mockResolvedValue({ ok: true, value: null }),
      deleteMessage: vi.fn().mockResolvedValue({ ok: true }),
    };
    const settings = {
      get: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    };
    const logger = { error: vi.fn() };
    const fatal = vi.fn();
    installMessageLoggingListeners(
      client as never,
      logging as never,
      settings as never,
      snapshots,
      logger as never,
      fatal,
    );
    return { handlers, snapshots, logger, fatal };
  };

  it('listener: messageDelete cannot overtake a prior delayed messageCreate for the same ID', async () => {
    const calls: string[] = [];
    let resolveCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      resolveCreate = resolve;
    });
    const logging = {
      messageCreate: vi.fn(async () => {
        await createGate;
        calls.push('create');
      }),
      messageUpdate: vi.fn().mockResolvedValue(undefined),
      messageDelete: vi.fn(() => {
        calls.push('delete');
        return Promise.resolve();
      }),
      messageDeleteBulk: vi.fn().mockResolvedValue(undefined),
    };
    const { handlers } = installListeners(logging);

    handlers.get('messageCreate')?.(gatewayMessage('msg-1') as never);
    handlers.get('messageDelete')?.(gatewayMessage('msg-1') as never);
    await flushMicrotasks();

    expect(calls).toEqual([]);

    resolveCreate();
    await flushMicrotasks();
    expect(calls).toEqual(['create', 'delete']);
  });

  it('listener: independent message IDs are processed concurrently, not serialized', async () => {
    const calls: string[] = [];
    let resolveA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      resolveA = resolve;
    });
    const logging = {
      messageCreate: vi.fn(async (view: { messageId: string }) => {
        if (view.messageId === 'msg-A') await gateA;
        calls.push(view.messageId);
      }),
      messageUpdate: vi.fn().mockResolvedValue(undefined),
      messageDelete: vi.fn().mockResolvedValue(undefined),
      messageDeleteBulk: vi.fn().mockResolvedValue(undefined),
    };
    const { handlers } = installListeners(logging);

    handlers.get('messageCreate')?.(gatewayMessage('msg-A') as never);
    handlers.get('messageCreate')?.(gatewayMessage('msg-B') as never);
    await flushMicrotasks();

    expect(calls).toEqual(['msg-B']);

    resolveA();
    await flushMicrotasks();
    expect(calls).toEqual(['msg-B', 'msg-A']);
  });

  it('listener: bulk delete joins per-message lanes and waits for an in-flight create on a shared ID', async () => {
    const calls: string[] = [];
    let resolveCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      resolveCreate = resolve;
    });
    const logging = {
      messageCreate: vi.fn(async () => {
        await createGate;
        calls.push('create');
      }),
      messageUpdate: vi.fn().mockResolvedValue(undefined),
      messageDelete: vi.fn().mockResolvedValue(undefined),
      messageDeleteBulk: vi.fn(() => {
        calls.push('bulk');
        return Promise.resolve();
      }),
    };
    const { handlers } = installListeners(logging);

    handlers.get('messageCreate')?.(gatewayMessage('msg-1') as never);
    const m1 = gatewayMessage('msg-1');
    const m2 = gatewayMessage('msg-2');
    const batch = Object.assign(
      new Map([
        [m1.id, m1],
        [m2.id, m2],
      ]),
      { first: () => m1 },
    );
    handlers.get('messageDeleteBulk')?.(batch as never);
    await flushMicrotasks();

    expect(calls).toEqual([]);

    resolveCreate();
    await flushMicrotasks();
    expect(calls).toEqual(['create', 'bulk']);
  });
});

describe('Phase 3 gateway message intake fixes', () => {
  const guildId = '12345678901234567';
  const pathtexId = 'pathtex-bot';
  const flush = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

  const logChannels = {
    messageLogChannelId: 'message',
    modlogChannelId: 'moderation',
    serverLogChannelId: 'server',
    voiceLogChannelId: 'voice',
  };

  const message = (overrides: Record<string, unknown> = {}) => ({
    guildId,
    channelId: 'other',
    id: 'message-id',
    content: 'content',
    author: { id: 'human', tag: 'human#0', bot: false },
    attachments: new Map(),
    embeds: [],
    flags: { bitfield: 0 },
    mentions: { users: new Map(), roles: new Map(), everyone: false },
    channel: {},
    createdAt: new Date('2026-07-20T00:00:00.000Z'),
    webhookId: null,
    system: false,
    url: 'https://discord.test/message',
    partial: false,
    fetch: vi.fn(),
    ...overrides,
  });

  const install = (snapshotAuthors = new Map<string, string>()) => {
    const handlers = new Map<string, (...args: never[]) => void>();
    const client = {
      user: { id: pathtexId },
      on: vi.fn((event: string, handler: (...args: never[]) => void) => {
        handlers.set(event, handler);
      }),
    };
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
    const logger = { error: vi.fn() };
    const fatal = vi.fn();
    installMessageLoggingListeners(
      client as never,
      logging,
      {
        get: vi.fn().mockResolvedValue({ ok: true, value: logChannels }),
      } as never,
      snapshots,
      logger as never,
      fatal,
    );
    return { handlers, snapshots, logging, logger, fatal };
  };

  // --- (1) Recursive-log filtering suppresses only Pathtex's own messages ---

  it('logs another bot message in a configured log channel instead of filtering it', async () => {
    const { handlers, logging, snapshots } = install();

    handlers.get('messageCreate')?.(
      message({
        id: 'other-bot',
        channelId: 'message',
        author: { id: 'other-bot', tag: 'other#0', bot: true },
      }) as never,
    );
    await flush();

    expect(logging.messageCreate).toHaveBeenCalledOnce();
    expect(snapshots.deleteMessage).not.toHaveBeenCalled();
  });

  it('logs a webhook message in a configured log channel instead of filtering it', async () => {
    const { handlers, logging, snapshots } = install();

    handlers.get('messageCreate')?.(
      message({
        id: 'webhook-msg',
        channelId: 'message',
        webhookId: 'webhook-1',
        author: { id: 'webhook-user', tag: 'webhook#0', bot: false },
      }) as never,
    );
    await flush();

    expect(logging.messageCreate).toHaveBeenCalledOnce();
    expect(snapshots.deleteMessage).not.toHaveBeenCalled();
  });

  it('suppresses only Pathtex own log message in a configured log channel', async () => {
    const { handlers, logging, snapshots } = install();

    handlers.get('messageCreate')?.(
      message({
        id: 'pathtex-own',
        channelId: 'message',
        author: { id: pathtexId, tag: 'pathtex#0', bot: true },
      }) as never,
    );
    await flush();

    expect(logging.messageCreate).not.toHaveBeenCalled();
    expect(snapshots.deleteMessage).toHaveBeenCalledWith('pathtex-own');
  });

  it('suppresses a partial message whose snapshot author is Pathtex', async () => {
    const { handlers, logging, snapshots } = install(
      new Map([['partial-self', pathtexId]]),
    );

    handlers.get('messageDelete')?.(
      message({
        id: 'partial-self',
        channelId: 'message',
        author: null,
      }) as never,
    );
    await flush();

    expect(logging.messageDelete).not.toHaveBeenCalled();
    expect(snapshots.deleteMessage).toHaveBeenCalledWith('partial-self');
  });

  it('logs a partial message whose snapshot author is another bot', async () => {
    const { handlers, logging, snapshots } = install(
      new Map([['partial-other', 'other-bot']]),
    );

    handlers.get('messageDelete')?.(
      message({
        id: 'partial-other',
        channelId: 'message',
        author: null,
      }) as never,
    );
    await flush();

    expect(logging.messageDelete).toHaveBeenCalledOnce();
    expect(snapshots.deleteMessage).not.toHaveBeenCalled();
  });

  // --- (2) messageUpdate avoids an unconditional REST fetch ---

  it('uses a complete after payload directly without a REST fetch', async () => {
    const { handlers, logging } = install();
    const fetch = vi.fn();
    const before = message({ id: 'msg-1', content: 'before' });
    const after = message({
      id: 'msg-1',
      content: 'after',
      partial: false,
      fetch,
    });

    handlers.get('messageUpdate')?.(before as never, after as never);
    await flush();

    expect(fetch).not.toHaveBeenCalled();
    expect(logging.messageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'before' }),
      expect.objectContaining({ content: 'after', messageId: 'msg-1' }),
      expect.any(Date),
    );
  });

  it('fetches a partial after payload and logs the fetched view', async () => {
    const { handlers, logging } = install();
    const fetched = message({ id: 'msg-1', content: 'fetched-content' });
    const fetch = vi.fn().mockResolvedValue(fetched);
    const before = message({ id: 'msg-1', content: 'before' });
    const after = message({
      id: 'msg-1',
      content: '',
      author: null,
      partial: true,
      fetch,
    });

    handlers.get('messageUpdate')?.(before as never, after as never);
    await flush();

    expect(fetch).toHaveBeenCalledOnce();
    expect(logging.messageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'before' }),
      expect.objectContaining({ content: 'fetched-content' }),
      expect.any(Date),
    );
  });

  it('falls back to a sufficient partial view when the fetch fails', async () => {
    const { handlers, logging, logger } = install();
    const fetch = vi.fn().mockRejectedValue(new Error('network down'));
    const before = message({ id: 'msg-1', content: 'before' });
    const after = message({
      id: 'msg-1',
      content: 'partial-content',
      partial: true,
      fetch,
    });

    handlers.get('messageUpdate')?.(before as never, after as never);
    await flush();

    expect(fetch).toHaveBeenCalledOnce();
    expect(logging.messageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'before' }),
      expect.objectContaining({ content: 'partial-content' }),
      expect.any(Date),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('reports the error when the fetch fails and the partial view is insufficient', async () => {
    const { handlers, logging, logger, fatal } = install();
    const fetch = vi.fn().mockRejectedValue(new Error('network down'));
    const before = message({ id: 'msg-1', content: 'before' });
    const after = message({
      id: 'msg-1',
      content: '',
      author: null,
      partial: true,
      fetch,
    });

    handlers.get('messageUpdate')?.(before as never, after as never);
    await flush();

    expect(fetch).toHaveBeenCalledOnce();
    expect(logging.messageUpdate).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledOnce();
    expect(fatal).not.toHaveBeenCalled();
  });

  it('routes a 401 fetch failure on a partial update to fatal', async () => {
    const { handlers, logging, logger, fatal } = install();
    const fetchError = Object.assign(new Error('unauthorized'), {
      status: 401,
    });
    const fetch = vi.fn().mockRejectedValue(fetchError);
    const before = message({ id: 'msg-1', content: 'before' });
    const after = message({
      id: 'msg-1',
      content: '',
      author: null,
      partial: true,
      fetch,
    });

    handlers.get('messageUpdate')?.(before as never, after as never);
    await flush();

    expect(fatal).toHaveBeenCalledWith(fetchError);
    expect(logging.messageUpdate).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  // --- Oracle remediation regressions ---

  it('routes a 401 fetch failure to fatal even when the partial view is sufficient', async () => {
    const { handlers, logging, logger, fatal } = install();
    const fetchError = Object.assign(new Error('unauthorized'), {
      status: 401,
    });
    const fetch = vi.fn().mockRejectedValue(fetchError);
    const before = message({ id: 'msg-1', content: 'before' });
    // Sufficient partial (author + content present): a naive fallback would mask
    // the 401, so the auth failure must be rethrown before any fallback view.
    const after = message({
      id: 'msg-1',
      content: 'partial-content',
      partial: true,
      fetch,
    });

    handlers.get('messageUpdate')?.(before as never, after as never);
    await flush();

    expect(fatal).toHaveBeenCalledWith(fetchError);
    expect(logging.messageUpdate).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('re-applies the recursion guard after a partial fetch reveals Pathtex own message', async () => {
    const { handlers, logging, snapshots } = install();
    // The authoritative fetched payload is Pathtex's own message in a log channel.
    const fetched = message({
      id: 'msg-1',
      channelId: 'message',
      content: 'pathtex log line',
      author: { id: pathtexId, tag: 'pathtex#0', bot: true },
    });
    const fetch = vi.fn().mockResolvedValue(fetched);
    const before = message({ id: 'msg-1', content: 'before' });
    // Partial in the log channel with no cached author and no snapshot author, so
    // the initial guard cannot yet identify it as Pathtex's own message.
    const after = message({
      id: 'msg-1',
      channelId: 'message',
      content: '',
      author: null,
      partial: true,
      fetch,
    });

    handlers.get('messageUpdate')?.(before as never, after as never);
    await flush();

    expect(fetch).toHaveBeenCalledOnce();
    expect(snapshots.deleteMessage).toHaveBeenCalledWith('msg-1');
    expect(logging.messageUpdate).not.toHaveBeenCalled();
  });

  it('rejects an author-present/content-null partial fallback as insufficient', async () => {
    const { handlers, logging, logger, fatal } = install();
    const fetch = vi.fn().mockRejectedValue(new Error('network down'));
    const before = message({ id: 'msg-1', content: 'before' });
    // Author present but content null: must not become a usable fallback view.
    const after = message({
      id: 'msg-1',
      content: null,
      partial: true,
      fetch,
    });

    handlers.get('messageUpdate')?.(before as never, after as never);
    await flush();

    expect(fetch).toHaveBeenCalledOnce();
    expect(logging.messageUpdate).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledOnce();
    expect(fatal).not.toHaveBeenCalled();
  });
});

describe('Phase 4A userUpdate fanout', () => {
  const occurredAt = new Date('2026-07-20T12:34:56.789Z');
  const member = (
    overrides: Partial<MemberSnapshotDto> = {},
  ): MemberSnapshotDto => ({
    guildId: '111111111111111111',
    userId: '999999999999999999',
    username: 'oldname',
    globalName: 'oldglobal',
    nickname: null,
    joinedAt: null,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });
  const buildPipeline = (
    members: MemberSnapshotDto[],
    deliver?: unknown,
    logger?: unknown,
  ) => {
    const getMembersForUser = vi
      .fn()
      .mockResolvedValue({ ok: true, value: members });
    const saveMember = vi.fn().mockResolvedValue({ ok: true, value: {} });
    const snapshots = {
      saveMessage: vi.fn().mockResolvedValue({ ok: true, value: {} }),
      getMessage: vi.fn().mockResolvedValue({ ok: true, value: null }),
      getMessages: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      deleteMessage: vi.fn().mockResolvedValue({ ok: true }),
      deleteMessages: vi.fn().mockResolvedValue({ ok: true, value: 0 }),
      saveMember,
      getMembersForUser,
    };
    const pipeline = new LoggingEventPipeline({
      snapshots,
      events: {} as never,
      delivery: {
        deliver: deliver ?? vi.fn().mockResolvedValue({ status: 'delivered' }),
      } as never,
      timezone: vi.fn().mockResolvedValue('UTC'),
      logger: (logger ?? { error: vi.fn() }) as never,
    });
    return { pipeline, saveMember, getMembersForUser };
  };

  it('emits logs and saves for persisted memberships regardless of gateway cache', async () => {
    const members = [
      member({ guildId: '111111111111111111' }),
      member({ guildId: '222222222222222222' }),
    ];
    const deliver = vi.fn().mockResolvedValue({ status: 'delivered' });
    const { pipeline, saveMember } = buildPipeline(members, deliver);

    await pipeline.userUpdate(
      '999999999999999999',
      'newname',
      'oldglobal',
      occurredAt,
    );

    expect(deliver).toHaveBeenCalledTimes(2);
    const guilds = deliver.mock.calls.map((call) => call[0] as string);
    expect(guilds).toContain('111111111111111111');
    expect(guilds).toContain('222222222222222222');
    const titles = deliver.mock.calls.map(
      (call) => (call[2] as { title: string }).title,
    );
    expect(titles).toEqual(['ユーザー名変更', 'ユーザー名変更']);
    expect(saveMember).toHaveBeenCalledTimes(2);
  });

  it('limits concurrent per-guild processing to 5 for 6+ memberships', async () => {
    const members = Array.from({ length: 6 }, (_, index) =>
      member({ guildId: `10000000000000000${String(index)}` }),
    );
    let active = 0;
    let maxActive = 0;
    const deliver = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return { status: 'delivered' };
    });
    const { pipeline } = buildPipeline(members, deliver);

    await pipeline.userUpdate(
      '999999999999999999',
      'newname',
      'oldglobal',
      occurredAt,
    );

    expect(deliver).toHaveBeenCalledTimes(6);
    expect(maxActive).toBe(5);
  });

  it('preserves nickname and joinedAt when saving the updated snapshot', async () => {
    const joinedAt = new Date('2025-01-01T00:00:00.000Z');
    const members = [member({ guildId: 'g1', nickname: 'nick', joinedAt })];
    const deliver = vi.fn().mockResolvedValue({ status: 'delivered' });
    const { pipeline, saveMember } = buildPipeline(members, deliver);

    await pipeline.userUpdate(
      '999999999999999999',
      'newname',
      'newglobal',
      occurredAt,
    );

    expect(saveMember).toHaveBeenCalledWith({
      guildId: 'g1',
      userId: '999999999999999999',
      username: 'newname',
      globalName: 'newglobal',
      nickname: 'nick',
      joinedAt,
    });
  });

  it('emits ユーザー名変更 before グローバル表示名変更 with before/after and なし for null', async () => {
    const members = [
      member({ guildId: 'g1', username: 'oldname', globalName: null }),
    ];
    const deliver = vi.fn().mockResolvedValue({ status: 'delivered' });
    const { pipeline } = buildPipeline(members, deliver);

    await pipeline.userUpdate(
      '999999999999999999',
      'newname',
      'newglobal',
      occurredAt,
    );

    expect(deliver).toHaveBeenCalledTimes(2);
    const embeds = deliver.mock.calls.map(
      (call) =>
        call[2] as {
          title: string;
          fields: Array<{ name: string; value: string }>;
        },
    );
    expect(embeds[0]?.title).toBe('ユーザー名変更');
    expect(embeds[1]?.title).toBe('グローバル表示名変更');
    expect(embeds[0]?.fields.find((f) => f.name === '変更前')?.value).toBe(
      'oldname',
    );
    expect(embeds[0]?.fields.find((f) => f.name === '変更後')?.value).toBe(
      'newname',
    );
    expect(embeds[1]?.fields.find((f) => f.name === '変更前')?.value).toBe(
      'なし',
    );
    expect(embeds[1]?.fields.find((f) => f.name === '変更後')?.value).toBe(
      'newglobal',
    );
  });

  it('isolates a per-guild delivery failure so other guilds still get logs and saves', async () => {
    const members = [
      member({ guildId: 'gA' }),
      member({ guildId: 'gB' }),
      member({ guildId: 'gC' }),
    ];
    const deliver = vi.fn((guildId: string) => {
      if (guildId === 'gB') return Promise.reject(new Error('delivery down'));
      return Promise.resolve({ status: 'delivered' });
    });
    const logger = { error: vi.fn() };
    const { pipeline, saveMember } = buildPipeline(members, deliver, logger);

    await pipeline.userUpdate(
      '999999999999999999',
      'newname',
      'oldglobal',
      occurredAt,
    );

    const attempted = deliver.mock.calls.map((call) => call[0]);
    expect(attempted).toContain('gA');
    expect(attempted).toContain('gB');
    expect(attempted).toContain('gC');
    expect(logger.error).toHaveBeenCalled();
    const savedGuilds = saveMember.mock.calls.map(
      (call) => (call[0] as { guildId: string }).guildId,
    );
    expect(savedGuilds).toContain('gA');
    expect(savedGuilds).toContain('gC');
    expect(savedGuilds).not.toContain('gB');
  });

  it('propagates an authorization (401) failure instead of swallowing it', async () => {
    const members = [member({ guildId: 'gA' }), member({ guildId: 'gB' })];
    const unauthorized = Object.assign(new Error('unauthorized'), {
      status: 401,
    });
    const deliver = vi.fn((guildId: string) => {
      if (guildId === 'gB') return Promise.reject(unauthorized);
      return Promise.resolve({ status: 'delivered' });
    });
    const { pipeline } = buildPipeline(members, deliver);

    await expect(
      pipeline.userUpdate(
        '999999999999999999',
        'newname',
        'oldglobal',
        occurredAt,
      ),
    ).rejects.toBe(unauthorized);
  });

  it('skips logs and save when a snapshot has no username/globalName change', async () => {
    const members = [
      member({ guildId: 'g1', username: 'same', globalName: 'sameG' }),
    ];
    const deliver = vi.fn().mockResolvedValue({ status: 'delivered' });
    const { pipeline, saveMember } = buildPipeline(members, deliver);

    await pipeline.userUpdate(
      '999999999999999999',
      'same',
      'sameG',
      occurredAt,
    );

    expect(deliver).not.toHaveBeenCalled();
    expect(saveMember).not.toHaveBeenCalled();
  });

  it('treats a failed saveMember Result as a per-guild failure without halting others', async () => {
    const members = [member({ guildId: 'gA' }), member({ guildId: 'gB' })];
    const deliver = vi.fn().mockResolvedValue({ status: 'delivered' });
    const logger = { error: vi.fn() };
    const { pipeline, saveMember } = buildPipeline(members, deliver, logger);
    saveMember.mockImplementation((input: { guildId: string }) => {
      if (input.guildId === 'gA')
        return Promise.resolve({
          ok: false,
          error: { code: 'INVALID_INPUT', message: 'bad' },
        });
      return Promise.resolve({ ok: true, value: {} });
    });

    await expect(
      pipeline.userUpdate(
        '999999999999999999',
        'newname',
        'oldglobal',
        occurredAt,
      ),
    ).resolves.toBeUndefined();

    const deliveredGuilds = deliver.mock.calls.map((call) => call[0] as string);
    expect(deliveredGuilds).toContain('gA');
    expect(deliveredGuilds).toContain('gB');
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('Phase 4A member snapshot user lookup', () => {
  const updatedAt = new Date('2026-01-01T00:00:00.000Z');
  const rows = [
    {
      guildId: '111111111111111111',
      userId: '999999999999999999',
      username: 'alpha',
      globalName: null,
      nickname: null,
      joinedAt: null,
      updatedAt,
    },
    {
      guildId: '222222222222222222',
      userId: '999999999999999999',
      username: 'beta',
      globalName: 'bee',
      nickname: 'beebee',
      joinedAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt,
    },
  ];

  it('queries by userId ordered by guildId, excluding LEFT guilds, and validates DTOs', async () => {
    const lifecycleFindMany = vi.fn().mockResolvedValue([]);
    const findMany = vi.fn().mockResolvedValue(rows);
    const repository = new PrismaSnapshotRepository({
      guildMemberSnapshot: { findMany },
      guildLifecycleMarker: { findMany: lifecycleFindMany },
    } as never);

    const result = await repository.listMembersForUser('999999999999999999');

    expect(lifecycleFindMany).toHaveBeenCalledWith({
      where: { status: 'LEFT' },
      select: { guildId: true },
    });
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: '999999999999999999', guildId: { notIn: [] } },
      orderBy: { guildId: 'asc' },
    });
    expect(result).toEqual(rows);
  });

  it('excludes retained snapshots for lifecycle LEFT guilds from the user lookup', async () => {
    const lifecycleFindMany = vi
      .fn()
      .mockResolvedValue([{ guildId: '222222222222222222' }]);
    const activeRow = rows[0];
    const findMany = vi.fn().mockResolvedValue(activeRow ? [activeRow] : []);
    const repository = new PrismaSnapshotRepository({
      guildMemberSnapshot: { findMany },
      guildLifecycleMarker: { findMany: lifecycleFindMany },
    } as never);

    const result = await repository.listMembersForUser('999999999999999999');

    expect(findMany).toHaveBeenCalledWith({
      where: {
        userId: '999999999999999999',
        guildId: { notIn: ['222222222222222222'] },
      },
      orderBy: { guildId: 'asc' },
    });
    expect(result.map((row) => row.guildId)).toEqual(['111111111111111111']);
  });

  it('rejects a malformed member snapshot DTO during validation', async () => {
    const malformed = [
      {
        guildId: '111111111111111111',
        userId: '999999999999999999',
        username: 'x'.repeat(33),
        globalName: null,
        nickname: null,
        joinedAt: null,
        updatedAt,
      },
    ];
    const lifecycleFindMany = vi.fn().mockResolvedValue([]);
    const findMany = vi.fn().mockResolvedValue(malformed);
    const repository = new PrismaSnapshotRepository({
      guildMemberSnapshot: { findMany },
      guildLifecycleMarker: { findMany: lifecycleFindMany },
    } as never);

    await expect(
      repository.listMembersForUser('999999999999999999'),
    ).rejects.toThrow();
  });

  it('rejects an invalid userId Snowflake without querying', async () => {
    const findMany = vi.fn();
    const lifecycleFindMany = vi.fn();
    const repository = new PrismaSnapshotRepository({
      guildMemberSnapshot: { findMany },
      guildLifecycleMarker: { findMany: lifecycleFindMany },
    } as never);

    await expect(
      repository.listMembersForUser('not-a-snowflake'),
    ).rejects.toThrow();
    expect(findMany).not.toHaveBeenCalled();
    expect(lifecycleFindMany).not.toHaveBeenCalled();
  });
});

describe('Phase 4A userUpdate gateway wiring', () => {
  const flush = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));
  const installGateway = (
    logging: unknown,
    logger: unknown,
    fatal: unknown,
  ) => {
    const handlers = new Map<string, (...args: never[]) => void>();
    const client = {
      user: { id: 'bot' },
      on: vi.fn((event: string, handler: (...args: never[]) => void) => {
        handlers.set(event, handler);
      }),
    };
    installGatewayListeners(
      client as never,
      logging as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      logger as never,
      fatal as never,
      {} as never,
    );
    return { handlers };
  };
  const userUpdateEvent = (changed: boolean) => [
    { username: 'old', globalName: 'g' },
    {
      id: '999999999999999999',
      username: changed ? 'new' : 'old',
      globalName: 'g',
    },
  ];

  it('forwards one captured receipt timestamp to a single pipeline userUpdate call', () => {
    const userUpdate = vi.fn().mockResolvedValue(undefined);
    const { handlers } = installGateway(
      { userUpdate },
      { error: vi.fn() },
      vi.fn(),
    );
    const [before, after] = userUpdateEvent(true);

    handlers.get('userUpdate')?.(before as never, after as never);

    expect(userUpdate).toHaveBeenCalledOnce();
    const call = userUpdate.mock.calls[0];
    expect(call?.[0]).toBe('999999999999999999');
    expect(call?.[1]).toBe('new');
    expect(call?.[2]).toBe('g');
    expect(call?.[3]).toBeInstanceOf(Date);
  });

  it('reports a non-401 userUpdate failure under gateway.user_update_failed', async () => {
    const userUpdate = vi.fn().mockRejectedValue(new Error('boom'));
    const logger = { error: vi.fn() };
    const fatal = vi.fn();
    const { handlers } = installGateway({ userUpdate }, logger, fatal);
    const [before, after] = userUpdateEvent(true);

    handlers.get('userUpdate')?.(before as never, after as never);
    await flush();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'gateway.user_update_failed' }),
      'Gateway event failed',
    );
    expect(fatal).not.toHaveBeenCalled();
  });

  it('routes a direct 401 userUpdate failure to fatal', async () => {
    const unauthorized = Object.assign(new Error('unauth'), { status: 401 });
    const userUpdate = vi.fn().mockRejectedValue(unauthorized);
    const logger = { error: vi.fn() };
    const fatal = vi.fn();
    const { handlers } = installGateway({ userUpdate }, logger, fatal);
    const [before, after] = userUpdateEvent(true);

    handlers.get('userUpdate')?.(before as never, after as never);
    await flush();

    expect(fatal).toHaveBeenCalledWith(unauthorized);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('routes a cause-wrapped 401 userUpdate failure to fatal', async () => {
    const wrapped = Object.assign(new Error('wrapped'), {
      cause: { code: 401 },
    });
    const userUpdate = vi.fn().mockRejectedValue(wrapped);
    const logger = { error: vi.fn() };
    const fatal = vi.fn();
    const { handlers } = installGateway({ userUpdate }, logger, fatal);
    const [before, after] = userUpdateEvent(true);

    handlers.get('userUpdate')?.(before as never, after as never);
    await flush();

    expect(fatal).toHaveBeenCalledWith(wrapped);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('Phase 4B channel lifecycle', () => {
  const flush = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));
  const installGatewayForChannel = (opts: {
    ignores?: unknown;
    settings?: unknown;
    logger?: unknown;
    fatal?: unknown;
  }) => {
    const handlers = new Map<string, (...args: never[]) => void>();
    const client = {
      user: { id: 'bot' },
      on: vi.fn((event: string, handler: (...args: never[]) => void) => {
        handlers.set(event, handler);
      }),
    };
    installGatewayListeners(
      client as never,
      { userUpdate: vi.fn().mockResolvedValue(undefined) } as never,
      (opts.settings ?? {}) as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      (opts.ignores ?? {}) as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      (opts.logger ?? { error: vi.fn() }) as never,
      (opts.fatal ?? vi.fn()) as never,
      {} as never,
    );
    return { handlers };
  };

  it('runs the composite channel cleanup once and invalidates settings after it settles', async () => {
    const clearChannel = vi.fn().mockResolvedValue(3);
    const invalidate = vi.fn();
    const { handlers } = installGatewayForChannel({
      ignores: { clearChannel },
      settings: { invalidate },
    });

    handlers.get('channelDelete')?.({ guildId: 'g1', id: 'c1' } as never);
    await flush();

    expect(clearChannel).toHaveBeenCalledOnce();
    expect(clearChannel).toHaveBeenCalledWith('g1', 'c1');
    expect(invalidate).toHaveBeenCalledWith('g1');
  });

  it('reports a composite cleanup rejection rather than leaving it unhandled', async () => {
    const clearChannel = vi.fn().mockRejectedValue(new Error('cleanup down'));
    const invalidate = vi.fn();
    const logger = { error: vi.fn() };
    const fatal = vi.fn();
    const { handlers } = installGatewayForChannel({
      ignores: { clearChannel },
      settings: { invalidate },
      logger,
      fatal,
    });

    handlers.get('channelDelete')?.({ guildId: 'g1', id: 'c1' } as never);
    await flush();

    expect(clearChannel).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'gateway.channel_delete_failed' }),
      'Gateway event failed',
    );
    expect(fatal).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith('g1');
  });

  it('routes a 401 composite cleanup rejection to fatal', async () => {
    const unauthorized = Object.assign(new Error('unauth'), { status: 401 });
    const clearChannel = vi.fn().mockRejectedValue(unauthorized);
    const invalidate = vi.fn();
    const logger = { error: vi.fn() };
    const fatal = vi.fn();
    const { handlers } = installGatewayForChannel({
      ignores: { clearChannel },
      settings: { invalidate },
      logger,
      fatal,
    });

    handlers.get('channelDelete')?.({ guildId: 'g1', id: 'c1' } as never);
    await flush();

    expect(fatal).toHaveBeenCalledWith(unauthorized);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
