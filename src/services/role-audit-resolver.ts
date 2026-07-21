import { z } from 'zod';
import { SnowflakeSchema } from '../repositories/contracts.js';
import {
  EXTERNAL_AUDIT_LIMIT,
  EXTERNAL_AUDIT_OFFSETS_MS,
  EXTERNAL_AUDIT_WINDOW_MS,
  type AuditQuery,
} from './external-event-service.js';

export interface RoleTransition {
  roleId: string;
  direction: 'ADD' | 'REMOVE';
}

/**
 * One logical MEMBER_ROLE_UPDATE audit entry preserving all role transitions
 * rather than flattening them into separate faux-duplicate entries.
 */
export interface RoleAuditEntry {
  id: string;
  targetUserId: string;
  executorUserId: string | null;
  createdAt: Date;
  transitions: readonly RoleTransition[];
}

export const RoleAuditEntrySchema = z.object({
  id: SnowflakeSchema,
  targetUserId: SnowflakeSchema,
  executorUserId: SnowflakeSchema.nullable(),
  createdAt: z.date(),
  transitions: z.array(
    z.object({
      roleId: SnowflakeSchema,
      direction: z.enum(['ADD', 'REMOVE']),
    }),
  ),
});

export type RoleTransitionStatus = 'matched' | 'missing' | 'ambiguous';

export interface RoleTransitionResolution {
  status: RoleTransitionStatus;
  /** Preserved even when status is 'matched' so callers can detect self-Bot. */
  executorUserId: string | null;
  auditEntryId: string | null;
}

export interface RoleAuditReader {
  listRoleUpdates(
    guildId: string,
    query: AuditQuery,
  ): Promise<readonly RoleAuditEntry[]>;
}

export function roleTransitionKey(transition: RoleTransition): string {
  return `${transition.roleId}:${transition.direction}`;
}

/**
 * Shared bounded batch resolver for role transitions.
 *
 * - Offsets 0/500/1500ms; one list fetch per retry for ALL unresolved roles.
 * - Limit 25, ±5s window.
 * - Matches target/action/direction/role/non-null executor.
 * - Uniqueness by audit entry ID: exactly one distinct ID → matched.
 * - One entry may resolve multiple role transitions.
 * - Distinguishes matched / missing / ambiguous per transition.
 * - Preserves executorUserId (including self-Bot) for later classification.
 */
export class RoleBatchResolver {
  public constructor(
    private readonly reader: RoleAuditReader,
    private readonly sleep: (milliseconds: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly now: () => number = Date.now,
  ) {}

  public async resolve(
    guildId: string,
    targetUserId: string,
    occurredAt: Date,
    transitions: readonly RoleTransition[],
  ): Promise<Map<string, RoleTransitionResolution>> {
    SnowflakeSchema.parse(guildId);
    SnowflakeSchema.parse(targetUserId);

    const results = new Map<string, RoleTransitionResolution>();
    for (const transition of transitions) {
      results.set(roleTransitionKey(transition), {
        status: 'missing',
        executorUserId: null,
        auditEntryId: null,
      });
    }

    const windowStart = occurredAt.getTime() - EXTERNAL_AUDIT_WINDOW_MS;
    const windowEnd = occurredAt.getTime() + EXTERNAL_AUDIT_WINDOW_MS;
    const startedAt = this.now();

    for (const offset of EXTERNAL_AUDIT_OFFSETS_MS) {
      // Ambiguous transitions remain unresolved and are retried at later
      // offsets; only a stable unique match stops retries for that transition.
      const unresolved = transitions.filter(
        (t) => results.get(roleTransitionKey(t))?.status !== 'matched',
      );
      if (unresolved.length === 0) break;

      const elapsed = this.now() - startedAt;
      if (offset > elapsed) await this.sleep(offset - elapsed);

      // One shared fetch per retry for all unresolved transitions.
      const entries = (
        await this.reader.listRoleUpdates(guildId, {
          limit: EXTERNAL_AUDIT_LIMIT,
          after: new Date(windowStart),
          before: new Date(windowEnd),
        })
      )
        .map((entry) => RoleAuditEntrySchema.safeParse(entry))
        .flatMap((parsed) => (parsed.success ? [parsed.data] : []));

      for (const transition of unresolved) {
        const key = roleTransitionKey(transition);
        const candidates = entries.filter(
          (entry) =>
            entry.targetUserId === targetUserId &&
            entry.executorUserId !== null &&
            entry.createdAt.getTime() >= windowStart &&
            entry.createdAt.getTime() <= windowEnd &&
            entry.transitions.some(
              (t) =>
                t.roleId === transition.roleId &&
                t.direction === transition.direction,
            ),
        );
        // Uniqueness by audit entry ID.
        const uniqueIds = new Set(candidates.map((c) => c.id));
        if (uniqueIds.size === 1) {
          const matched = candidates[0];
          if (matched !== undefined)
            results.set(key, {
              status: 'matched',
              executorUserId: matched.executorUserId,
              auditEntryId: matched.id,
            });
        } else if (uniqueIds.size > 1) {
          // Transient: will be retried at the next offset.
          results.set(key, {
            status: 'ambiguous',
            executorUserId: null,
            auditEntryId: null,
          });
        } else {
          // No candidates this round; reset to missing for the next retry.
          results.set(key, {
            status: 'missing',
            executorUserId: null,
            auditEntryId: null,
          });
        }
      }
    }

    return results;
  }
}
