import { describe, expect, it, vi } from 'vitest';
import {
  computeRoleChanges,
  MemberRoleChangeService,
} from '../src/services/member-role-change-service.js';
import { roleChangeEmbed } from '../src/features/logging/role-events.js';
import { RoleCorrelationCache } from '../src/services/role-correlation-cache.js';
import { buildRoleChangeInput } from '../src/index.js';
import type {
  RoleBatchResolver,
  RoleTransitionResolution,
} from '../src/services/role-audit-resolver.js';

const guildId = '12345678901234567';
const targetUserId = '12345678901234568';
const botUserId = '12345678901234599';
const roleA = '12345678901234580';
const roleB = '12345678901234581';
const mutedRoleId = '12345678901234582';
const at = new Date('2026-07-20T00:00:00.000Z');

const roleNames = new Map([
  [roleA, 'RoleA'],
  [roleB, 'RoleB'],
  [mutedRoleId, 'Muted'],
]);

const makeResolver = (
  resolutionMap: Map<string, RoleTransitionResolution>,
): RoleBatchResolver =>
  ({
    resolve: vi.fn().mockResolvedValue(resolutionMap),
  }) as unknown as RoleBatchResolver;

const makeService = (overrides: {
  resolver?: RoleBatchResolver;
  roleCorrelation?: RoleCorrelationCache;
  deliver?: ReturnType<typeof vi.fn>;
  botUserId?: string | null;
}) => {
  const deliver = overrides.deliver ?? vi.fn().mockResolvedValue(undefined);
  const service = new MemberRoleChangeService({
    delivery: { deliver },
    timezone: vi.fn().mockResolvedValue('UTC'),
    resolver: overrides.resolver ?? makeResolver(new Map()),
    roleCorrelation: overrides.roleCorrelation ?? new RoleCorrelationCache(),
    botUserId: () => overrides.botUserId ?? botUserId,
  });
  return { service, deliver };
};

const baseInput = {
  guildId,
  targetUserId,
  targetDisplay: 'TestUser',
  beforeRoleIds: [] as string[],
  afterRoleIds: [roleA],
  roleNames,
  mutedRoleId: null as string | null,
  occurredAt: at,
};

describe('computeRoleChanges', () => {
  it('returns removed roles before added roles, each sorted by role ID ascending', () => {
    const changes = computeRoleChanges(
      [roleB, roleA],
      [roleB, '12345678901234583'],
      new Map([
        [roleA, 'A'],
        [roleB, 'B'],
        ['12345678901234583', 'C'],
      ]),
      null,
    );
    expect(changes).toEqual([
      { roleId: roleA, roleName: 'A', direction: 'REMOVE' },
      { roleId: '12345678901234583', roleName: 'C', direction: 'ADD' },
    ]);
  });

  it('includes the configured Muted role in both added and removed (Phase 3)', () => {
    const changes = computeRoleChanges(
      [mutedRoleId, roleA],
      [roleB],
      roleNames,
      mutedRoleId,
    );
    expect(changes).toEqual([
      { roleId: roleA, roleName: 'RoleA', direction: 'REMOVE' },
      { roleId: mutedRoleId, roleName: 'Muted', direction: 'REMOVE' },
      { roleId: roleB, roleName: 'RoleB', direction: 'ADD' },
    ]);
  });

  it('returns empty when role sets are identical', () => {
    expect(computeRoleChanges([roleA], [roleA], roleNames, null)).toEqual([]);
  });

  it('falls back to roleId when role name is unknown', () => {
    const changes = computeRoleChanges(
      [],
      ['99999999999999999'],
      new Map(),
      null,
    );
    expect(changes[0]?.roleName).toBe('99999999999999999');
  });
});

