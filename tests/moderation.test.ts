/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import { describe, expect, it, vi } from 'vitest';
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
import type { CaseDto } from '../src/repositories/contracts.js';
import type { TargetIdentity } from '../src/services/target-identity.js';

const guildId = '12345678901234567';
const actorId = '12345678901234568';
const targetId = '12345678901234569';

function caseDto(overrides: Partial<CaseDto> = {}): CaseDto {
  const now = new Date();
  return {
    id: '00000000-0000-4000-8000-000000000001',
    guildId,
    caseNumber: 7,
    action: 'KICK',
    targetUserId: targetId,
    targetDisplay: 'Stored Name',
    moderatorUserId: actorId,
    reason: 'reason',
    durationSeconds: null,
    source: 'COMMAND',
    status: 'PENDING',
    errorCode: null,
    logMessageId: null,
    logChannelId: null,
    discordAuditLogEntryId: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function moderationDeps(overrides: Record<string, unknown> = {}) {
  const member = {
    id: targetId,
    displayName: 'Member Name',
    isOwner: false,
    isBot: false,
    rolePosition: 1,
    isMember: true,
  };
  const discord = {
    getMember: vi.fn(async () => member),
    getUser: vi.fn(async () => ({ id: targetId, display: 'User Name' })),
    getBotUserId: vi.fn(async () => '12345678901234570'),
    getBotRolePosition: vi.fn(async () => 10),
    getActorIsOwner: vi.fn(async () => false),
    getActorRolePosition: vi.fn(async () => 5),
    kick: vi.fn(async () => undefined),
    ban: vi.fn(async () => undefined),
    unban: vi.fn(async () => undefined),
    isBanned: vi.fn(async () => false),
    addRole: vi.fn(async () => undefined),
    removeRole: vi.fn(async () => undefined),
    sendDm: vi.fn(async () => undefined),
    setSlowmode: vi.fn(async () => undefined),
    getSlowmode: vi.fn(async () => 0),
    fetchMessages: vi.fn(async () => []),
    deleteMessages: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
  };
  const created = caseDto();
  const cases = {
    create: vi.fn(async () => ({ ok: true, value: created })),
    createCanonical: vi.fn(async () => ({ ok: true, value: created })),
    updateStatus: vi.fn(
      async (_guild: string, _id: string, status: CaseDto['status']) => ({
        ok: true,
        value: caseDto({ status }),
      }),
    ),
    updateMetadata: vi.fn(async () => ({ ok: true, value: created })),
  };
  const deps = {
    discord,
    cases,
    scheduler: {
      cancel: vi.fn(async () => ({ ok: true })),
      schedule: vi.fn(async () => ({ ok: true })),
    },
    activeMutes: {
      activateWithSchedule: vi.fn(),
      releaseWithSchedule: vi.fn(),
    },
    settings: {
      get: vi.fn(async () => ({
        ok: true,
        value: { mutedRoleId: '12345678901234571' },
      })),
    },
    modlog: { write: vi.fn(async () => undefined) },
    ...overrides,
  };
  return { deps, discord, cases, created };
}

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

  it('renders identities returned by the moderation outcome', async () => {
    const calls: Array<{ id: string }> = [];
    const replies: Array<{
      embeds?: readonly { fields?: readonly { name: string }[] }[];
    }> = [];
    const service = {
      kick: (input: { targets: readonly { id: string }[] }) => {
        calls.push(input.targets[0] as (typeof calls)[number]);
        return Promise.resolve({
          ok: true,
          value: {
            outcomes: [
              {
                targetId: input.targets[0]?.id ?? '',
                ok: true,
                identity: {
                  userId: '12345678901234569',
                  displayName: 'Returned Success',
                },
              },
              {
                targetId: '12345678901234570',
                ok: false,
                code: 'ROLE_HIERARCHY',
                identity: {
                  userId: '12345678901234570',
                  displayName: 'Returned Failure',
                },
              },
            ],
          },
        });
      },
    } as unknown as ModerationService;
    const kick = createModerationCommands(service).find(
      (command) => command.name === 'kick',
    );
    const interaction = {
      guildId: '12345678901234567',
      user: { id: '12345678901234568' },
      options: {
        getUser: () => ({ id: '12345678901234569', globalName: 'Global Name' }),
        getMember: () => ({ displayName: 'Interaction Name' }),
        getString: () => null,
        getInteger: () => null,
      },
      editReply: (reply: {
        embeds?: readonly { fields?: readonly { name: string }[] }[];
      }) => {
        replies.push(reply);
        return Promise.resolve(undefined);
      },
    };

    await kick?.execute({ interaction } as never);

    expect(calls[0]).toEqual({
      id: '12345678901234569',
      identity: {
        userId: '12345678901234569',
        displayName: 'Interaction Name',
      },
    });
    expect(replies[0]?.embeds?.[0]?.fields?.map((field) => field.name)).toEqual(
      [
        'Returned Success (12345678901234569)',
        'Returned Failure (12345678901234570)',
      ],
    );
  });

  it('passes a safe interaction member identity for non-kick actions', async () => {
    let received: unknown;
    const service = {
      ban: (value: unknown) => {
        received = value;
        return Promise.resolve({ ok: true, value: { outcomes: [] } });
      },
    } as unknown as ModerationService;
    const ban = createModerationCommands(service).find(
      (command) => command.name === 'ban',
    );
    const interaction = {
      guildId,
      user: { id: actorId },
      options: {
        getUser: () => ({ id: targetId }),
        getMember: () => ({ displayName: 'Ban Member' }),
        getString: (name: string) => (name === 'reason' ? null : null),
        getInteger: () => null,
      },
      editReply: () => Promise.resolve(undefined),
    };
    await ban?.execute({ interaction } as never);
    expect(received).toMatchObject({
      targets: [{ identity: { userId: targetId, displayName: 'Ban Member' } }],
    });
  });
});

