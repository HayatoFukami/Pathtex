import { describe, expect, it, vi } from 'vitest';
import {
  ExternalAuditPolicy,
  ExternalEventSchema,
  ExternalEventService,
  externalActionForEvent,
  uniqueExternalAuditMatch,
} from '../src/services/external-event-service.js';
import { CorrelationCache } from '../src/services/correlation-cache.js';

const guildId = '12345678901234567';
const targetUserId = '12345678901234568';
const executorUserId = '12345678901234569';
const auditId = '12345678901234570';
const at = new Date('2026-07-20T00:00:00.000Z');

const audit = {
  id: auditId,
  action: 'MEMBER_BAN_ADD' as const,
  targetUserId,
  executorUserId,
  createdAt: at,
};

describe('external audit and snapshot lane', () => {
  it('uses bounded offsets and a five-second window with limit 25', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const reader = {
      list: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([audit]),
    };
    const policy = new ExternalAuditPolicy(
      reader,
      (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
        return Promise.resolve();
      },
      () => now,
    );
    await expect(
      policy.find(guildId, {
        expectedAction: 'MEMBER_BAN_ADD',
        targetUserId,
        occurredAt: at,
      }),
    ).resolves.toEqual(audit);
    expect(sleeps).toEqual([500, 1000]);
    expect(reader.list).toHaveBeenCalledWith(guildId, {
      limit: 25,
      after: new Date(at.getTime() - 5000),
      before: new Date(at.getTime() + 5000),
    });
  });

  it('rejects ambiguous, wrong, and executor-less candidates', () => {
    expect(
      uniqueExternalAuditMatch([audit, { ...audit, id: '12345678901234571' }], {
        expectedAction: 'MEMBER_BAN_ADD',
        targetUserId,
        occurredAt: at,
      }),
    ).toBeNull();
    expect(
      uniqueExternalAuditMatch([{ ...audit, executorUserId: null }], {
        expectedAction: 'MEMBER_BAN_ADD',
        targetUserId,
        occurredAt: at,
      }),
    ).toBeNull();
    expect(
      uniqueExternalAuditMatch([{ ...audit, action: 'MEMBER_KICK' }], {
        expectedAction: 'MEMBER_BAN_ADD',
        targetUserId,
        occurredAt: at,
      }),
    ).toBeNull();
    expect(
      uniqueExternalAuditMatch(
        [{ ...audit, targetUserId: '12345678901234571' }],
        {
          expectedAction: 'MEMBER_BAN_ADD',
          targetUserId,
          occurredAt: at,
        },
      ),
    ).toBeNull();
    expect(
      uniqueExternalAuditMatch(
        [{ ...audit, createdAt: new Date(at.getTime() + 5001) }],
        { expectedAction: 'MEMBER_BAN_ADD', targetUserId, occurredAt: at },
      ),
    ).toBeNull();
  });

  it('maps external event kinds and requires the muted role transition', () => {
    expect(externalActionForEvent({ kind: 'MEMBER_REMOVE' })).toBe('KICK');
    expect(externalActionForEvent({ kind: 'BAN_ADD' })).toBe('BAN');
    expect(externalActionForEvent({ kind: 'BAN_REMOVE' })).toBe('UNBAN');
    expect(
      externalActionForEvent({
        kind: 'MUTED_ROLE_UPDATE',
        mutedRoleChange: 'ADD',
      }),
    ).toBe('MUTE');
    expect(
      uniqueExternalAuditMatch(
        [
          {
            ...audit,
            action: 'MEMBER_ROLE_UPDATE',
            roleId: '12345678901234571',
            roleChange: 'ADD',
          },
        ],
        {
          expectedAction: 'MEMBER_ROLE_UPDATE',
          targetUserId,
          occurredAt: at,
          mutedRoleId: '12345678901234572',
          mutedRoleChange: 'ADD',
        },
      ),
    ).toBeNull();
  });

  it('checks correlation before audit and snapshots before member deletion', async () => {
    const correlation = new CorrelationCache();
    const caseId = '123e4567-e89b-12d3-a456-426614174000';
    correlation.put('moderation', `${guildId}:${targetUserId}:KICK`, {
      caseId,
    });
    const auditReader = { list: vi.fn() };
    const snapshots = {
      saveMember: vi.fn().mockResolvedValue({ ok: true, value: {} }),
      deleteMember: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    };
    const cases = { createExternalCaseResult: vi.fn() };
    const service = new ExternalEventService({
      correlation,
      audit: new ExternalAuditPolicy(auditReader),
      snapshots,
      identity: { resolve: vi.fn() },
      cases,
    });
    const result = await service.process({
      guildId,
      targetUserId,
      kind: 'MEMBER_REMOVE',
      occurredAt: at,
      snapshot: {
        guildId,
        userId: targetUserId,
        username: 'user',
        nickname: 'user',
      },
    });
    expect(result.correlated).toBe(true);
    expect(result.snapshotSaved).toBe(true);
    expect(auditReader.list).not.toHaveBeenCalled();
    expect(cases.createExternalCaseResult).not.toHaveBeenCalled();
    expect(snapshots.saveMember).toHaveBeenCalledOnce();
    expect(snapshots.deleteMember).toHaveBeenCalledWith(guildId, targetUserId);
  });

  it('inspects BAN correlation on MEMBER_REMOVE, then BAN_ADD consumes it', async () => {
    const correlation = new CorrelationCache();
    correlation.put('moderation', `${guildId}:${targetUserId}:BAN`, {
      caseId: '123e4567-e89b-12d3-a456-426614174000',
    });
    const audit = { list: vi.fn() };
    const cases = { createExternalCaseResult: vi.fn() };
    const snapshots = {
      saveMember: vi.fn().mockResolvedValue({ ok: true, value: {} }),
      deleteMember: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    };
    const service = new ExternalEventService({
      correlation,
      audit: new ExternalAuditPolicy(audit),
      snapshots,
      identity: { resolve: vi.fn() },
      cases,
    });
    const result = await service.process({
      guildId,
      targetUserId,
      kind: 'MEMBER_REMOVE',
      occurredAt: at,
      snapshot: { guildId, userId: targetUserId, username: 'user' },
    });
    expect(result).toMatchObject({ action: null, correlated: true });
    const banResult = await service.process({
      guildId,
      targetUserId,
      kind: 'BAN_ADD',
      occurredAt: at,
    });
    expect(banResult.correlated).toBe(true);
    expect(audit.list).not.toHaveBeenCalled();
    expect(cases.createExternalCaseResult).not.toHaveBeenCalled();
  });

  it('preserves BAN correlation across deferred MEMBER_REMOVE snapshot saving', async () => {
    const correlation = new CorrelationCache();
    correlation.put('moderation', `${guildId}:${targetUserId}:BAN`, {
      caseId: '123e4567-e89b-12d3-a456-426614174000',
    });
    let releaseSave!: () => void;
    const saveMember = vi.fn(
      () =>
        new Promise<{ ok: true; value: never }>((resolve) => {
          releaseSave = () => {
            resolve({ ok: true, value: undefined as never });
          };
        }),
    );
    const snapshots = {
      saveMember,
      deleteMember: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    };
    const cases = { createExternalCaseResult: vi.fn() };
    const service = new ExternalEventService({
      correlation,
      audit: new ExternalAuditPolicy({ list: vi.fn() }),
      snapshots,
      identity: { resolve: vi.fn() },
      cases,
    });
    const memberRemoval = service.process({
      guildId,
      targetUserId,
      kind: 'MEMBER_REMOVE',
      occurredAt: at,
      snapshot: { guildId, userId: targetUserId, username: 'user' },
    });
    await Promise.resolve();
    expect(saveMember).toHaveBeenCalledOnce();
    const ban = await service.process({
      guildId,
      targetUserId,
      kind: 'BAN_ADD',
      occurredAt: at,
    });
    expect(ban).toMatchObject({ action: 'BAN', correlated: true });
    releaseSave();
    await expect(memberRemoval).resolves.toMatchObject({
      action: null,
      correlated: true,
      deliveryEligible: false,
    });
    expect(cases.createExternalCaseResult).not.toHaveBeenCalled();
  });

  it('consumes KICK correlation before deferred snapshot saving', async () => {
    const correlation = new CorrelationCache();
    correlation.put('moderation', `${guildId}:${targetUserId}:KICK`, {
      caseId: '123e4567-e89b-12d3-a456-426614174000',
    });
    let releaseSave!: () => void;
    const saveMember = vi.fn(
      () =>
        new Promise<{ ok: true; value: never }>((resolve) => {
          releaseSave = () => {
            resolve({ ok: true, value: undefined as never });
          };
        }),
    );
    const service = new ExternalEventService({
      correlation,
      audit: new ExternalAuditPolicy({ list: vi.fn() }),
      snapshots: {
        saveMember,
        deleteMember: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      },
      identity: { resolve: vi.fn() },
      cases: { createExternalCaseResult: vi.fn() },
    });
    const removal = service.process({
      guildId,
      targetUserId,
      kind: 'MEMBER_REMOVE',
      occurredAt: at,
      snapshot: { guildId, userId: targetUserId, username: 'user' },
    });
    await Promise.resolve();
    expect(saveMember).toHaveBeenCalledOnce();
    expect(
      correlation.peek('moderation', `${guildId}:${targetUserId}:KICK`),
    ).toBeUndefined();
    releaseSave();
    await expect(removal).resolves.toMatchObject({
      action: 'KICK',
      correlated: true,
    });
  });

  it('requires a configured muted role and transition, and validates snapshots', async () => {
    const base = {
      guildId,
      targetUserId,
      kind: 'MUTED_ROLE_UPDATE' as const,
      occurredAt: at,
    };
    expect(() => ExternalEventSchema.parse(base)).toThrow();
    await expect(
      new ExternalEventService({} as never).process({
        guildId,
        targetUserId,
        kind: 'BAN_ADD',
        occurredAt: at,
        snapshot: {
          guildId: '12345678901234571',
          userId: targetUserId,
          username: 'user',
        },
      }),
    ).rejects.toThrow();
  });

  it('retains the server log and deletes the snapshot when audit is absent', async () => {
    const lifecycle: string[] = [];
    const snapshots = {
      saveMember: vi.fn().mockImplementation(() => {
        lifecycle.push('save');
        return { ok: true, value: {} };
      }),
      deleteMember: vi.fn().mockImplementation(() => {
        lifecycle.push('delete');
        return { ok: true, value: undefined };
      }),
    };
    const serverLog = vi.fn().mockImplementation(() => {
      lifecycle.push('server-log');
    });
    const auditReader = vi.fn().mockImplementation(() => {
      lifecycle.push('audit');
      return Promise.resolve([]);
    });
    const cases = { createExternalCaseResult: vi.fn() };
    const service = new ExternalEventService({
      correlation: new CorrelationCache(),
      audit: new ExternalAuditPolicy(
        { list: auditReader },
        () => Promise.resolve(),
        () => 0,
      ),
      identity: { resolve: vi.fn() },
      snapshots,
      serverLog,
      cases,
    });
    const result = await service.process({
      guildId,
      targetUserId,
      kind: 'MEMBER_REMOVE',
      occurredAt: at,
      snapshot: { guildId, userId: targetUserId, username: 'user' },
    });
    expect(result).toMatchObject({
      case: null,
      created: false,
      deliveryEligible: false,
      serverLogged: true,
      snapshotDeleted: true,
    });
    expect(serverLog).toHaveBeenCalledOnce();
    expect(cases.createExternalCaseResult).not.toHaveBeenCalled();
    expect(lifecycle.indexOf('save')).toBeLessThan(lifecycle.indexOf('audit'));
    expect(lifecycle.indexOf('save')).toBeLessThan(
      lifecycle.indexOf('server-log'),
    );
    expect(lifecycle.indexOf('server-log')).toBeLessThan(
      lifecycle.indexOf('audit'),
    );
    expect(lifecycle.indexOf('server-log')).toBeLessThan(
      lifecycle.indexOf('delete'),
    );
    expect(serverLog.mock.invocationCallOrder[0]).toBeLessThan(
      snapshots.deleteMember.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it('does not assign a moderator or delivery for an ambiguous audit match', async () => {
    const cases = { createExternalCaseResult: vi.fn() };
    const serverLog = vi.fn().mockResolvedValue(undefined);
    const service = new ExternalEventService({
      correlation: new CorrelationCache(),
      audit: new ExternalAuditPolicy({
        list: vi
          .fn()
          .mockResolvedValue([audit, { ...audit, id: '12345678901234571' }]),
      }),
      identity: { resolve: vi.fn() },
      serverLog,
      cases,
    });
    const result = await service.process({
      guildId,
      targetUserId,
      kind: 'BAN_ADD',
      occurredAt: at,
    });
    expect(result).toMatchObject({
      case: null,
      created: false,
      deliveryEligible: false,
    });
    expect(cases.createExternalCaseResult).not.toHaveBeenCalled();
    expect(serverLog).toHaveBeenCalledOnce();
  });

  it('cancels UNBAN reservations for every observed unban transition', async () => {
    const cancelUnban = vi.fn().mockResolvedValue(undefined);
    const service = new ExternalEventService({
      correlation: new CorrelationCache(),
      audit: new ExternalAuditPolicy(
        { list: vi.fn().mockResolvedValue([]) },
        () => Promise.resolve(),
        () => 0,
      ),
      identity: { resolve: vi.fn() },
      cases: { createExternalCaseResult: vi.fn() },
      cancelUnban,
    });
    const result = await service.process({
      guildId,
      targetUserId,
      kind: 'BAN_REMOVE',
      occurredAt: at,
    });
    expect(result.case).toBeNull();
    expect(cancelUnban).toHaveBeenCalledWith(guildId, targetUserId);
  });

  it.each([
    ['MUTE' as const, 'ADD' as const],
    ['UNMUTE' as const, 'REMOVE' as const],
  ])(
    'consumes internal %s role correlation without creating an external case',
    async (action, change) => {
      const correlation = new CorrelationCache();
      correlation.put('moderation', `${guildId}:${targetUserId}:${action}`, {
        caseId: '123e4567-e89b-12d3-a456-426614174000',
      });
      const cases = { createExternalCaseResult: vi.fn() };
      const service = new ExternalEventService({
        correlation,
        audit: new ExternalAuditPolicy({ list: vi.fn() }),
        identity: { resolve: vi.fn() },
        cases,
      });
      const result = await service.process({
        guildId,
        targetUserId,
        kind: 'MUTED_ROLE_UPDATE',
        mutedRoleId: '12345678901234571',
        mutedRoleChange: change,
        occurredAt: at,
      });
      expect(result).toMatchObject({ action, correlated: true, case: null });
      expect(cases.createExternalCaseResult).not.toHaveBeenCalled();
    },
  );

  it('keeps leave logging and cleanup when audit handling fails', async () => {
    const order: string[] = [];
    const snapshots = {
      saveMember: vi.fn().mockImplementation(() => {
        order.push('save');
        return { ok: true, value: {} };
      }),
      deleteMember: vi.fn().mockImplementation(() => {
        order.push('delete');
        return { ok: true, value: undefined };
      }),
    };
    const serverLog = vi.fn().mockImplementation(() => {
      order.push('server-log');
    });
    const service = new ExternalEventService({
      correlation: new CorrelationCache(),
      audit: new ExternalAuditPolicy(
        {
          list: vi.fn().mockImplementation(() => {
            order.push('audit');
            return Promise.reject(new Error('temporary audit failure'));
          }),
        },
        () => Promise.resolve(),
        () => 0,
      ),
      identity: { resolve: vi.fn() },
      snapshots,
      serverLog,
      cases: { createExternalCaseResult: vi.fn() },
    });
    await expect(
      service.process({
        guildId,
        targetUserId,
        kind: 'MEMBER_REMOVE',
        occurredAt: at,
        snapshot: { guildId, userId: targetUserId, username: 'user' },
      }),
    ).rejects.toThrow('temporary audit failure');
    expect(order).toEqual(['save', 'server-log', 'audit', 'delete']);
    expect(serverLog).toHaveBeenCalledOnce();
  });

  it('returns a persisted case despite post-case failures for one safe delivery attempt', async () => {
    const operationalErrors: unknown[] = [];
    const createdCase = { id: 'case-id' };
    const service = new ExternalEventService({
      correlation: new CorrelationCache(),
      audit: new ExternalAuditPolicy({
        list: vi.fn().mockResolvedValue([audit]),
      }),
      identity: {
        resolve: vi
          .fn()
          .mockResolvedValue({ userId: targetUserId, displayName: 'User' }),
      },
      cases: {
        createExternalCaseResult: vi.fn().mockResolvedValue({
          ok: true,
          value: { case: createdCase, created: true },
        }),
      },
      serverLog: vi.fn().mockRejectedValue(new Error('server log failed')),
      onOperationalError: (error) => operationalErrors.push(error),
    });
    const result = await service.process({
      guildId,
      targetUserId,
      kind: 'BAN_ADD',
      occurredAt: at,
    });
    expect(result).toMatchObject({
      case: createdCase,
      created: true,
      deliveryEligible: true,
    });
    expect(operationalErrors).toHaveLength(1);
  });

  it('creates UNMUTE for a matching muted-role removal', async () => {
    const cases = {
      createExternalCaseResult: vi.fn().mockResolvedValue({
        ok: true,
        value: { case: { id: 'case-id' }, created: true },
      }),
    };
    const identity = {
      resolve: vi
        .fn()
        .mockResolvedValue({ userId: targetUserId, displayName: 'User' }),
    };
    const snapshots = {
      saveMember: vi.fn(),
      deleteMember: vi.fn(),
    };
    const service = new ExternalEventService({
      correlation: new CorrelationCache(),
      audit: new ExternalAuditPolicy({
        list: vi.fn().mockResolvedValue([
          {
            id: auditId,
            action: 'MEMBER_ROLE_UPDATE',
            targetUserId,
            executorUserId,
            createdAt: at,
            roleId: '12345678901234571',
            roleChange: 'REMOVE',
          },
        ]),
      }),
      identity,
      snapshots,
      cases,
    });
    const result = await service.process({
      guildId,
      targetUserId,
      kind: 'MUTED_ROLE_UPDATE',
      mutedRoleId: '12345678901234571',
      mutedRoleChange: 'REMOVE',
      occurredAt: at,
      snapshot: {
        guildId,
        userId: targetUserId,
        username: 'Username',
        globalName: 'Global Name',
        nickname: 'Nickname',
      },
    });
    expect(result).toMatchObject({
      action: 'UNMUTE',
      created: true,
      deliveryEligible: true,
      snapshotDeleted: false,
    });
    expect(cases.createExternalCaseResult).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UNMUTE',
        moderatorUserId: executorUserId,
      }),
    );
    expect(identity.resolve).toHaveBeenCalledWith(guildId, targetUserId, {
      member: { displayName: 'Nickname' },
    });
    expect(snapshots.saveMember).not.toHaveBeenCalled();
    expect(snapshots.deleteMember).not.toHaveBeenCalled();
  });

  it.each([
    ['globalName', { globalName: 'Global', username: 'Username' }, 'Global'],
    ['username', { username: 'Username' }, 'Username'],
  ])(
    'derives identity from snapshot %s fallback',
    async (_label, names, expected) => {
      const identity = {
        resolve: vi
          .fn()
          .mockResolvedValue({ userId: targetUserId, displayName: expected }),
      };
      const service = new ExternalEventService({
        correlation: new CorrelationCache(),
        audit: new ExternalAuditPolicy(
          {
            list: vi.fn().mockResolvedValue([
              {
                id: auditId,
                action: 'MEMBER_ROLE_UPDATE',
                targetUserId,
                executorUserId,
                createdAt: at,
                roleId: '12345678901234571',
                roleChange: 'ADD',
              },
            ]),
          },
          () => Promise.resolve(),
          () => 0,
        ),
        identity,
        cases: {
          createExternalCaseResult: vi.fn().mockResolvedValue({
            ok: true,
            value: { case: { id: 'case-id' }, created: true },
          }),
        },
      });
      await service.process({
        guildId,
        targetUserId,
        kind: 'MUTED_ROLE_UPDATE',
        mutedRoleId: '12345678901234571',
        mutedRoleChange: 'ADD',
        occurredAt: at,
        snapshot: { guildId, userId: targetUserId, ...names },
      });
      expect(identity.resolve).toHaveBeenCalledWith(guildId, targetUserId, {
        member: { displayName: expected },
      });
    },
  );

  it.each([
    {
      expectedAction: 'KICK' as const,
      auditAction: 'MEMBER_KICK' as const,
      event: {
        guildId,
        targetUserId,
        kind: 'MEMBER_REMOVE' as const,
        occurredAt: at,
        snapshot: { guildId, userId: targetUserId, username: 'User' },
      },
    },
    {
      expectedAction: 'UNBAN' as const,
      auditAction: 'MEMBER_BAN_REMOVE' as const,
      event: {
        guildId,
        targetUserId,
        kind: 'BAN_REMOVE' as const,
        occurredAt: at,
      },
    },
    {
      expectedAction: 'MUTE' as const,
      auditAction: 'MEMBER_ROLE_UPDATE' as const,
      event: {
        guildId,
        targetUserId,
        kind: 'MUTED_ROLE_UPDATE' as const,
        mutedRoleId: '12345678901234571',
        mutedRoleChange: 'ADD' as const,
        occurredAt: at,
      },
    },
  ])('creates a successful external %s case', async (scenario) => {
    const cases = {
      createExternalCaseResult: vi.fn().mockResolvedValue({
        ok: true,
        value: { case: { id: 'case-id' }, created: true },
      }),
    };
    const service = new ExternalEventService({
      correlation: new CorrelationCache(),
      audit: new ExternalAuditPolicy(
        {
          list: vi.fn().mockResolvedValue([
            {
              id: auditId,
              action: scenario.auditAction,
              targetUserId,
              executorUserId,
              createdAt: at,
              ...(scenario.expectedAction === 'MUTE'
                ? {
                    roleId: scenario.event.mutedRoleId,
                    roleChange: 'ADD' as const,
                  }
                : {}),
            },
          ]),
        },
        () => Promise.resolve(),
        () => 0,
      ),
      identity: {
        resolve: vi
          .fn()
          .mockResolvedValue({ userId: targetUserId, displayName: 'User' }),
      },
      snapshots: {
        saveMember: vi.fn().mockResolvedValue({ ok: true, value: {} }),
        deleteMember: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      },
      cases,
    });
    const result = await service.process(scenario.event);
    expect(result).toMatchObject({
      action: scenario.expectedAction,
      created: true,
      deliveryEligible: true,
    });
  });

  it('allows delivery only for a newly created external case', async () => {
    let calls = 0;
    const service = new ExternalEventService({
      correlation: new CorrelationCache(),
      audit: new ExternalAuditPolicy({
        list: vi.fn().mockResolvedValue([audit]),
      }),
      identity: {
        resolve: vi
          .fn()
          .mockResolvedValue({ userId: targetUserId, displayName: 'User' }),
      },
      cases: {
        createExternalCaseResult: vi.fn().mockImplementation(() =>
          Promise.resolve({
            ok: true as const,
            value: {
              case: { id: 'case-id' } as never,
              created: calls++ === 0,
            },
          }),
        ),
      },
    });
    const input = {
      guildId,
      targetUserId,
      kind: 'BAN_ADD' as const,
      occurredAt: at,
    };
    await expect(service.process(input)).resolves.toMatchObject({
      created: true,
      deliveryEligible: true,
    });
    await expect(service.process(input)).resolves.toMatchObject({
      created: false,
      deliveryEligible: false,
    });
  });
});
