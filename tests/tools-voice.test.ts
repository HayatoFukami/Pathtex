import { describe, expect, it, vi } from 'vitest';
import { ToolsService } from '../src/features/tools/service.js';
import { VoiceService } from '../src/features/voice/service.js';
import { parseVoiceTargets } from '../src/features/voice/validation.js';
import { paginateAuditEntries } from '../src/features/tools/adapters.js';
import {
  auditCursorRegistrySize,
  cleanupAuditCursorRegistry,
  createAuditCustomId,
  handleToolsComponent,
  toolsCommands,
  validateAuditCustomId,
} from '../src/features/tools/commands.js';
import type { ButtonInteraction } from 'discord.js';
import type {
  ToolsPort,
  AnnouncementPort,
} from '../src/features/tools/contracts.js';
import type { VoicePort } from '../src/features/voice/contracts.js';

const toolsPort = (): ToolsPort => ({
  members: vi.fn().mockResolvedValue([]),
  setNickname: vi.fn(),
  invites: vi.fn().mockResolvedValue([]),
  deleteInvite: vi.fn(),
  user: vi.fn().mockResolvedValue(null),
  invite: vi.fn().mockResolvedValue(null),
  preview: vi.fn().mockResolvedValue(null),
});
describe('tools and voice services', () => {
  it('creates bounded expiring audit cursors and rejects expired state', () => {
    const expiry = Date.now() + 900_000;
    const id = createAuditCustomId(
      'next',
      '12345678901234567',
      '12345678901234567',
      'all',
      undefined,
      undefined,
      10,
      expiry,
    );
    if (!id) throw new Error('cursor should be valid');
    expect(id.length).toBeLessThanOrEqual(100);
    expect(validateAuditCustomId(id, '12345678901234567')).toBe(true);
    const expired = createAuditCustomId(
      'next',
      '12345678901234567',
      '12345678901234567',
      'all',
      undefined,
      undefined,
      10,
      Date.now() - 1,
    );
    if (!expired) throw new Error('expired cursor should still be encoded');
    expect(validateAuditCustomId(expired, '12345678901234567')).toBe(false);
    const overflow = createAuditCustomId(
      'next',
      '12345678901234567',
      '12345678901234567',
      'action',
      'x'.repeat(200),
      'y'.repeat(200),
      10,
      expiry,
    );
    expect(overflow).not.toBeNull();
    if (!overflow) throw new Error('overflow cursor should use registry');
    expect(validateAuditCustomId(overflow, '12345678901234567')).toBe(true);
  });
  it('strictly parses bounded voice targets', () => {
    const parsed = parseVoiceTargets(
      '12345678901234567',
      '<@!12345678901234568> , 12345678901234567',
    );
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value).toEqual(['12345678901234567', '12345678901234568']);
    expect(parseVoiceTargets('bad', undefined).ok).toBe(false);
  });
  it('cleans expired audit registry entries and enforces its eviction cap', () => {
    const actor = '12345678901234567';
    const expiry = Date.now() + 900_000;
    for (let index = 0; index < 10005; index++)
      createAuditCustomId(
        'next',
        actor,
        actor,
        'action',
        'x'.repeat(200),
        String(index),
        index,
        expiry,
      );
    expect(auditCursorRegistrySize()).toBeLessThanOrEqual(10000);
    const expired = createAuditCustomId(
      'next',
      actor,
      actor,
      'action',
      'x'.repeat(200),
      'expired',
      1,
      Date.now() - 1,
    );
    if (!expired) throw new Error('expired cursor should be encoded');
    cleanupAuditCursorRegistry();
    expect(validateAuditCustomId(expired, actor)).toBe(false);
  });
  it('caps audit display rows before removing the sentinel row', () => {
    const page = paginateAuditEntries(['a', 'b', 'sentinel'], 10, 2);
    expect(page.entries).toEqual(['a', 'b']);
    expect(page.hasMore).toBe(false);
  });
  it('executes registry-backed audit cursors in both directions with remaining totals', async () => {
    const auditPage = vi.fn().mockResolvedValue({
      ok: true,
      value: { entries: [], total: 3, hasMore: false },
    });
    const service = { auditPage } as unknown as ToolsService;
    const actor = '12345678901234567';
    for (const direction of ['next', 'previous'] as const) {
      const customId = createAuditCustomId(
        direction,
        actor,
        actor,
        'action',
        'x'.repeat(200),
        'y'.repeat(200),
        3,
      );
      if (!customId) throw new Error('registry cursor missing');
      const interaction = {
        customId,
        user: { id: actor },
        guildId: '12345678901234567',
        update: vi.fn(),
        reply: vi.fn(),
      } as unknown as ButtonInteraction;
      await handleToolsComponent(interaction, service);
    }
    expect(auditPage).toHaveBeenCalledTimes(2);
    expect(auditPage.mock.calls[0]?.[2]).toMatchObject({
      totalLimit: 3,
      before: actor,
    });
    expect(auditPage.mock.calls[1]?.[2]).toMatchObject({
      totalLimit: 3,
      after: actor,
    });
  });
  it('walks a multi-page audit sequence without exceeding the requested cap', async () => {
    const actor = '12345678901234567';
    const auditPage = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          entries: Array.from({ length: 10 }, () => ({})),
          total: 15,
          hasMore: true,
          nextBefore: '22345678901234567',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          entries: Array.from({ length: 5 }, () => ({})),
          total: 5,
          hasMore: false,
        },
      });
    const service = { auditPage } as unknown as ToolsService;
    const first = createAuditCustomId(
      'next',
      actor,
      actor,
      'all',
      'x'.repeat(200),
      'y'.repeat(200),
      15,
      Date.now() + 900000,
      0,
    );
    if (!first) throw new Error('first cursor missing');
    const interaction = (customId: string) =>
      ({
        customId,
        user: { id: actor },
        guildId: actor,
        update: vi.fn(),
        reply: vi.fn(),
      }) as unknown as ButtonInteraction;
    await handleToolsComponent(interaction(first), service);
    const second = createAuditCustomId(
      'next',
      actor,
      actor,
      'all',
      'x'.repeat(200),
      'y'.repeat(200),
      5,
      Date.now() + 900000,
      1,
    );
    if (!second) throw new Error('second cursor missing');
    await handleToolsComponent(interaction(second), service);
    expect(auditPage).toHaveBeenNthCalledWith(
      1,
      actor,
      'all',
      expect.objectContaining({ totalLimit: 15 }),
    );
    expect(auditPage).toHaveBeenNthCalledWith(
      2,
      actor,
      'all',
      expect.objectContaining({ totalLimit: 5 }),
    );
  });
  it('restores the first ten rows for every requested total from 11 through 19', async () => {
    const actor = '12345678901234567';
    const auditPage = vi.fn();
    const service = { auditPage } as unknown as ToolsService;
    for (let total = 11; total <= 19; total++) {
      auditPage
        .mockResolvedValueOnce({
          ok: true,
          value: {
            entries: Array.from({ length: total - 10 }, (_, index) => ({
              id: `page2-${String(index)}`,
              action: 'BAN',
              userId: actor,
              userName: 'mod',
              target: `page2-${String(index)}`,
            })),
            total: total - 10,
            hasMore: false,
            previousAfter: actor,
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          value: {
            entries: Array.from({ length: 10 }, (_, index) => ({
              id: `page1-${String(index)}`,
              action: 'BAN',
              userId: actor,
              userName: 'mod',
              target: `page1-${String(index)}`,
            })),
            total,
            hasMore: false,
          },
        });
      const next = createAuditCustomId(
        'next',
        actor,
        actor,
        'all',
        undefined,
        undefined,
        total,
        Date.now() + 900000,
        1,
      );
      if (!next) throw new Error('next cursor missing');
      const update = vi.fn();
      const interaction = (customId: string, updateHandler: typeof update) =>
        ({
          customId,
          user: { id: actor },
          guildId: actor,
          update: updateHandler,
          reply: vi.fn(),
        }) as unknown as ButtonInteraction;
      await handleToolsComponent(interaction(next, update), service);
      const previousId = createAuditCustomId(
        'previous',
        actor,
        actor,
        'all',
        undefined,
        undefined,
        10,
        Date.now() + 900000,
        1,
        total,
        0,
      );
      if (!previousId) throw new Error('previous cursor missing');
      const restored = vi.fn();
      await handleToolsComponent(interaction(previousId, restored), service);
      expect(auditPage).toHaveBeenNthCalledWith(
        (total - 10) * 2 - 1,
        actor,
        'all',
        expect.objectContaining({ totalLimit: total }),
      );
      expect(auditPage).toHaveBeenNthCalledWith(
        (total - 10) * 2,
        actor,
        'all',
        expect.objectContaining({
          totalLimit: total,
          after: actor,
        }),
      );
      expect(JSON.stringify(restored.mock.calls[0]?.[0])).toContain('page1-0');
    }
  });
  it('executes command-generated forward, partial-final, and Previous audit pages', async () => {
    const actor = '12345678901234567';
    const entry = (id: string) => ({
      id,
      createdAt: new Date(),
      action: 'BAN',
      userId: actor,
      userName: 'mod',
      target: id,
    });
    const auditPage = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          entries: Array.from({ length: 10 }, (_, index) =>
            entry(`page1-${String(index)}`),
          ),
          total: 25,
          hasMore: true,
          nextBefore: '22345678901234567',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          entries: Array.from({ length: 10 }, (_, index) =>
            entry(`page2-${String(index)}`),
          ),
          total: 15,
          hasMore: true,
          previousAfter: '12345678901234567',
          nextBefore: '32345678901234567',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          entries: Array.from({ length: 5 }, (_, index) =>
            entry(`page3-${String(index)}`),
          ),
          total: 15,
          previousAfter: '22345678901234567',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          entries: Array.from({ length: 10 }, (_, index) =>
            entry(`page2-${String(index)}`),
          ),
          total: 25,
          hasMore: false,
          previousAfter: '12345678901234567',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          entries: Array.from({ length: 10 }, (_, index) =>
            entry(`page1-${String(index)}`),
          ),
          total: 25,
          hasMore: false,
        },
      });
    const service = { auditPage } as unknown as ToolsService;
    const command = toolsCommands(service).find(
      (item) => item.name === 'audit',
    );
    if (!command) throw new Error('audit command missing');
    const editReply = vi.fn();
    const interaction = {
      guildId: actor,
      user: { id: actor },
      options: {
        getUser: vi.fn().mockReturnValue(null),
        getString: vi.fn((name: string, required?: boolean) =>
          name === 'scope' && required ? 'all' : null,
        ),
        getInteger: vi.fn().mockReturnValue(25),
      },
      editReply,
    } as unknown as import('discord.js').ChatInputCommandInteraction;
    await command.execute({ interaction, receivedAt: Date.now() });
    const firstPayload = editReply.mock.calls[0]?.[0] as {
      components?: readonly { components?: readonly { customId?: string }[] }[];
    };
    const firstButton = firstPayload.components?.[0]?.components?.[0] as
      { customId?: string; data?: { custom_id?: string } } | undefined;
    const nextId = firstButton?.customId ?? firstButton?.data?.custom_id;
    if (!nextId) throw new Error('generated next cursor missing');
    expect(validateAuditCustomId(nextId, actor)).toBe(true);
    const update = vi.fn();
    const update2 = vi.fn();
    const update3 = vi.fn();
    const update4 = vi.fn();
    await handleToolsComponent(
      {
        customId: nextId,
        user: { id: actor },
        guildId: actor,
        update,
        reply: vi.fn(),
      } as unknown as ButtonInteraction,
      service,
    );
    const secondPayload = update.mock.calls[0]?.[0] as {
      components?: readonly {
        components?: readonly {
          customId?: string;
          data?: { custom_id?: string };
        }[];
      }[];
    };
    const secondButtons = secondPayload.components?.flatMap(
      (row) => row.components ?? [],
    );
    const next2Id = secondButtons
      ?.map((button) => button.customId ?? button.data?.custom_id)
      .find((id) => id?.startsWith('audit:next:'));
    if (!next2Id) throw new Error('generated second next cursor missing');
    await handleToolsComponent(
      {
        customId: next2Id,
        user: { id: actor },
        guildId: actor,
        update: update2,
        reply: vi.fn(),
      } as unknown as ButtonInteraction,
      service,
    );
    const thirdPayload = update2.mock.calls[0]?.[0] as {
      components?: readonly {
        components?: readonly {
          customId?: string;
          data?: { custom_id?: string };
        }[];
      }[];
    };
    const thirdButtons = thirdPayload.components?.flatMap(
      (row) => row.components ?? [],
    );
    const previousId = thirdButtons
      ?.map((button) => button.customId ?? button.data?.custom_id)
      .find((id) => id?.startsWith('audit:previous:'));
    if (!previousId) throw new Error('generated previous cursor missing');
    await handleToolsComponent(
      {
        customId: previousId,
        user: { id: actor },
        guildId: actor,
        update: update3,
        reply: vi.fn(),
      } as unknown as ButtonInteraction,
      service,
    );
    const fourthPayload = update3.mock.calls[0]?.[0] as {
      components?: readonly {
        components?: readonly {
          customId?: string;
          data?: { custom_id?: string };
        }[];
      }[];
    };
    const fourthButtons = fourthPayload.components?.flatMap(
      (row) => row.components ?? [],
    );
    const previous2 = fourthButtons
      ?.map((button) => button.customId ?? button.data?.custom_id)
      .find((id) => id?.startsWith('audit:previous:'));
    if (!previous2) throw new Error('second previous cursor missing');
    await handleToolsComponent(
      {
        customId: previous2,
        user: { id: actor },
        guildId: actor,
        update: update4,
        reply: vi.fn(),
      } as unknown as ButtonInteraction,
      service,
    );
    expect(auditPage).toHaveBeenNthCalledWith(
      1,
      actor,
      'all',
      expect.objectContaining({ totalLimit: 25 }),
    );
    expect(auditPage).toHaveBeenNthCalledWith(
      2,
      actor,
      'all',
      expect.objectContaining({ totalLimit: 15 }),
    );
    expect(auditPage).toHaveBeenNthCalledWith(
      3,
      actor,
      'all',
      expect.objectContaining({ totalLimit: 5 }),
    );
    expect(auditPage).toHaveBeenNthCalledWith(
      4,
      actor,
      'all',
      expect.objectContaining({
        totalLimit: 25,
        after: '22345678901234567',
      }),
    );
    expect(auditPage).toHaveBeenNthCalledWith(
      5,
      actor,
      'all',
      expect.objectContaining({
        totalLimit: 25,
        after: '12345678901234567',
      }),
    );
    expect(JSON.stringify(update3.mock.calls[0]?.[0])).toContain('page2-0');
    expect(JSON.stringify(update4.mock.calls[0]?.[0])).toContain('page1-0');
  });
  it('restores a temporarily mentionable role and restricts mentions', async () => {
    const sent: unknown[] = [];
    const role = { id: 'r', mentionable: false, position: 1 };
    const setMentionable = vi.fn();
    const announcement: AnnouncementPort = {
      getRole: vi.fn().mockResolvedValue(role),
      botPosition: vi.fn().mockResolvedValue(2),
      setMentionable,
      send: vi.fn((_c, _m, mentions) => {
        sent.push(mentions);
        return Promise.resolve();
      }),
    };
    const result = await new ToolsService(toolsPort(), announcement).announce(
      'c',
      'r',
      'hello',
    );
    expect(result.ok).toBe(true);
    expect(setMentionable).toHaveBeenNthCalledWith(2, 'r', false);
    expect(sent[0]).toEqual({ roles: ['r'], users: [], everyone: false });
  });
  it('does not replace an active VoiceMove session', async () => {
    const connect = vi.fn();
    const port: VoicePort = {
      connect,
      disconnect: vi.fn(),
      move: vi.fn(),
      createTemporaryChannel: vi.fn(),
      deleteChannel: vi.fn(),
      members: vi.fn(),
      member: vi.fn(),
      dm: vi.fn(),
    };
    const service = new VoiceService(port);
    await service.start('g', 'u', 'v');
    const result = await service.start('g', 'u2', 'v2');
    expect(result.ok).toBe(false);
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it('reports unresolved additional-only VoiceKick targets', async () => {
    const modlog = vi.fn();
    const create = vi
      .fn()
      .mockResolvedValue({ caseId: 'case-1', caseNumber: 7 });
    const port: VoicePort = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      move: vi.fn(),
      createTemporaryChannel: vi.fn(),
      deleteChannel: vi.fn(),
      members: vi.fn(),
      member: vi.fn().mockResolvedValue(null),
      dm: vi.fn(),
      modlog,
    };
    const result = await new VoiceService(port, { create }).voiceKickTargets(
      'g',
      'actor',
      ['12345678901234567'],
    );
    if (!result.ok) throw result.error;
    expect(result.value.failed).toEqual(['12345678901234567']);
    expect(result.value.outcomes[0]?.identity).toEqual({
      userId: '12345678901234567',
      displayName: '不明なユーザー',
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'MEMBER_NOT_FOUND' }),
    );
    expect(modlog).toHaveBeenCalledWith(
      'g',
      expect.objectContaining({ userId: '12345678901234567' }),
      'case-1',
    );
  });
  it('writes only one modlog entry for duplicate VoiceKick targets', async () => {
    const modlog = vi.fn();
    const create = vi.fn().mockResolvedValue({ caseId: 'case-duplicate' });
    const port: VoicePort = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      move: vi.fn(),
      createTemporaryChannel: vi.fn(),
      deleteChannel: vi.fn(),
      members: vi.fn(),
      member: vi.fn().mockResolvedValue(null),
      dm: vi.fn(),
      modlog,
    };
    const result = await new VoiceService(port, { create }).voiceKickTargets(
      'g',
      'actor',
      ['12345678901234567', '12345678901234567'],
    );
    if (!result.ok) throw result.error;
    expect(result.value.outcomes).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(modlog).toHaveBeenCalledTimes(1);
    expect(modlog).toHaveBeenCalledWith(
      'g',
      expect.objectContaining({ userId: '12345678901234567' }),
      'case-duplicate',
    );
  });
  it('writes one modlog entry for a resolved member through voiceKickTargets', async () => {
    const modlog = vi.fn();
    const member = {
      id: '12345678901234567',
      bot: false,
      channelId: 'source',
      displayName: 'Resolved Member',
      categoryId: null,
    };
    const port: VoicePort = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      move: vi.fn(),
      createTemporaryChannel: vi.fn().mockResolvedValue('temporary'),
      deleteChannel: vi.fn(),
      members: vi.fn(),
      member: vi.fn().mockResolvedValue(member),
      dm: vi.fn(),
      modlog,
    };
    const result = await new VoiceService(port).voiceKickTargets('g', 'actor', [
      member.id,
      member.id,
    ]);
    if (!result.ok) throw result.error;
    expect(result.value.outcomes[0]?.identity).toEqual({
      userId: member.id,
      displayName: 'Resolved Member',
    });
    expect(result.value.outcomes).toHaveLength(1);
    expect(modlog).toHaveBeenCalledTimes(1);
    expect(modlog).toHaveBeenCalledWith(
      'g',
      expect.objectContaining({ userId: member.id, ok: true }),
      undefined,
    );
  });
  it('retains fallback identity when VoiceKick member lookup fails', async () => {
    const port: VoicePort = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      move: vi.fn(),
      createTemporaryChannel: vi.fn(),
      deleteChannel: vi.fn(),
      members: vi.fn(),
      member: vi.fn().mockRejectedValue(new Error('discord unavailable')),
      dm: vi.fn(),
    };
    const result = await new VoiceService(port).voiceKickTargets('g', 'actor', [
      '12345678901234567',
    ]);
    if (!result.ok) throw result.error;
    expect(result.value.outcomes[0]?.identity).toEqual({
      userId: '12345678901234567',
      displayName: '不明なユーザー',
    });
    expect(result.value.outcomes[0]?.code).toBe('MEMBER_NOT_FOUND');
  });
  it('resolves a missing VoiceKick target from the shared identity resolver', async () => {
    const resolver = {
      resolve: vi.fn().mockResolvedValue({
        userId: '12345678901234567',
        displayName: 'Recovered User',
      }),
    };
    const create = vi.fn().mockResolvedValue({ caseId: 'recovered-case' });
    const port = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      move: vi.fn(),
      createTemporaryChannel: vi.fn(),
      deleteChannel: vi.fn(),
      members: vi.fn(),
      member: vi.fn().mockResolvedValue(null),
      dm: vi.fn(),
    } satisfies VoicePort;
    const result = await new VoiceService(
      port,
      { create },
      undefined,
      resolver,
    ).voiceKickTargets('guild', 'actor', ['12345678901234567']);
    if (!result.ok) throw result.error;
    expect(result.value.outcomes[0]?.identity?.displayName).toBe(
      'Recovered User',
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: {
          userId: '12345678901234567',
          displayName: 'Recovered User',
        },
      }),
    );
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
  });
  it('resolves invalid member display through the shared resolver once', async () => {
    const identity = { userId: '12345678901234567', displayName: 'User Name' };
    const resolver = { resolve: vi.fn().mockResolvedValue(identity) };
    const create = vi.fn().mockResolvedValue({ caseId: 'case' });
    const modlog = vi.fn();
    const port: VoicePort = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      move: vi.fn(),
      createTemporaryChannel: vi.fn().mockResolvedValue('temporary'),
      deleteChannel: vi.fn(),
      members: vi.fn(),
      member: vi.fn().mockResolvedValue({
        id: identity.userId,
        bot: false,
        channelId: 'source',
        displayName: '12345678901234567',
      }),
      dm: vi.fn(),
      modlog,
    };
    const result = await new VoiceService(
      port,
      { create },
      undefined,
      resolver,
    ).voiceKickTargets('guild', 'actor', [identity.userId]);
    if (!result.ok) throw result.error;
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(result.value.outcomes[0]?.identity).toBe(identity);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ identity }));
    expect(modlog).toHaveBeenCalledWith(
      'guild',
      expect.objectContaining({ identity }),
      'case',
    );
  });
  it('propagates fatal Discord 401 errors from VoiceKick resolution', async () => {
    const port = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      move: vi.fn(),
      createTemporaryChannel: vi.fn(),
      deleteChannel: vi.fn(),
      members: vi.fn(),
      member: vi.fn().mockRejectedValue({ status: 401 }),
      dm: vi.fn(),
    } satisfies VoicePort;
    await expect(
      new VoiceService(port).voiceKickTargets('guild', 'actor', [
        '12345678901234567',
      ]),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('rejects a VoiceMove target the actor or bot cannot view', async () => {
    const port: VoicePort = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      move: vi.fn(),
      createTemporaryChannel: vi.fn(),
      deleteChannel: vi.fn(),
      members: vi.fn(),
      member: vi.fn(),
      dm: vi.fn(),
      actorChannel: vi.fn().mockResolvedValue({ id: 'v' }),
      canViewChannel: vi.fn().mockResolvedValue(false),
    };
    const result = await new VoiceService(port).start('g', 'actor');
    expect(result.ok).toBe(false);
  });
  it('rejects VoiceKick when the temporary destination category lacks ManageChannels', async () => {
    const createTemporaryChannel = vi.fn();
    const port: VoicePort = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      move: vi.fn(),
      createTemporaryChannel,
      deleteChannel: vi.fn(),
      members: vi.fn(),
      member: vi.fn(),
      dm: vi.fn(),
      canKickFromChannel: vi.fn().mockResolvedValue(true),
      canCreateTemporaryChannel: vi.fn().mockResolvedValue(false),
    };
    const result = await new VoiceService(port).voiceKick('g', 'actor', [
      {
        id: '12345678901234567',
        bot: false,
        channelId: 'source',
        categoryId: 'category',
      },
    ]);
    if (!result.ok) throw result.error;
    expect(result.value.outcomes[0]).toMatchObject({
      ok: false,
      code: 'BOT_PERMISSION_MISSING',
    });
    expect(createTemporaryChannel).not.toHaveBeenCalled();
  });
  it('moves only connected members and preserves their category for VoiceKick', async () => {
    const created: string[] = [];
    const port: VoicePort = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      move: vi.fn(),
      createTemporaryChannel: vi
        .fn()
        .mockImplementation((_g, category: string) => {
          created.push(category);
          return Promise.resolve('tmp');
        }),
      deleteChannel: vi.fn(),
      members: vi.fn(),
      member: vi.fn(),
      dm: vi.fn(),
    };
    const service = new VoiceService(port);
    const result = await service.voiceKick('g', 'actor', [
      { id: '1', bot: false, channelId: 'source', categoryId: 'cat' },
      { id: '2', bot: false, channelId: null },
    ]);
    expect(result.ok && result.value.failed).toEqual(['2']);
    expect(created).toEqual(['cat']);
  });
  it('expires VoiceMove sessions and disconnects the bot', async () => {
    const disconnect = vi.fn();
    const port: VoicePort = {
      connect: vi.fn(),
      disconnect,
      move: vi.fn(),
      createTemporaryChannel: vi.fn(),
      deleteChannel: vi.fn(),
      members: vi.fn(),
      member: vi.fn(),
      dm: vi.fn(),
    };
    const now = new Date('2026-01-01T00:00:00Z');
    const service = new VoiceService(port, undefined, () => now);
    await service.start('g', 'u', 'v');
    await service.expire(new Date(now.getTime() + 6 * 60 * 60 * 1000));
    const status = service.status('g');
    if (!status.ok) throw status.error;
    expect(status.value).toBeNull();
    expect(disconnect).toHaveBeenCalledWith('g');
  });
});
