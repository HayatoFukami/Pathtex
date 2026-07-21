import type { LogDeliveryService } from '../features/logging/service.js';
import { roleChangeEmbed } from '../features/logging/role-events.js';
import {
  roleTransitionKey,
  type RoleBatchResolver,
  type RoleTransition,
  type RoleTransitionResolution,
} from './role-audit-resolver.js';
import type { RoleCorrelationCache } from './role-correlation-cache.js';
import type { Logger } from 'pino';

export interface RoleChangeDto {
  roleId: string;
  roleName: string;
  direction: 'ADD' | 'REMOVE';
}

export interface RoleChangeInput {
  guildId: string;
  targetUserId: string;
  targetDisplay: string;
  beforeRoleIds: readonly string[];
  afterRoleIds: readonly string[];
  roleNames: ReadonlyMap<string, string>;
  /** Configured Muted role ID; Phase 3 includes it in generic logging. */
  mutedRoleId: string | null;
  occurredAt: Date;
}

/**
 * Computes added/removed role DTOs from before/after role ID lists.
 * Removed roles come first, then added; each group is sorted by role ID ascending.
 * Phase 3: includes the configured Muted role in generic output.
 */
export function computeRoleChanges(
  beforeRoleIds: readonly string[],
  afterRoleIds: readonly string[],
  roleNames: ReadonlyMap<string, string>,
  mutedRoleId: string | null,
): readonly RoleChangeDto[] {
  void mutedRoleId;
  const beforeSet = new Set(beforeRoleIds);
  const afterSet = new Set(afterRoleIds);
  const removed = beforeRoleIds
    .filter((id) => !afterSet.has(id))
    .sort()
    .map((roleId) => ({
      roleId,
      roleName: roleNames.get(roleId) ?? roleId,
      direction: 'REMOVE' as const,
    }));
  const added = afterRoleIds
    .filter((id) => !beforeSet.has(id))
    .sort()
    .map((roleId) => ({
      roleId,
      roleName: roleNames.get(roleId) ?? roleId,
      direction: 'ADD' as const,
    }));
  return [...removed, ...added];
}

export interface MemberRoleChangePorts {
  delivery: Pick<LogDeliveryService, 'deliver'>;
  timezone(guildId: string): Promise<string>;
  resolver: RoleBatchResolver;
  roleCorrelation: RoleCorrelationCache;
  /** Returns the Bot's own user ID, or null if not yet available. */
  botUserId(): string | null;
  /** Reports non-fatal operational errors (e.g. audit resolver failure). */
  onOperationalError?(error: unknown): void;
  /** Fatal port: 401 (or code===401) errors from display/delivery. */
  fatal?(error: unknown): void;
  /** Resolves a display name for an external executor; null falls back to userId. */
  resolveExecutorDisplay?(
    guildId: string,
    userId: string,
  ): Promise<string | null>;
  logger?: Logger;
}

/**
 * Phase 3 generic role-change server logging.
 *
 * - Emits one generic server log per role transition, including the Muted role.
 * - Removed roles are logged before added roles; each group in role-ID order.
 * - Executor: `Bot` on correlation hit or self-Bot audit executor;
 *   external executor userId when matched; `不明` when missing/ambiguous.
 * - Never calls case or modlog APIs.
 * - One log failure does not block subsequent transition logs.
 * - Returns audit results map for downstream shared use (e.g., Muted external case lane).
 */
export class MemberRoleChangeService {
  public constructor(private readonly ports: MemberRoleChangePorts) {}

