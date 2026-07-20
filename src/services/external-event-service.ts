import { z } from 'zod';
import { CorrelationCache } from './correlation-cache.js';
import type { CaseDto } from '../repositories/contracts.js';
import {
  MemberSnapshotInputSchema,
  SnowflakeSchema,
} from '../repositories/contracts.js';
import type { CaseService } from './case-service.js';
import type { SnapshotService } from './snapshot-service.js';
import type { TargetIdentityResolver } from './target-identity.js';

const externalEventBase = z.object({
  guildId: SnowflakeSchema,
  targetUserId: SnowflakeSchema,
  occurredAt: z.date(),
  snapshot: MemberSnapshotInputSchema.optional(),
  memberDisplayName: z.string().max(128).optional(),
});
export const ExternalEventSchema = z
  .discriminatedUnion('kind', [
    externalEventBase.extend({
      kind: z.literal('MEMBER_REMOVE'),
      snapshot: MemberSnapshotInputSchema,
    }),
    externalEventBase.extend({ kind: z.literal('BAN_ADD') }),
    externalEventBase.extend({ kind: z.literal('BAN_REMOVE') }),
    externalEventBase.extend({
      kind: z.literal('MUTED_ROLE_UPDATE'),
      mutedRoleId: SnowflakeSchema,
      mutedRoleChange: z.enum(['ADD', 'REMOVE']),
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.snapshot && value.snapshot.guildId !== value.guildId)
      ctx.addIssue({
        code: 'custom',
        path: ['snapshot', 'guildId'],
        message: 'snapshot guild does not match event guild',
      });
    if (value.snapshot && value.snapshot.userId !== value.targetUserId)
      ctx.addIssue({
        code: 'custom',
        path: ['snapshot', 'userId'],
        message: 'snapshot user does not match event target',
      });
  });
export type ExternalEvent = z.infer<typeof ExternalEventSchema>;

export type ExternalCaseAction = 'KICK' | 'BAN' | 'UNBAN' | 'MUTE' | 'UNMUTE';
export interface ExternalAuditEntry {
  id: string;
  action:
    | 'MEMBER_KICK'
    | 'MEMBER_BAN_ADD'
    | 'MEMBER_BAN_REMOVE'
    | 'MEMBER_ROLE_UPDATE';
  targetUserId: string;
  executorUserId: string | null;
  createdAt: Date;
  roleId?: string | undefined;
  roleChange?: 'ADD' | 'REMOVE' | undefined;
}
export const ExternalAuditEntrySchema = z.object({
  id: SnowflakeSchema,
  action: z.enum([
    'MEMBER_KICK',
    'MEMBER_BAN_ADD',
    'MEMBER_BAN_REMOVE',
    'MEMBER_ROLE_UPDATE',
  ]),
  targetUserId: SnowflakeSchema,
  executorUserId: SnowflakeSchema.nullable(),
  createdAt: z.date(),
  roleId: SnowflakeSchema.optional(),
  roleChange: z.enum(['ADD', 'REMOVE']).optional(),
});
export interface AuditQuery {
  limit: 25;
  after: Date;
  before: Date;
}
export interface ExternalAuditReader {
  list(
    guildId: string,
    query: AuditQuery,
  ): Promise<readonly ExternalAuditEntry[]>;
}

const offsets = [0, 500, 1500] as const;
export const EXTERNAL_AUDIT_OFFSETS_MS = offsets;
export const EXTERNAL_AUDIT_LIMIT = 25;
export const EXTERNAL_AUDIT_WINDOW_MS = 5_000;

export interface AuditMatchInput {
  expectedAction: ExternalAuditEntry['action'];
  targetUserId: string;
  occurredAt: Date;
  mutedRoleId?: string | undefined;
  mutedRoleChange?: 'ADD' | 'REMOVE' | undefined;
}

/** Returns a match only when the bounded candidate set contains exactly one entry. */
export function uniqueExternalAuditMatch(
  entries: readonly ExternalAuditEntry[],
  input: AuditMatchInput,
): ExternalAuditEntry | null {
  const start = input.occurredAt.getTime() - EXTERNAL_AUDIT_WINDOW_MS;
  const end = input.occurredAt.getTime() + EXTERNAL_AUDIT_WINDOW_MS;
  const matches = entries.filter((entry) => {
    if (
      entry.action !== input.expectedAction ||
      entry.targetUserId !== input.targetUserId ||
      entry.executorUserId === null ||
      entry.createdAt.getTime() < start ||
      entry.createdAt.getTime() > end
    )
      return false;
    if (input.expectedAction !== 'MEMBER_ROLE_UPDATE') return true;
    return (
      entry.roleId === input.mutedRoleId &&
      entry.roleChange === input.mutedRoleChange
    );
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export function externalActionForEvent(event: {
  kind: ExternalEvent['kind'];
  mutedRoleChange?: 'ADD' | 'REMOVE';
}): ExternalCaseAction | null {
  if (event.kind === 'MEMBER_REMOVE') return 'KICK';
  if (event.kind === 'BAN_ADD') return 'BAN';
  if (event.kind === 'BAN_REMOVE') return 'UNBAN';
  if (event.mutedRoleChange === 'ADD') return 'MUTE';
  if (event.mutedRoleChange === 'REMOVE') return 'UNMUTE';
  return null;
}

function auditActionForEvent(
  event: ExternalEvent,
): ExternalAuditEntry['action'] | null {
  if (event.kind === 'MEMBER_REMOVE') return 'MEMBER_KICK';
  if (event.kind === 'BAN_ADD') return 'MEMBER_BAN_ADD';
  if (event.kind === 'BAN_REMOVE') return 'MEMBER_BAN_REMOVE';
  return 'MEMBER_ROLE_UPDATE';
}

export class ExternalAuditPolicy {
  public constructor(
    private readonly reader: ExternalAuditReader,
    private readonly sleep: (milliseconds: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly now: () => number = Date.now,
  ) {}

  public async find(
    guildId: string,
    input: AuditMatchInput,
  ): Promise<ExternalAuditEntry | null> {
    SnowflakeSchema.parse(guildId);
    SnowflakeSchema.parse(input.targetUserId);
    const startedAt = this.now();
    for (const offset of offsets) {
      const elapsed = this.now() - startedAt;
      if (offset > elapsed) await this.sleep(offset - elapsed);
      const entries = (
        await this.reader.list(guildId, {
          limit: 25,
          after: new Date(input.occurredAt.getTime() - 5_000),
          before: new Date(input.occurredAt.getTime() + 5_000),
        })
      )
        .map((entry) => ExternalAuditEntrySchema.safeParse(entry))
        .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
      const match = uniqueExternalAuditMatch(entries, input);
      if (match) return match;
    }
    return null;
  }
}

export interface ExternalEventResult {
  action: ExternalCaseAction | null;
  auditEntryId: string | null;
  case: CaseDto | null;
  created: boolean;
  deliveryEligible: boolean;
  correlated: boolean;
  snapshotSaved: boolean;
  snapshotDeleted: boolean;
  serverLogged: boolean;
}

export class ExternalEventService {
  public constructor(
    private readonly deps: {
      cases: Pick<CaseService, 'createExternalCaseResult'>;
      audit: ExternalAuditPolicy;
      correlation: Pick<CorrelationCache, 'consume' | 'peek'>;
      identity: Pick<TargetIdentityResolver, 'resolve'>;
      snapshots?: Pick<SnapshotService, 'saveMember' | 'deleteMember'>;
      cancelUnban?: (guildId: string, userId: string) => Promise<void>;
      onOperationalError?: (error: unknown) => void;
      serverLog?: (
        event: ExternalEvent,
        result: ExternalEventResult,
      ) => Promise<void>;
    },
  ) {}

  public async process(input: ExternalEvent): Promise<ExternalEventResult> {
    const event = ExternalEventSchema.parse(input);
    const action = externalActionForEvent(event);
    const base = {
      action,
      auditEntryId: null,
      case: null,
      created: false,
      deliveryEligible: false,
      correlated: false,
      snapshotSaved: false,
      snapshotDeleted: false,
      serverLogged: false,
    } satisfies ExternalEventResult;

    // Capture this before snapshot persistence can yield. A concurrent BAN_ADD
    // may consume the same entry while this removal is being saved; the
    // removal must still not be reclassified as a KICK in that case.
    const banCorrelationObserved =
      event.kind === 'MEMBER_REMOVE' &&
      this.deps.correlation.peek(
        'moderation',
        `${event.guildId}:${event.targetUserId}:BAN`,
      ) !== undefined;
    const kickCorrelationObserved =
      event.kind === 'MEMBER_REMOVE' &&
      !banCorrelationObserved &&
      this.deps.correlation.consume(
        'moderation',
        `${event.guildId}:${event.targetUserId}:KICK`,
      ) !== undefined;

    let failure: unknown;
    const throwFailure = (): never => {
      if (failure instanceof Error) throw failure;
      throw new Error('External event processing failed');
    };
    const rememberFailure = (error: unknown): void => {
      if (failure === undefined) failure = error;
    };
    let serverLogged = false;
    let serverLogAttempted = false;
    const logServer = async (
      result: ExternalEventResult,
      force = false,
    ): Promise<void> => {
      if (!this.deps.serverLog || (serverLogAttempted && !force)) return;
      result.serverLogged = serverLogged;
      serverLogAttempted = true;
      try {
        await this.deps.serverLog(event, result);
        serverLogged = true;
      } catch (error) {
        rememberFailure(error);
      }
    };

    // Snapshot-before-delete is deliberately performed before correlation or
    // audit lookup: the member may be unavailable after the gateway event.
    let snapshotSaved = false;
    if (event.kind === 'MEMBER_REMOVE') {
      try {
        if (!this.deps.snapshots)
          throw new Error('Member removal requires snapshot persistence');
        const saved = await this.deps.snapshots.saveMember(event.snapshot);
        if (!saved.ok) throw new Error('Member snapshot could not be saved');
        snapshotSaved = saved.ok;
      } catch (error) {
        rememberFailure(error);
      }
    }

    let finalized = false;
    let finalizedCasePersisted = false;
    const finish = async (
      result: ExternalEventResult,
      casePersisted = false,
    ): Promise<ExternalEventResult> => {
      if (finalized) {
        if (failure !== undefined && !finalizedCasePersisted) throwFailure();
        return result;
      }
      finalized = true;
      finalizedCasePersisted = casePersisted;
      try {
        // MEMBER_REMOVE has an independent leave record before audit lookup;
        // emit its final classification after lookup as a separate update.
        await logServer(result, event.kind === 'MEMBER_REMOVE');
        result.serverLogged = serverLogged;
      } finally {
        if (event.kind === 'BAN_REMOVE' && this.deps.cancelUnban) {
          try {
            await this.deps.cancelUnban(event.guildId, event.targetUserId);
          } catch (error) {
            rememberFailure(error);
          }
        }
        if (event.kind === 'MEMBER_REMOVE' && this.deps.snapshots) {
          try {
            await this.deps.snapshots.deleteMember(
              event.guildId,
              event.targetUserId,
            );
            result.snapshotDeleted = true;
          } catch (error) {
            rememberFailure(error);
          }
        }
      }
      if (failure !== undefined) {
        if (casePersisted) {
          try {
            this.deps.onOperationalError?.(failure);
          } catch {
            /* error reporting must not affect the single case delivery path */
          }
        } else throwFailure();
      }
      return result;
    };

    // The leave record is independent of audit/case processing and must be
    // emitted before any potentially slow or failing audit lookup.
    if (event.kind === 'MEMBER_REMOVE') await logServer(base);

    try {
      // A MEMBER_REMOVE must inspect, but not consume, BAN correlation. The
      // subsequent BAN_ADD event owns consumption of that correlation entry.
      if (banCorrelationObserved)
        return await finish({
          ...base,
          action: null,
          correlated: true,
          snapshotSaved,
        });
      if (kickCorrelationObserved)
        return await finish({
          ...base,
          action: 'KICK',
          correlated: true,
          snapshotSaved,
        });
      const correlationActions: ExternalCaseAction[] =
        event.kind === 'MEMBER_REMOVE' ? [] : action ? [action] : [];
      for (const correlationAction of correlationActions) {
        if (
          this.deps.correlation.consume(
            'moderation',
            `${event.guildId}:${event.targetUserId}:${correlationAction}`,
          )
        )
          return await finish({
            ...base,
            action,
            correlated: true,
            snapshotSaved,
          });
      }
      const expectedAuditAction = auditActionForEvent(event);
      if (!action || !expectedAuditAction)
        return await finish({ ...base, snapshotSaved });
      const auditInput: AuditMatchInput = {
        expectedAction: expectedAuditAction,
        targetUserId: event.targetUserId,
        occurredAt: event.occurredAt,
        ...(event.kind === 'MUTED_ROLE_UPDATE'
          ? {
              mutedRoleId: event.mutedRoleId,
              mutedRoleChange: event.mutedRoleChange,
            }
          : {}),
      };
      const entry = await this.deps.audit.find(event.guildId, auditInput);
      if (!entry || !entry.executorUserId)
        return await finish({ ...base, snapshotSaved });
      const identity = await this.deps.identity.resolve(
        event.guildId,
        event.targetUserId,
        {
          member: event.memberDisplayName
            ? { displayName: event.memberDisplayName }
            : event.snapshot
              ? {
                  displayName:
                    event.snapshot.nickname ??
                    event.snapshot.globalName ??
                    event.snapshot.username,
                }
              : null,
        },
      );
      const created = await this.deps.cases.createExternalCaseResult({
        guildId: event.guildId,
        action,
        targetUserId: identity.userId,
        targetDisplay: identity.displayName,
        moderatorUserId: entry.executorUserId,
        source: 'EXTERNAL',
        status: 'COMPLETED',
        reason: '外部操作',
        discordAuditLogEntryId: entry.id,
      });
      if (!created.ok) return await finish({ ...base, snapshotSaved });
      return await finish(
        {
          ...base,
          auditEntryId: entry.id,
          case: created.value.case,
          created: created.value.created,
          deliveryEligible: created.value.created,
          snapshotSaved,
        },
        created.value.created,
      );
    } catch (error) {
      rememberFailure(error);
      return await finish({ ...base, snapshotSaved });
    }
  }
}