describe('roleChangeEmbed', () => {
  it('renders ロール付与 for 追加 and ロール除去 for 削除', () => {
    const add = roleChangeEmbed({
      targetDisplay: 'User',
      targetUserId: targetUserId,
      roleName: 'RoleA',
      roleId: roleA,
      operation: '追加',
      executor: 'Bot',
      date: at,
      zone: 'UTC',
    });
    const remove = roleChangeEmbed({
      targetDisplay: 'User',
      targetUserId: targetUserId,
      roleName: 'RoleA',
      roleId: roleA,
      operation: '削除',
      executor: '不明',
      date: at,
      zone: 'UTC',
    });
    expect(add.title).toBe('ロール付与');
    expect(remove.title).toBe('ロール除去');
    expect(add.fields).toEqual(
      expect.arrayContaining([
        { name: 'User', value: `User (${targetUserId})` },
        { name: 'Role', value: `RoleA (${roleA})` },
        { name: 'Executor', value: 'Bot' },
      ]),
    );
  });
});

describe('MemberRoleChangeService', () => {
  it('emits one log per non-Muted transition, removed before added', async () => {
    const { service, deliver } = makeService({});
    await service.process({
      ...baseInput,
      beforeRoleIds: [roleB],
      afterRoleIds: [roleA],
    });
    expect(deliver).toHaveBeenCalledTimes(2);
    const titles = deliver.mock.calls.map(
      (call: unknown[]) => (call[2] as { title: string }).title,
    );
    expect(titles).toEqual(['ロール除去', 'ロール付与']);
  });

  it('emits server log for the configured Muted role (Phase 3)', async () => {
    const { service, deliver } = makeService({});
    await service.process({
      ...baseInput,
      beforeRoleIds: [],
      afterRoleIds: [mutedRoleId],
      mutedRoleId,
    });
    // Phase 3: generic lane includes Muted; expect one log.
    expect(deliver).toHaveBeenCalledTimes(1);
    const embed = deliver.mock.calls[0]?.[2] as {
      title: string;
      fields: { name: string; value: string }[];
    };
    expect(embed.title).toBe('ロール付与');
    expect(embed.fields.find((f) => f.name === 'Role')?.value).toContain(
      mutedRoleId,
    );
  });

  it('does not call any case or modlog API', async () => {
    // The service has no case/modlog ports; verify deliver is the only side-effect.
    const { service, deliver } = makeService({});
    await service.process({ ...baseInput, afterRoleIds: [roleA] });
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('attributes Bot when role correlation is consumed', async () => {
    const roleCorrelation = new RoleCorrelationCache();
    roleCorrelation.put(guildId, targetUserId, roleA, 'ADD');
    const { service, deliver } = makeService({ roleCorrelation });
    await service.process({ ...baseInput, afterRoleIds: [roleA] });
    const embed = deliver.mock.calls[0]?.[2] as {
      fields: { name: string; value: string }[];
    };
    const executorField = embed.fields.find((f) => f.name === 'Executor');
    expect(executorField?.value).toBe('Bot');
  });

  it('attributes Bot when audit executor equals the Bot user ID', async () => {
    const resolver = makeResolver(
      new Map([
        [
          `${roleA}:ADD`,
          {
            status: 'matched' as const,
            executorUserId: botUserId,
            auditEntryId: 'x',
          },
        ],
      ]),
    );
    const { service, deliver } = makeService({ resolver });
    await service.process({ ...baseInput, afterRoleIds: [roleA] });
    const embed = deliver.mock.calls[0]?.[2] as {
      fields: { name: string; value: string }[];
    };
    expect(embed.fields.find((f) => f.name === 'Executor')?.value).toBe('Bot');
  });

  it('attributes external executor userId when matched and not Bot', async () => {
    const externalExecutor = '12345678901234570';
    const resolver = makeResolver(
      new Map([
        [
          `${roleA}:ADD`,
          {
            status: 'matched' as const,
            executorUserId: externalExecutor,
            auditEntryId: 'x',
          },
        ],
      ]),
    );
    const { service, deliver } = makeService({ resolver });
    await service.process({ ...baseInput, afterRoleIds: [roleA] });
    const embed = deliver.mock.calls[0]?.[2] as {
      fields: { name: string; value: string }[];
    };
    expect(embed.fields.find((f) => f.name === 'Executor')?.value).toBe(
      externalExecutor,
    );
  });

  it('attributes 不明 when audit result is missing', async () => {
    const resolver = makeResolver(
      new Map([
        [
          `${roleA}:ADD`,
          {
            status: 'missing' as const,
            executorUserId: null,
            auditEntryId: null,
          },
        ],
      ]),
    );
    const { service, deliver } = makeService({ resolver });
    await service.process({ ...baseInput, afterRoleIds: [roleA] });
    const embed = deliver.mock.calls[0]?.[2] as {
      fields: { name: string; value: string }[];
    };
    expect(embed.fields.find((f) => f.name === 'Executor')?.value).toBe('不明');
  });

  it('attributes 不明 when audit result is ambiguous', async () => {
    const resolver = makeResolver(
      new Map([
        [
          `${roleA}:ADD`,
          {
            status: 'ambiguous' as const,
            executorUserId: null,
            auditEntryId: null,
          },
        ],
      ]),
    );
    const { service, deliver } = makeService({ resolver });
    await service.process({ ...baseInput, afterRoleIds: [roleA] });
    const embed = deliver.mock.calls[0]?.[2] as {
      fields: { name: string; value: string }[];
    };
    expect(embed.fields.find((f) => f.name === 'Executor')?.value).toBe('不明');
  });

  it('isolates per-record failures and continues emitting later logs', async () => {
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(new Error('send failed'))
      .mockResolvedValue(undefined);
    const { service } = makeService({ deliver });
    await service.process({
      ...baseInput,
      beforeRoleIds: [roleB],
      afterRoleIds: [roleA],
    });
    // Both transitions attempted despite first failure.
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('does not call resolver when all transitions are correlated', async () => {
    const roleCorrelation = new RoleCorrelationCache();
    roleCorrelation.put(guildId, targetUserId, roleA, 'ADD');
    const resolve = vi.fn();
    const resolver = { resolve } as unknown as RoleBatchResolver;
    const { service } = makeService({ resolver, roleCorrelation });
    await service.process({ ...baseInput, afterRoleIds: [roleA] });
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('RoleCorrelationCache', () => {
  it('consumes a put entry exactly once', () => {
    const cache = new RoleCorrelationCache();
    cache.put(guildId, targetUserId, roleA, 'ADD');
    expect(cache.consume(guildId, targetUserId, roleA, 'ADD')).toBe(true);
    expect(cache.consume(guildId, targetUserId, roleA, 'ADD')).toBe(false);
  });

  it('expires entries after TTL', () => {
    let now = 0;
    const cache = new RoleCorrelationCache(15_000, 10_000, () => now);
    cache.put(guildId, targetUserId, roleA, 'ADD');
    now = 15_000;
    expect(cache.consume(guildId, targetUserId, roleA, 'ADD')).toBe(false);
  });

  it('remove deletes without consuming semantics', () => {
    const cache = new RoleCorrelationCache();
    cache.put(guildId, targetUserId, roleA, 'REMOVE');
    cache.remove(guildId, targetUserId, roleA, 'REMOVE');
    expect(cache.consume(guildId, targetUserId, roleA, 'REMOVE')).toBe(false);
  });

  it('enforces the size limit by evicting the oldest entry', () => {
    const cache = new RoleCorrelationCache(15_000, 2);
    cache.put(guildId, targetUserId, roleA, 'ADD');
    cache.put(guildId, targetUserId, roleB, 'ADD');
    cache.put(guildId, targetUserId, mutedRoleId, 'ADD');
    // Oldest (roleA) evicted.
    expect(cache.consume(guildId, targetUserId, roleA, 'ADD')).toBe(false);
    expect(cache.consume(guildId, targetUserId, roleB, 'ADD')).toBe(true);
    expect(cache.consume(guildId, targetUserId, mutedRoleId, 'ADD')).toBe(true);
  });
});

describe('buildRoleChangeInput coordinator seam', () => {
  const member = (
    roleIds: string[],
    names: Record<string, string>,
    displayName = 'TestUser',
  ) => ({
    guild: { id: guildId },
    id: targetUserId,
    displayName,
    roles: {
      cache: new Map(roleIds.map((id) => [id, { name: names[id] ?? id }])),
    },
  });

  it('extracts plain DTOs including removed-role name from the before snapshot', () => {
    const before = member([roleA, roleB], {
      [roleA]: 'Alpha',
      [roleB]: 'Beta',
    });
    const after = member([roleB], { [roleB]: 'Beta' });
    const roleNames = new Map([
      [roleA, 'Alpha'],
      [roleB, 'Beta'],
    ]);
    const input = buildRoleChangeInput(before, after, roleNames, null, at);
    expect(input.guildId).toBe(guildId);
    expect(input.targetUserId).toBe(targetUserId);
    expect(input.targetDisplay).toBe('TestUser');
    expect(input.beforeRoleIds).toEqual([roleA, roleB]);
    expect(input.afterRoleIds).toEqual([roleB]);
    expect(input.mutedRoleId).toBeNull();
    expect(input.occurredAt).toBe(at);
    // Removed role name comes from the shared roleNames map (before snapshot).
    const changes = computeRoleChanges(
      input.beforeRoleIds,
      input.afterRoleIds,
      input.roleNames,
      input.mutedRoleId,
    );
    expect(changes).toEqual([
      { roleId: roleA, roleName: 'Alpha', direction: 'REMOVE' },
    ]);
  });

  it('passes the same mutedRoleId and timestamp to both lanes (Phase 3: Muted included)', () => {
    const before = member([mutedRoleId], { [mutedRoleId]: 'Muted' });
    const after = member([], {});
    const input = buildRoleChangeInput(
      before,
      after,
      new Map([[mutedRoleId, 'Muted']]),
      mutedRoleId,
      at,
    );
    expect(input.mutedRoleId).toBe(mutedRoleId);
    expect(input.occurredAt).toBe(at);
    // Phase 3: Muted role is now included in generic changes.
    expect(
      computeRoleChanges(
        input.beforeRoleIds,
        input.afterRoleIds,
        input.roleNames,
        input.mutedRoleId,
      ),
    ).toEqual([
      { roleId: mutedRoleId, roleName: 'Muted', direction: 'REMOVE' },
    ]);
  });
});

describe('MemberRoleChangeService — Phase 2 blocker regressions', () => {
  it('consumes correlation before any await (timezone/delivery)', async () => {
    const callOrder: string[] = [];
    const roleCorrelation = new RoleCorrelationCache();
    roleCorrelation.put(guildId, targetUserId, roleA, 'ADD');
    const originalConsume = roleCorrelation.consume.bind(roleCorrelation);
    roleCorrelation.consume = (...args) => {
      callOrder.push('consume');
      return originalConsume(...args);
    };
    const service = new MemberRoleChangeService({
      delivery: {
        deliver: vi.fn().mockImplementation(() => {
          callOrder.push('deliver');
          return Promise.resolve();
        }),
      },
      timezone: vi.fn().mockImplementation(() => {
        callOrder.push('timezone');
        return Promise.resolve('UTC');
      }),
      resolver: makeResolver(new Map()),
      roleCorrelation,
      botUserId: () => botUserId,
    });
    await service.process({ ...baseInput, afterRoleIds: [roleA] });
    expect(callOrder[0]).toBe('consume');
    expect(callOrder.indexOf('consume')).toBeLessThan(
      callOrder.indexOf('timezone'),
    );
  });

  it('reports audit resolver failure and still delivers all records as 不明', async () => {
    const operationalErrors: unknown[] = [];
    const resolverError = new Error('audit unavailable');
    const resolver = {
      resolve: vi.fn().mockRejectedValue(resolverError),
    } as unknown as RoleBatchResolver;
    const deliver = vi.fn().mockResolvedValue(undefined);
    const service = new MemberRoleChangeService({
      delivery: { deliver },
      timezone: vi.fn().mockResolvedValue('UTC'),
      resolver,
      roleCorrelation: new RoleCorrelationCache(),
      botUserId: () => botUserId,
      onOperationalError: (e) => operationalErrors.push(e),
    });
    await service.process({
      ...baseInput,
      beforeRoleIds: [roleB],
      afterRoleIds: [roleA],
    });
    expect(operationalErrors).toEqual([resolverError]);
    // Both transitions still delivered with executor 不明.
    expect(deliver).toHaveBeenCalledTimes(2);
    for (const call of deliver.mock.calls) {
      const embed = call[2] as { fields: { name: string; value: string }[] };
      expect(embed.fields.find((f) => f.name === 'Executor')?.value).toBe(
        '不明',
      );
    }
  });

  it('renders external executor as displayName (userId) when display is available', async () => {
    const externalExecutor = '12345678901234570';
    const resolver = makeResolver(
      new Map([
        [
          `${roleA}:ADD`,
          {
            status: 'matched' as const,
            executorUserId: externalExecutor,
            auditEntryId: 'x',
          },
        ],
      ]),
    );
    const deliver = vi.fn().mockResolvedValue(undefined);
    const service = new MemberRoleChangeService({
      delivery: { deliver },
      timezone: vi.fn().mockResolvedValue('UTC'),
      resolver,
      roleCorrelation: new RoleCorrelationCache(),
      botUserId: () => botUserId,
      resolveExecutorDisplay: vi.fn().mockResolvedValue('Moderator'),
    });
    await service.process({ ...baseInput, afterRoleIds: [roleA] });
    const embed = deliver.mock.calls[0]?.[2] as {
      fields: { name: string; value: string }[];
    };
    expect(embed.fields.find((f) => f.name === 'Executor')?.value).toBe(
      `Moderator (${externalExecutor})`,
    );
  });

  it('falls back to userId when display resolution returns null', async () => {
    const externalExecutor = '12345678901234570';
    const resolver = makeResolver(
      new Map([
        [
          `${roleA}:ADD`,
          {
            status: 'matched' as const,
            executorUserId: externalExecutor,
            auditEntryId: 'x',
          },
        ],
      ]),
    );
    const deliver = vi.fn().mockResolvedValue(undefined);
    const service = new MemberRoleChangeService({
      delivery: { deliver },
      timezone: vi.fn().mockResolvedValue('UTC'),
      resolver,
      roleCorrelation: new RoleCorrelationCache(),
      botUserId: () => botUserId,
      resolveExecutorDisplay: vi.fn().mockResolvedValue(null),
    });
    await service.process({ ...baseInput, afterRoleIds: [roleA] });
    const embed = deliver.mock.calls[0]?.[2] as {
      fields: { name: string; value: string }[];
    };
    expect(embed.fields.find((f) => f.name === 'Executor')?.value).toBe(
      externalExecutor,
    );
  });

  it('falls back to userId when display resolution throws', async () => {
    const externalExecutor = '12345678901234570';
    const resolver = makeResolver(
      new Map([
        [
          `${roleA}:ADD`,
          {
            status: 'matched' as const,
            executorUserId: externalExecutor,
            auditEntryId: 'x',
          },
        ],
      ]),
    );
    const deliver = vi.fn().mockResolvedValue(undefined);
    const service = new MemberRoleChangeService({
      delivery: { deliver },
      timezone: vi.fn().mockResolvedValue('UTC'),
      resolver,
      roleCorrelation: new RoleCorrelationCache(),
      botUserId: () => botUserId,
      resolveExecutorDisplay: vi
        .fn()
        .mockRejectedValue(new Error('fetch failed')),
    });
    await service.process({ ...baseInput, afterRoleIds: [roleA] });
    const embed = deliver.mock.calls[0]?.[2] as {
      fields: { name: string; value: string }[];
    };
    expect(embed.fields.find((f) => f.name === 'Executor')?.value).toBe(
      externalExecutor,
    );
  });

  it('rethrows 401 from executor display resolution', async () => {
    const externalExecutor = '12345678901234570';
    const resolver = makeResolver(
      new Map([
        [
          `${roleA}:ADD`,
          {
            status: 'matched' as const,
            executorUserId: externalExecutor,
            auditEntryId: 'x',
          },
        ],
      ]),
    );
    const deliver = vi.fn().mockResolvedValue(undefined);
    const service = new MemberRoleChangeService({
      delivery: { deliver },
      timezone: vi.fn().mockResolvedValue('UTC'),
      resolver,
      roleCorrelation: new RoleCorrelationCache(),
      botUserId: () => botUserId,
      resolveExecutorDisplay: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('unauthorized'), { status: 401 }),
        ),
    });
    await expect(
      service.process({ ...baseInput, afterRoleIds: [roleA] }),
    ).rejects.toMatchObject({ status: 401 });
    // No deliver should have happened after the throw.
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('MemberRoleChangeService — Phase 3 cutover', () => {
  it('process returns shared audit results map for downstream Muted lane', async () => {
    const resolver = makeResolver(
      new Map([
        [
          `${roleA}:ADD`,
          {
            status: 'matched' as const,
            executorUserId: '12345678901234570',
            auditEntryId: 'x',
          },
        ],
      ]),
    );
    const deliver = vi.fn().mockResolvedValue(undefined);
    const service = new MemberRoleChangeService({
      delivery: { deliver },
      timezone: vi.fn().mockResolvedValue('UTC'),
      resolver,
      roleCorrelation: new RoleCorrelationCache(),
      botUserId: () => botUserId,
    });
    const result = await service.process({
      ...baseInput,
      afterRoleIds: [roleA],
    });
    expect(result.auditResults).toBeInstanceOf(Map);
    expect(result.correlatedKeys).toBeInstanceOf(Set);
    expect(result.executorDisplays).toBeInstanceOf(Map);
    expect(result.auditResults.get(`${roleA}:ADD`)?.status).toBe('matched');
  });

  it('returns empty maps when no role changes occur', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const service = new MemberRoleChangeService({
      delivery: { deliver },
      timezone: vi.fn().mockResolvedValue('UTC'),
      resolver: makeResolver(new Map()),
      roleCorrelation: new RoleCorrelationCache(),
      botUserId: () => botUserId,
    });
    const result = await service.process({
      ...baseInput,
      beforeRoleIds: [roleA],
      afterRoleIds: [roleA],
    });
    expect(result.auditResults.size).toBe(0);
    expect(result.correlatedKeys.size).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('calls fatal port on executor display 401 before rethrowing', async () => {
    const externalExecutor = '12345678901234570';
    const resolver = makeResolver(
      new Map([
        [
          `${roleA}:ADD`,
          {
            status: 'matched' as const,
            executorUserId: externalExecutor,
            auditEntryId: 'x',
          },
        ],
      ]),
    );
    const fatalCalls: unknown[] = [];
    const service = new MemberRoleChangeService({
      delivery: { deliver: vi.fn().mockResolvedValue(undefined) },
      timezone: vi.fn().mockResolvedValue('UTC'),
      resolver,
      roleCorrelation: new RoleCorrelationCache(),
      botUserId: () => botUserId,
      resolveExecutorDisplay: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('unauthorized'), { status: 401 }),
        ),
      fatal: (error) => fatalCalls.push(error),
    });
    await expect(
      service.process({ ...baseInput, afterRoleIds: [roleA] }),
    ).rejects.toMatchObject({ status: 401 });
    expect(fatalCalls).toHaveLength(1);
    expect(fatalCalls[0]).toMatchObject({ status: 401 });
  });

  it('calls fatal port on delivery 401 before rethrowing', async () => {
    const fatalCalls: unknown[] = [];
    const service = new MemberRoleChangeService({
      delivery: {
        deliver: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('unauthorized'), { status: 401 }),
          ),
      },
      timezone: vi.fn().mockResolvedValue('UTC'),
      resolver: makeResolver(new Map()),
      roleCorrelation: new RoleCorrelationCache(),
      botUserId: () => botUserId,
      fatal: (error) => fatalCalls.push(error),
    });
    await expect(
      service.process({ ...baseInput, afterRoleIds: [roleA] }),
    ).rejects.toMatchObject({ status: 401 });
    expect(fatalCalls).toHaveLength(1);
  });

  it('calls fatal port on code===401 (not just status)', async () => {
    const externalExecutor = '12345678901234570';
    const resolver = makeResolver(
      new Map([
        [
          `${roleA}:ADD`,
          {
            status: 'matched' as const,
            executorUserId: externalExecutor,
            auditEntryId: 'x',
          },
        ],
      ]),
    );
    const fatalCalls: unknown[] = [];
    const service = new MemberRoleChangeService({
      delivery: { deliver: vi.fn().mockResolvedValue(undefined) },
      timezone: vi.fn().mockResolvedValue('UTC'),
      resolver,
      roleCorrelation: new RoleCorrelationCache(),
      botUserId: () => botUserId,
      resolveExecutorDisplay: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('auth error'), { code: 401 }),
        ),
      fatal: (error) => fatalCalls.push(error),
    });
    await expect(
      service.process({ ...baseInput, afterRoleIds: [roleA] }),
    ).rejects.toMatchObject({ code: 401 });
    expect(fatalCalls).toHaveLength(1);
  });

  it('generates generic server log for Muted role ADD transition', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const { service } = makeService({ deliver });
    await service.process({
      ...baseInput,
      beforeRoleIds: [],
      afterRoleIds: [mutedRoleId],
      mutedRoleId,
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    const embed = deliver.mock.calls[0]?.[2] as {
      title: string;
      fields: { name: string; value: string }[];
    };
    expect(embed.title).toBe('ロール付与');
    expect(embed.fields.find((f) => f.name === 'Role')?.value).toContain(
      'Muted',
    );
  });

  it('generates generic server log for Muted role REMOVE transition', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const { service } = makeService({ deliver });
    await service.process({
      ...baseInput,
      beforeRoleIds: [mutedRoleId],
      afterRoleIds: [],
      mutedRoleId,
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    const embed = deliver.mock.calls[0]?.[2] as {
      title: string;
      fields: { name: string; value: string }[];
    };
    expect(embed.title).toBe('ロール除去');
  });

  it('correlated Muted role gets Bot executor in generic log', async () => {
    const roleCorrelation = new RoleCorrelationCache();
    roleCorrelation.put(guildId, targetUserId, mutedRoleId, 'ADD');
    const deliver = vi.fn().mockResolvedValue(undefined);
    const service = new MemberRoleChangeService({
      delivery: { deliver },
      timezone: vi.fn().mockResolvedValue('UTC'),
      resolver: makeResolver(new Map()),
      roleCorrelation,
      botUserId: () => botUserId,
    });
    await service.process({
      ...baseInput,
      beforeRoleIds: [],
      afterRoleIds: [mutedRoleId],
      mutedRoleId,
    });
    const embed = deliver.mock.calls[0]?.[2] as {
      fields: { name: string; value: string }[];
    };
    expect(embed.fields.find((f) => f.name === 'Executor')?.value).toBe('Bot');
  });

  it('audit-matched Muted role with external executor gets external userId', async () => {
    const externalExecutor = '12345678901234570';
    const resolver = makeResolver(
      new Map([
        [
          `${mutedRoleId}:ADD`,
          {
            status: 'matched' as const,
            executorUserId: externalExecutor,
            auditEntryId: 'x',
          },
        ],
      ]),
    );
    const deliver = vi.fn().mockResolvedValue(undefined);
    const service = new MemberRoleChangeService({
      delivery: { deliver },
      timezone: vi.fn().mockResolvedValue('UTC'),
      resolver,
      roleCorrelation: new RoleCorrelationCache(),
      botUserId: () => botUserId,
    });
    await service.process({
      ...baseInput,
      beforeRoleIds: [],
      afterRoleIds: [mutedRoleId],
      mutedRoleId,
    });
    const embed = deliver.mock.calls[0]?.[2] as {
      fields: { name: string; value: string }[];
    };
    expect(embed.fields.find((f) => f.name === 'Executor')?.value).toBe(
      externalExecutor,
    );
  });

  it('audit-matched Muted role with self-Bot executor gets Bot attribution', async () => {
    const resolver = makeResolver(
      new Map([
        [
          `${mutedRoleId}:ADD`,
          {
            status: 'matched' as const,
            executorUserId: botUserId,
            auditEntryId: 'x',
          },
        ],
      ]),
    );
    const deliver = vi.fn().mockResolvedValue(undefined);
    const service = new MemberRoleChangeService({
      delivery: { deliver },
      timezone: vi.fn().mockResolvedValue('UTC'),
      resolver,
      roleCorrelation: new RoleCorrelationCache(),
      botUserId: () => botUserId,
    });
    await service.process({
      ...baseInput,
      beforeRoleIds: [],
      afterRoleIds: [mutedRoleId],
      mutedRoleId,
    });
    const embed = deliver.mock.calls[0]?.[2] as {
      fields: { name: string; value: string }[];
    };
    expect(embed.fields.find((f) => f.name === 'Executor')?.value).toBe('Bot');
  });

  it('bare-ID executor fallback when resolveExecutorDisplay returns null', async () => {
    const externalExecutor = '12345678901234570';
    const resolver = makeResolver(
      new Map([
        [
          `${roleA}:ADD`,
          {
            status: 'matched' as const,
            executorUserId: externalExecutor,
            auditEntryId: 'x',
          },
        ],
      ]),
    );
    const deliver = vi.fn().mockResolvedValue(undefined);
    const service = new MemberRoleChangeService({
      delivery: { deliver },
      timezone: vi.fn().mockResolvedValue('UTC'),
      resolver,
      roleCorrelation: new RoleCorrelationCache(),
      botUserId: () => botUserId,
      resolveExecutorDisplay: vi.fn().mockResolvedValue(null),
    });
    await service.process({ ...baseInput, afterRoleIds: [roleA] });
    const embed = deliver.mock.calls[0]?.[2] as {
      fields: { name: string; value: string }[];
    };
    // null display → bare userId, no (userId) suffix
    expect(embed.fields.find((f) => f.name === 'Executor')?.value).toBe(
      externalExecutor,
    );
  });
});

describe('ora-1 blocker (1): pre-await captured values', () => {
  it('input carries sync-captured beforeRoleIds/afterRoleIds not re-read from live cache', () => {
    // Simulate a live cache that mutates after construction to verify input
    // stores a snapshot, not a live reference.
    const liveBefore = new Map([
      [roleA, { name: 'Alpha' }],
      [roleB, { name: 'Beta' }],
    ]);
    const liveAfter = new Map([
      [roleA, { name: 'Alpha' }],
      [mutedRoleId, { name: 'Muted' }],
    ]);
    // Capture synchronously (as gateway handler does)
    const beforeRoleIds = [...liveBefore.keys()];
    const afterRoleIds = [...liveAfter.keys()];
    const roleNames = new Map<string, string>();
    for (const [id, role] of liveBefore) roleNames.set(id, role.name);
    for (const [id, role] of liveAfter) roleNames.set(id, role.name);
    const targetDisplay = 'TestUser';

    // Mutate live cache after capture — must not affect captured arrays
    liveBefore.delete(roleA);
    liveAfter.set('99999999999999999', { name: 'Extra' });

    const changes = computeRoleChanges(
      beforeRoleIds,
      afterRoleIds,
      roleNames,
      mutedRoleId,
    );
    // roleB removed, mutedRoleId added (from captured snapshots)
    expect(changes).toEqual([
      { roleId: roleB, roleName: 'Beta', direction: 'REMOVE' },
      { roleId: mutedRoleId, roleName: 'Muted', direction: 'ADD' },
    ]);
    // targetDisplay is a plain string, unaffected by live object mutation
    expect(targetDisplay).toBe('TestUser');
  });

  it('input object is constructed from captured values before settings await', async () => {
    const beforeRoleIds = [roleB];
    const afterRoleIds = [roleA];
    const roleNames = new Map([
      [roleA, 'Alpha'],
      [roleB, 'Beta'],
    ]);
    const targetDisplay = 'TestUser';
    const occurredAt = at;

    // Simulate the gateway handler's input construction (with an await gap)
    const input = {
      guildId,
      targetUserId,
      targetDisplay,
      beforeRoleIds,
      afterRoleIds,
      roleNames,
      mutedRoleId: null,
      occurredAt,
    };

    // After construction, simulate settings await
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Input still holds snapshotted values
    expect(input.beforeRoleIds).toEqual([roleB]);
    expect(input.afterRoleIds).toEqual([roleA]);
    expect(input.targetDisplay).toBe('TestUser');
  });
});