  /**
   * Runs generic per-role server logging and returns the shared audit results
   * for downstream use (e.g., Muted external case lane).
   */
  public async process(input: RoleChangeInput): Promise<{
    auditResults: Map<string, RoleTransitionResolution>;
    correlatedKeys: Set<string>;
    executorDisplays: Map<string, string>;
  }> {
    const changes = computeRoleChanges(
      input.beforeRoleIds,
      input.afterRoleIds,
      input.roleNames,
      input.mutedRoleId,
    );
    if (changes.length === 0)
      return {
        auditResults: new Map(),
        correlatedKeys: new Set(),
        executorDisplays: new Map(),
      };

    // Consume role-specific correlations synchronously before any await so
    // that Bot-initiated mutations are always attributed correctly even if
    // later async steps yield control.
    const transitions: RoleTransition[] = changes.map((c) => ({
      roleId: c.roleId,
      direction: c.direction,
    }));
    const correlatedKeys = new Set<string>();
    for (const transition of transitions) {
      if (
        this.ports.roleCorrelation.consume(
          input.guildId,
          input.targetUserId,
          transition.roleId,
          transition.direction,
        )
      )
        correlatedKeys.add(roleTransitionKey(transition));
    }

    const zone = await this.ports.timezone(input.guildId);
    const botUserId = this.ports.botUserId();

    // Resolve unresolved transitions via shared bounded audit batch.
    // On failure, report operationally and deliver all unresolved as 不明.
    const unresolved = transitions.filter(
      (t) => !correlatedKeys.has(roleTransitionKey(t)),
    );
    let auditResults: Map<string, RoleTransitionResolution>;
    if (unresolved.length > 0) {
      try {
        auditResults = await this.ports.resolver.resolve(
          input.guildId,
          input.targetUserId,
          input.occurredAt,
          unresolved,
        );
      } catch (error: unknown) {
        this.ports.onOperationalError?.(error);
        auditResults = new Map<string, RoleTransitionResolution>();
      }
    } else {
      auditResults = new Map<string, RoleTransitionResolution>();
    }

    // Resolve external executor display names in one pass before emitting.
    const executorDisplays = new Map<string, string>();
    if (this.ports.resolveExecutorDisplay) {
      const externalIds = new Set<string>();
      for (const change of changes) {
        const key = roleTransitionKey({
          roleId: change.roleId,
          direction: change.direction,
        });
        if (correlatedKeys.has(key)) continue;
        const resolution = auditResults.get(key);
        if (
          resolution?.status === 'matched' &&
          resolution.executorUserId !== null &&
          resolution.executorUserId !== botUserId
        )
          externalIds.add(resolution.executorUserId);
      }
      await Promise.all(
        [...externalIds].map(async (userId) => {
          try {
            const display = await this.ports.resolveExecutorDisplay?.(
              input.guildId,
              userId,
            );
            executorDisplays.set(
              userId,
              display ? `${display} (${userId})` : userId,
            );
          } catch (error: unknown) {
            const status =
              typeof error === 'object' && error !== null && 'status' in error
                ? (error as { status?: unknown }).status
                : undefined;
            const code =
              typeof error === 'object' && error !== null && 'code' in error
                ? (error as { code?: unknown }).code
                : undefined;
            if (status === 401 || code === 401) {
              this.ports.fatal?.(error);
              throw error;
            }
            executorDisplays.set(userId, userId);
          }
        }),
      );
    }

    // Emit one log per transition; isolate each failure.
    for (const change of changes) {
      const key = roleTransitionKey({
        roleId: change.roleId,
        direction: change.direction,
      });
      const executor = this.resolveExecutor(
        key,
        correlatedKeys,
        auditResults,
        botUserId,
        executorDisplays,
      );
      const embed = roleChangeEmbed({
        targetDisplay: input.targetDisplay,
        targetUserId: input.targetUserId,
        roleName: change.roleName,
        roleId: change.roleId,
        operation: change.direction === 'ADD' ? '追加' : '削除',
        executor,
        date: input.occurredAt,
        zone,
      });
      try {
        await this.ports.delivery.deliver(input.guildId, 'server', embed);
      } catch (error: unknown) {
        const status =
          typeof error === 'object' && error !== null && 'status' in error
            ? (error as { status?: unknown }).status
            : undefined;
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? (error as { code?: unknown }).code
            : undefined;
        if (status === 401 || code === 401) {
          this.ports.fatal?.(error);
          throw error;
        }
        this.ports.logger?.error(
          {
            event: 'role_change.log_failed',
            guildId: input.guildId,
            roleId: change.roleId,
            direction: change.direction,
            errorName: error instanceof Error ? error.name : 'unknown',
          },
          'Role change server log failed',
        );
      }
    }
    return { auditResults, correlatedKeys, executorDisplays };
  }

  private resolveExecutor(
    key: string,
    correlatedKeys: ReadonlySet<string>,
    auditResults: ReadonlyMap<string, RoleTransitionResolution>,
    botUserId: string | null,
    executorDisplays: ReadonlyMap<string, string>,
  ): string {
    if (correlatedKeys.has(key)) return 'Bot';
    const resolution = auditResults.get(key);
    if (
      resolution?.status === 'matched' &&
      resolution.executorUserId !== null
    ) {
      if (resolution.executorUserId === botUserId) return 'Bot';
      return (
        executorDisplays.get(resolution.executorUserId) ??
        resolution.executorUserId
      );
    }
    return '不明';
  }
}