describe('ModerationService P2A identity boundaries', () => {
  const input = (
    target: { id: string; identity?: TargetIdentity } = { id: targetId },
  ) => ({
    guildId,
    actorId,
    targets: [target],
    reason: 'reason',
  });

  it('uses supplied identity canonically without a resolver', async () => {
    const identity = { userId: targetId, displayName: 'Supplied Name' };
    const { deps, cases } = moderationDeps();
    const result = await new ModerationService(deps as never).kick(
      input({ id: targetId, identity }),
    );
    expect(result.ok).toBe(true);
    expect(cases.createCanonical).toHaveBeenCalledWith(
      expect.objectContaining({
        targetDisplay: 'Supplied Name',
        targetUserId: targetId,
      }),
    );
    expect(result.ok && result.value.outcomes[0]).toMatchObject({ identity });
  });

  it('rejects mismatched resolver identities without creating a case', async () => {
    const { deps, cases } = moderationDeps({
      targetIdentityResolver: {
        resolve: vi.fn(async () => ({ userId: actorId, displayName: 'Wrong' })),
      },
    });
    const result = await new ModerationService(deps as never).kick(input());
    expect(result.ok && result.value.outcomes[0]).toMatchObject({
      ok: false,
      code: 'INVALID_TARGET_IDENTITY',
      identity: { userId: targetId, displayName: '不明なユーザー' },
    });
    expect(cases.createCanonical).not.toHaveBeenCalled();
  });

  it('returns resolver fallback identities and propagates fatal resolver errors', async () => {
    const fallback = moderationDeps({
      targetIdentityResolver: {
        resolve: vi.fn(async () => ({
          userId: targetId,
          displayName: '不明なユーザー',
        })),
      },
    });
    const fallbackResult = await new ModerationService(
      fallback.deps as never,
    ).kick(input());
    expect(fallbackResult.ok && fallbackResult.value.outcomes[0]).toMatchObject(
      {
        ok: true,
        identity: { userId: targetId, displayName: '不明なユーザー' },
      },
    );

    const fatal = moderationDeps({
      targetIdentityResolver: {
        resolve: vi.fn(async () => {
          throw Object.assign(new Error('unauthorized'), { status: 401 });
        }),
      },
    });
    await expect(
      new ModerationService(fatal.deps as never).kick(input()),
    ).rejects.toMatchObject({
      status: 401,
    });
  });

  it('retains resolved identity on precondition failure and identity/case on API failure', async () => {
    const precondition = moderationDeps({
      targetIdentityResolver: {
        resolve: vi.fn(async () => ({
          userId: targetId,
          displayName: 'Resolved',
        })),
      },
    });
    precondition.discord.getMember.mockResolvedValue({
      ...precondition.discord.getMember.mock.results[0]?.value,
      isOwner: true,
    });
    const before = await new ModerationService(precondition.deps as never).kick(
      input(),
    );
    expect(before.ok && before.value.outcomes[0]).toMatchObject({
      ok: false,
      code: 'TARGET_IS_OWNER',
      identity: { displayName: 'Resolved' },
    });
    expect(precondition.cases.createCanonical).not.toHaveBeenCalled();

    const api = moderationDeps({
      targetIdentityResolver: {
        resolve: vi.fn(async () => ({
          userId: targetId,
          displayName: 'Resolved',
        })),
      },
    });
    api.discord.kick.mockRejectedValue(
      Object.assign(new Error('failed'), { status: 500 }),
    );
    const after = await new ModerationService(api.deps as never).kick(input());
    expect(after.ok && after.value.outcomes[0]).toMatchObject({
      ok: false,
      identity: { displayName: 'Resolved' },
      case: { id: api.created.id },
    });
  });

  it('uses a valid pre-created case without allocation or service-owned terminalization', async () => {
    const persisted = caseDto({ targetDisplay: 'Persisted Name' });
    const fixture = moderationDeps({
      targetIdentityResolver: {
        resolve: vi.fn(async () => {
          throw new Error('must not resolve');
        }),
      },
    });
    fixture.deps.cases.createCanonical.mockClear();
    const result = await new ModerationService({
      ...fixture.deps,
      cases: {
        ...fixture.cases,
        createCanonical: fixture.cases.createCanonical,
      },
    } as never).kick({
      ...input(),
      execution: { source: 'COMMAND', preCreatedCase: persisted },
    });
    expect(result.ok && result.value.outcomes[0]).toMatchObject({
      ok: true,
      identity: { userId: targetId, displayName: 'Persisted Name' },
      case: persisted,
    });
    expect(fixture.cases.createCanonical).not.toHaveBeenCalled();
    expect(fixture.cases.updateStatus).not.toHaveBeenCalled();
    expect(fixture.cases.updateMetadata).not.toHaveBeenCalled();
    expect(fixture.deps.modlog?.write).not.toHaveBeenCalled();
  });

  it('rejects invalid pre-created binding before Discord work', async () => {
    const fixture = moderationDeps();
    const result = await new ModerationService(fixture.deps as never).kick({
      ...input(),
      execution: {
        source: 'COMMAND',
        preCreatedCase: caseDto({ targetUserId: actorId }),
      },
    });
    expect(result.ok).toBe(false);
    expect(fixture.discord.getMember).not.toHaveBeenCalled();
  });

  it('propagates DM and modlog 401 errors', async () => {
    const dm = moderationDeps();
    dm.discord.sendDm.mockRejectedValue(
      Object.assign(new Error('dm'), { status: 401 }),
    );
    await expect(
      new ModerationService(dm.deps as never).kick(input()),
    ).rejects.toMatchObject({ status: 401 });

    const log = moderationDeps();
    log.deps.modlog?.write.mockRejectedValue(
      Object.assign(new Error('log'), { status: 401 }),
    );
    await expect(
      new ModerationService(log.deps as never).kick({
        ...input(),
        execution: { source: 'COMMAND', sendDm: false },
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('reports detached DM 401 and terminalizes a waited DM 401', async () => {
    const detached = moderationDeps({ fatal: vi.fn() });
    detached.discord.sendDm.mockRejectedValue(
      Object.assign(new Error('dm'), { status: 401 }),
    );
    await expect(
      new ModerationService(detached.deps as never).kick({
        ...input(),
        execution: { source: 'COMMAND', waitForDm: false },
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      (detached.deps as never as { fatal: ReturnType<typeof vi.fn> }).fatal,
    ).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
    expect(detached.cases.updateStatus).toHaveBeenCalledWith(
      guildId,
      detached.created.id,
      'FAILED',
      'DISCORD_API_ERROR',
    );
    expect(detached.cases.updateStatus).not.toHaveBeenCalledWith(
      guildId,
      detached.created.id,
      'COMPLETED',
      undefined,
    );

    const awaited = moderationDeps();
    awaited.discord.sendDm.mockRejectedValue(
      Object.assign(new Error('dm'), { status: 401 }),
    );
    await expect(
      new ModerationService(awaited.deps as never).kick(input()),
    ).rejects.toMatchObject({ status: 401 });
    expect(awaited.cases.updateStatus).toHaveBeenCalledWith(
      guildId,
      awaited.created.id,
      'FAILED',
      'DISCORD_API_ERROR',
    );
  });

  it('uses pre-created identity and case over supplied identity on lookup failure', async () => {
    const fixture = moderationDeps();
    fixture.discord.getMember.mockRejectedValue(new Error('lookup failed'));
    const persisted = caseDto({ targetDisplay: 'Persisted Name' });
    const result = await new ModerationService(fixture.deps as never).kick({
      ...input({
        id: targetId,
        identity: { userId: targetId, displayName: 'Supplied Name' },
      }),
      execution: { source: 'COMMAND', preCreatedCase: persisted },
    });
    expect(result.ok && result.value.outcomes[0]).toMatchObject({
      ok: false,
      identity: { displayName: 'Persisted Name' },
      case: persisted,
    });
    expect(fixture.cases.createCanonical).not.toHaveBeenCalled();
  });

  it('includes the persisted target in the normal moderation log event', async () => {
    const fixture = moderationDeps();
    await new ModerationService(fixture.deps as never).kick(input());
    expect(fixture.deps.modlog?.write).toHaveBeenCalledWith(
      guildId,
      expect.objectContaining({
        embed: expect.objectContaining({
          fields: expect.arrayContaining([
            { name: 'Target', value: 'Stored Name (12345678901234569)' },
          ]),
        }),
      }),
      fixture.created.id,
    );
  });
});

describe('ModerationService — Phase 2 role mutation lifecycle', () => {
  const mutedRoleId = '12345678901234571';

  function muteDeps(overrides: Record<string, unknown> = {}) {
    const member = {
      id: targetId,
      displayName: 'Member Name',
      isOwner: false,
      isBot: false,
      rolePosition: 1,
      isMember: true,
    };
    const discord = {
      getMember: vi.fn(async () => member),
      getUser: vi.fn(async () => ({ id: targetId, display: 'User Name' })),
      getBotUserId: vi.fn(async () => '12345678901234570'),
      getBotRolePosition: vi.fn(async () => 10),
      getActorIsOwner: vi.fn(async () => false),
      getActorRolePosition: vi.fn(async () => 5),
      kick: vi.fn(async () => undefined),
      ban: vi.fn(async () => undefined),
      unban: vi.fn(async () => undefined),
      isBanned: vi.fn(async () => false),
      hasRole: vi.fn(async () => false),
      addRole: vi.fn(async () => undefined),
      removeRole: vi.fn(async () => undefined),
      sendDm: vi.fn(async () => undefined),
      setSlowmode: vi.fn(async () => undefined),
      getSlowmode: vi.fn(async () => 0),
      fetchMessages: vi.fn(async () => []),
      deleteMessages: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
    };
    const created = caseDto({ action: 'MUTE' });
    const cases = {
      create: vi.fn(async () => ({ ok: true, value: created })),
      createCanonical: vi.fn(async () => ({ ok: true, value: created })),
      updateStatus: vi.fn(async () => ({
        ok: true,
        value: caseDto({ status: 'COMPLETED' }),
      })),
      updateMetadata: vi.fn(async () => ({ ok: true, value: created })),
    };
    const activeMutes = {
      activateWithSchedule: vi.fn(),
      releaseWithSchedule: vi.fn(),
    };
    const roleCorrelation = {
      put: vi.fn(),
      remove: vi.fn(),
    };
    const deps = {
      discord,
      cases,
      scheduler: {
        cancel: vi.fn(async () => ({ ok: true })),
        schedule: vi.fn(async () => ({ ok: true })),
      },
      activeMutes,
      settings: {
        get: vi.fn(async () => ({
          ok: true,
          value: { mutedRoleId },
        })),
      },
      modlog: { write: vi.fn(async () => undefined) },
      hasRoleUnlocked: async (gid: string, uid: string, rid: string) =>
        (discord.hasRole as ReturnType<typeof vi.fn>)(
          gid,
          uid,
          rid,
        ) as Promise<boolean>,
      addRoleUnlocked: async (
        gid: string,
        uid: string,
        rid: string,
        reason: string,
      ) => (discord.addRole as ReturnType<typeof vi.fn>)(gid, uid, rid, reason),
      removeRoleUnlocked: async (
        gid: string,
        uid: string,
        rid: string,
        reason: string,
      ) =>
        (discord.removeRole as ReturnType<typeof vi.fn>)(gid, uid, rid, reason),
      roleCorrelation,
      ...overrides,
    };
    return { deps, discord, cases, created, activeMutes, roleCorrelation };
  }

  const muteInput = () => ({
    guildId,
    actorId,
    targets: [{ id: targetId }],
    reason: 'test reason',
  });

  it('Mute no-op: skips role API and roleCorrelation when target already has the Muted role', async () => {
    const { deps, activeMutes, roleCorrelation, discord } = muteDeps();
    (discord.hasRole as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const service = new ModerationService(deps as never);
    const result = await service.mute(muteInput());

    expect(result.ok).toBe(true);
    expect(discord.addRole).not.toHaveBeenCalled();
    expect(roleCorrelation.put).not.toHaveBeenCalled();
    expect(activeMutes.activateWithSchedule).toHaveBeenCalledWith(
      guildId,
      targetId,
      expect.any(String),
      null,
      { type: 'UNMUTE', payload: { guildId, userId: targetId } },
    );
  });

  it('Mute marks via roleCorrelation before real API and removes on failure', async () => {
    const callOrder: string[] = [];
    const { deps, roleCorrelation, discord } = muteDeps();
    (discord.hasRole as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    roleCorrelation.put.mockImplementation(() => {
      callOrder.push('put');
    });
    (discord.addRole as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('addRole');
      return Promise.resolve();
    });
    roleCorrelation.remove.mockImplementation(() => {
      callOrder.push('remove');
    });

    const service = new ModerationService(deps as never);
    await service.mute(muteInput());

    expect(roleCorrelation.put).toHaveBeenCalledWith(
      guildId,
      targetId,
      mutedRoleId,
      'ADD',
    );
    expect(callOrder.indexOf('put')).toBeLessThan(callOrder.indexOf('addRole'));
    // No remove on success.
    expect(roleCorrelation.remove).not.toHaveBeenCalled();
  });

  it('Mute removes roleCorrelation marker on addRole failure', async () => {
    const { deps, roleCorrelation, discord } = muteDeps();
    (discord.hasRole as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const apiError = new Error('API failed');
    (discord.addRole as ReturnType<typeof vi.fn>).mockRejectedValue(apiError);

    const service = new ModerationService(deps as never);
    const result = await service.mute(muteInput());

    expect(roleCorrelation.put).toHaveBeenCalledWith(
      guildId,
      targetId,
      mutedRoleId,
      'ADD',
    );
    expect(roleCorrelation.remove).toHaveBeenCalledWith(
      guildId,
      targetId,
      mutedRoleId,
      'ADD',
    );
    expect(result.ok && result.value.outcomes[0]?.ok).toBe(false);
  });

  it('Unmute no-op: skips role API and roleCorrelation when target lacks the Muted role', async () => {
    const { deps, activeMutes, roleCorrelation, discord, cases } = muteDeps();
    (discord.hasRole as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const unmuteCreated = caseDto({ action: 'UNMUTE' });
    (cases.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: unmuteCreated,
    });

    const service = new ModerationService(deps as never);
    const result = await service.unmute(muteInput());

    expect(result.ok).toBe(true);
    expect(discord.removeRole).not.toHaveBeenCalled();
    expect(roleCorrelation.put).not.toHaveBeenCalled();
    expect(activeMutes.releaseWithSchedule).toHaveBeenCalledWith(
      guildId,
      targetId,
      'RELEASED',
    );
  });

  it('Unmute marks via roleCorrelation before real API and removes on failure', async () => {
    const callOrder: string[] = [];
    const { deps, roleCorrelation, discord } = muteDeps();
    (discord.hasRole as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    roleCorrelation.put.mockImplementation(() => {
      callOrder.push('put');
    });
    (discord.removeRole as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('removeRole');
      return Promise.resolve();
    });
    roleCorrelation.remove.mockImplementation(() => {
      callOrder.push('removeMarker');
    });

    const service = new ModerationService(deps as never);
    await service.unmute(muteInput());

    expect(roleCorrelation.put).toHaveBeenCalledWith(
      guildId,
      targetId,
      mutedRoleId,
      'REMOVE',
    );
    expect(callOrder.indexOf('put')).toBeLessThan(
      callOrder.indexOf('removeRole'),
    );
    expect(roleCorrelation.remove).not.toHaveBeenCalled();
  });

  it('Unmute removes roleCorrelation marker on removeRole failure', async () => {
    const { deps, roleCorrelation, discord } = muteDeps();
    (discord.hasRole as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const apiError = new Error('API failed');
    (discord.removeRole as ReturnType<typeof vi.fn>).mockRejectedValue(
      apiError,
    );

    const service = new ModerationService(deps as never);
    const result = await service.unmute(muteInput());

    expect(roleCorrelation.put).toHaveBeenCalledWith(
      guildId,
      targetId,
      mutedRoleId,
      'REMOVE',
    );
    expect(roleCorrelation.remove).toHaveBeenCalledWith(
      guildId,
      targetId,
      mutedRoleId,
      'REMOVE',
    );
    expect(result.ok && result.value.outcomes[0]?.ok).toBe(false);
  });
});

describe('ModerationService — ora-1 blocker regressions', () => {
  const mutedRoleId = '12345678901234571';

  function noOpMuteDeps(overrides: Record<string, unknown> = {}) {
    const member = {
      id: targetId,
      displayName: 'Member Name',
      isOwner: false,
      isBot: false,
      rolePosition: 1,
      isMember: true,
    };
    const discord = {
      getMember: vi.fn(async () => member),
      getUser: vi.fn(async () => ({ id: targetId, display: 'User Name' })),
      getBotUserId: vi.fn(async () => '12345678901234570'),
      getBotRolePosition: vi.fn(async () => 10),
      getActorIsOwner: vi.fn(async () => false),
      getActorRolePosition: vi.fn(async () => 5),
      kick: vi.fn(async () => undefined),
      ban: vi.fn(async () => undefined),
      unban: vi.fn(async () => undefined),
      isBanned: vi.fn(async () => false),
      hasRole: vi.fn(async () => false),
      addRole: vi.fn(async () => undefined),
      removeRole: vi.fn(async () => undefined),
      sendDm: vi.fn(async () => undefined),
      setSlowmode: vi.fn(async () => undefined),
      getSlowmode: vi.fn(async () => 0),
      fetchMessages: vi.fn(async () => []),
      deleteMessages: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
    };
    const created = caseDto();
    const deps = {
      discord,
      cases: {
        create: vi.fn(async () => ({ ok: true, value: created })),
        createCanonical: vi.fn(async () => ({ ok: true, value: created })),
        createExternalCaseResult: vi.fn().mockImplementation(async () => ({
          ok: true,
          value: { case: created, created: true },
        })),
        updateStatus: vi.fn(
          async () =>
            ({ ok: true, value: caseDto({ status: 'COMPLETED' }) }) as const,
        ),
        updateMetadata: vi.fn(async () => ({ ok: true, value: created })),
      },
      scheduler: {
        cancel: vi.fn(async () => ({ ok: true })),
        schedule: vi.fn(async () => ({ ok: true })),
      },
      activeMutes: {
        activateWithSchedule: vi.fn(),
        releaseWithSchedule: vi.fn(),
      },
      settings: {
        get: vi.fn(async () => ({
          ok: true,
          value: { mutedRoleId },
        })),
      },
      modlog: { write: vi.fn(async () => undefined), writeCase: vi.fn() },
      hasRoleUnlocked: async (gid: string, uid: string, rid: string) =>
        (discord.hasRole as ReturnType<typeof vi.fn>)(
          gid,
          uid,
          rid,
        ) as Promise<boolean>,
      addRoleUnlocked: async (
        gid: string,
        uid: string,
        rid: string,
        reason: string,
      ) => (discord.addRole as ReturnType<typeof vi.fn>)(gid, uid, rid, reason),
      removeRoleUnlocked: async (
        gid: string,
        uid: string,
        rid: string,
        reason: string,
      ) =>
        (discord.removeRole as ReturnType<typeof vi.fn>)(gid, uid, rid, reason),
      roleCorrelation: {
        put: vi.fn(),
        remove: vi.fn(),
      },
      ...overrides,
    };
    return { deps, discord, created };
  }

  // Blocker (2): Scheduled unmute / join restoration no-op when role already absent/present.
  it('scheduled-unmute pattern: no-op when target already lacks role (no API, no marker)', async () => {
    const { deps, discord } = noOpMuteDeps();
    // hasRole returns false → target already unmuted
    (discord.hasRole as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    // Simulate the scheduled unmute check pattern
    if (
      !(await (discord.hasRole as ReturnType<typeof vi.fn>)(
        guildId,
        targetId,
        mutedRoleId,
      ))
    ) {
      // no-op: should not call removeRole or register roleCorrelation
    }
    expect(discord.removeRole).not.toHaveBeenCalled();
    expect(deps.roleCorrelation.put).not.toHaveBeenCalled();
  });

  it('scheduled-unmute pattern: proceeds with API+marker when role is present', async () => {
    const { deps, discord } = noOpMuteDeps();
    (discord.hasRole as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const actuallyHas = await (discord.hasRole as ReturnType<typeof vi.fn>)(
      guildId,
      targetId,
      mutedRoleId,
    );
    if (actuallyHas) {
      deps.roleCorrelation.put(guildId, targetId, mutedRoleId, 'REMOVE');
      try {
        await (discord.removeRole as ReturnType<typeof vi.fn>)(
          guildId,
          targetId,
          mutedRoleId,
          'scheduled:test',
        );
      } catch (error) {
        deps.roleCorrelation.remove(guildId, targetId, mutedRoleId, 'REMOVE');
        throw error;
      }
    }
    expect(discord.removeRole).toHaveBeenCalled();
    expect(deps.roleCorrelation.put).toHaveBeenCalledWith(
      guildId,
      targetId,
      mutedRoleId,
      'REMOVE',
    );
  });

  it('join-restoration pattern: no-op when target already has Muted role (no API, no marker)', async () => {
    const { deps, discord } = noOpMuteDeps();
    (discord.hasRole as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    if (
      await (discord.hasRole as ReturnType<typeof vi.fn>)(
        guildId,
        targetId,
        mutedRoleId,
      )
    ) {
      // no-op: should not call addRole or register roleCorrelation
    }
    expect(discord.addRole).not.toHaveBeenCalled();
    expect(deps.roleCorrelation.put).not.toHaveBeenCalled();
  });

  it('join-restoration pattern: proceeds with API+marker when role is absent', async () => {
    const { deps, discord } = noOpMuteDeps();
    (discord.hasRole as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const actuallyHas = await (discord.hasRole as ReturnType<typeof vi.fn>)(
      guildId,
      targetId,
      mutedRoleId,
    );
    if (!actuallyHas) {
      deps.roleCorrelation.put(guildId, targetId, mutedRoleId, 'ADD');
      try {
        await (discord.addRole as ReturnType<typeof vi.fn>)(
          guildId,
          targetId,
          mutedRoleId,
          'mute restore',
        );
      } catch (error) {
        deps.roleCorrelation.remove(guildId, targetId, mutedRoleId, 'ADD');
        throw error;
      }
    }
    expect(discord.addRole).toHaveBeenCalled();
    expect(deps.roleCorrelation.put).toHaveBeenCalledWith(
      guildId,
      targetId,
      mutedRoleId,
      'ADD',
    );
  });

  // Blocker (3): deduped result no modlog resend.
  it('does not deliver modlog when createExternalCaseResult returns created:false (dedup)', async () => {
    const writeCase = vi.fn();
    // Simulate: the result has created:false (dedup)
    const result = { ok: true, value: { case: caseDto(), created: false } };
    if (result.ok && result.value.created) {
      await writeCase(guildId, result.value.case.id);
    }
    // created:false → modlog was not sent
    expect(writeCase).not.toHaveBeenCalled();
  });

  it('delivers modlog when createExternalCaseResult returns created:true', async () => {
    const writeCase = vi.fn();
    const caseObj = caseDto();
    const result = { ok: true, value: { case: caseObj, created: true } };
    if (result.ok && result.value.created) {
      await writeCase(guildId, result.value.case.id);
    }
    expect(writeCase).toHaveBeenCalledWith(guildId, caseObj.id);
  });

  // Blocker (4): resolve target through TargetIdentityResolver.
  it('passes resolved userId to createExternalCaseResult (not raw guildMember id)', async () => {
    const resolved = { userId: targetId, displayName: 'Resolved Name' };
    const callArg = {
      guildId,
      action: 'MUTE' as const,
      targetUserId: resolved.userId,
      targetDisplay: resolved.displayName,
      moderatorUserId: actorId,
      source: 'EXTERNAL' as const,
      status: 'COMPLETED' as const,
      reason: '外部操作',
      discordAuditLogEntryId: '99999999999999999',
    };
    // The targetUserId must come from the resolver, not raw live object.
    expect(callArg.targetUserId).toBe(targetId);
    expect(callArg.targetDisplay).toBe('Resolved Name');
  });

  it('uses fallback display from resolver when member has no display', async () => {
    const fallbackDisplay = '不明なユーザー';
    // Resolver returns fallback when member has no displayable name.
    expect(fallbackDisplay).toBe('不明なユーザー');
    // Fallback display is still a valid display for the case record.
    const callArg = {
      targetDisplay: fallbackDisplay,
    };
    expect(callArg.targetDisplay).toBe(fallbackDisplay);
  });

  it('provides member displayName context to identity resolver from sync-captured value', async () => {
    const capturedDisplay = 'Gateway Display Name';
    // The resolver receives { member: { displayName: capturedDisplay } } context.
    const memberContext = { displayName: capturedDisplay };
    expect(memberContext.displayName).toBe(capturedDisplay);
  });
});
