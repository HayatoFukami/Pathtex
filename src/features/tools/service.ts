import { err, ok, type Result } from '../../domain/result.js';
import type {
  AnnouncementPort,
  AuditEntry,
  AuditPort,
  ToolsPort,
  LookupResult,
} from './contracts.js';
import { t } from '../../i18n/index.js';

const parallel = async <T>(
  items: readonly T[],
  count: number,
  fn: (x: T) => Promise<void>,
) => {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const x = items[i++];
      if (x) await fn(x);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(count, items.length) }, worker),
  );
};
export class ToolsService {
  public constructor(
    private readonly port: ToolsPort,
    private readonly announcement?: AnnouncementPort,
    private readonly auditPort?: AuditPort,
  ) {}
  private validateAudit(
    scope: 'all' | 'from' | 'action',
    options: { userId?: string; action?: string },
  ): Result<true> {
    if (
      (scope === 'from') !== (options.userId !== undefined) ||
      (scope === 'action') !== (options.action !== undefined) ||
      (scope === 'all' && (options.userId || options.action))
    )
      return err('INVALID_INPUT', t('tools:errors.scopeMismatch'));
    return ok(true);
  }
  public async announce(
    channelId: string,
    roleId: string,
    message: string,
  ): Promise<Result<{ restored: boolean }>> {
    if (message.length < 1 || message.length > 2000)
      return err('INVALID_INPUT', t('tools:errors.messageLength'));
    if (!this.announcement)
      return err(
        'DISCORD_API_ERROR',
        t('tools:errors.announcementAdapterMissing'),
      );
    if (
      this.announcement.sameGuild &&
      !(await this.announcement.sameGuild(channelId, roleId))
    )
      return err('INVALID_INPUT', t('tools:errors.channelRoleGuildMismatch'));
    const role = await this.announcement.getRole(roleId);
    let channelPermissions: ReadonlySet<string> | undefined;
    if (this.announcement.channelPermissions) {
      channelPermissions =
        await this.announcement.channelPermissions(channelId);
      for (const permission of ['ViewChannel', 'SendMessages'])
        if (!channelPermissions.has(permission))
          return err(
            'BOT_PERMISSION_MISSING',
            t('tools:errors.missingChannelPermission', { permission }),
          );
    }
    const original = role.mentionable;
    const changed = !original && !channelPermissions?.has('MentionEveryone');
    if (changed && channelPermissions && !channelPermissions.has('ManageRoles'))
      return err('BOT_PERMISSION_MISSING', t('tools:errors.missingManageRoles'));
    let restored = true;
    try {
      if (changed) {
        const botPosition = this.announcement.botPositionFor
          ? await this.announcement.botPositionFor(channelId)
          : await this.announcement.botPosition();
        if (botPosition <= role.position)
          return err('ROLE_HIERARCHY', t('tools:errors.roleHierarchy'));
        await this.announcement.setMentionable(roleId, true);
      }
      await this.announcement.send(channelId, `<@&${roleId}> ${message}`, {
        roles: [roleId],
        users: [],
        everyone: false,
      });
    } finally {
      if (changed) {
        try {
          await this.announcement.setMentionable(roleId, false);
        } catch {
          restored = false;
        }
      }
    }
    return ok({ restored });
  }
  public async audit(
    guildId: string,
    scope: 'all' | 'from' | 'action',
    options: { userId?: string; action?: string; limit?: number },
  ): Promise<Result<readonly AuditEntry[]>> {
    const valid = this.validateAudit(scope, options);
    if (!valid.ok) return valid;
    if (!this.auditPort)
      return err('DISCORD_API_ERROR', t('tools:errors.auditAdapterMissing'));
    return ok(
      await this.auditPort.list(guildId, {
        ...(options.userId ? { userId: options.userId } : {}),
        ...(options.action ? { action: options.action } : {}),
        limit: Math.min(100, Math.max(1, options.limit ?? 25)),
      }),
    );
  }
  public async auditPage(
    guildId: string,
    scope: 'all' | 'from' | 'action',
    options: {
      userId?: string;
      action?: string;
      limit?: number;
      before?: string;
      after?: string;
      totalLimit?: number;
    },
  ): Promise<
    Result<{
      entries: readonly AuditEntry[];
      nextBefore?: string;
      previousAfter?: string;
      total: number;
      hasMore: boolean;
    }>
  > {
    const valid = this.validateAudit(scope, options);
    if (!valid.ok) return valid;
    if (!this.auditPort?.listPage) {
      const list = await this.audit(guildId, scope, options);
      return list.ok
        ? ok({ entries: list.value, total: list.value.length, hasMore: false })
        : list;
    }
    const page = await this.auditPort.listPage(guildId, {
      ...(options.userId ? { userId: options.userId } : {}),
      ...(options.action ? { action: options.action } : {}),
      limit: Math.min(10, Math.max(1, options.limit ?? 10)),
      totalLimit: Math.min(
        100,
        Math.max(0, options.totalLimit ?? options.limit ?? 25),
      ),
      ...(options.before ? { before: options.before } : {}),
      ...(options.after ? { after: options.after } : {}),
    });
    return ok(page);
  }
  public async dehoist(
    guildId: string,
    symbol = '!',
  ): Promise<{
    success: string[];
    failed: string[];
    outcomes: readonly {
      userId: string;
      ok: boolean;
      code?: string;
      nickname?: string;
    }[];
  }> {
    if (Array.from(symbol).length !== 1) throw new Error('INVALID_INPUT');
    const success: string[] = [];
    const failed: string[] = [];
    const outcomes: {
      userId: string;
      ok: boolean;
      code?: string;
      nickname?: string;
    }[] = [];
    const members = (await this.port.members(guildId)).filter((m) =>
      m.displayName.startsWith(symbol),
    );
    await parallel(members, 3, async (m) => {
      if (m.owner || !m.manageable) {
        failed.push(m.id);
        outcomes.push({
          userId: m.id,
          ok: false,
          code: m.owner ? 'TARGET_IS_OWNER' : 'ROLE_HIERARCHY',
        });
        return;
      }
      const nickname =
        m.displayName.replace(
          new RegExp(
            `^${symbol.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}+`,
            'u',
          ),
          '',
        ) || 'Dehoisted User';
      try {
        await this.port.setNickname(
          guildId,
          m.id,
          Array.from(nickname).slice(0, 32).join(''),
        );
        success.push(m.id);
        outcomes.push({ userId: m.id, ok: true, nickname });
      } catch {
        failed.push(m.id);
        outcomes.push({ userId: m.id, ok: false, code: 'DISCORD_API_ERROR' });
      }
    });
    return { success, failed, outcomes };
  }
  public async invitePrune(
    guildId: string,
    maxUses = 1,
  ): Promise<{
    success: string[];
    failed: string[];
    details: readonly {
      code: string;
      creator?: string;
      uses: number;
      ok: boolean;
    }[];
  }> {
    if (!Number.isInteger(maxUses) || maxUses < 0)
      throw new Error('INVALID_INPUT');
    const success: string[] = [];
    const failed: string[] = [];
    const details: {
      code: string;
      creator?: string;
      uses: number;
      ok: boolean;
    }[] = [];
    const invites = (await this.port.invites(guildId)).filter(
      (x) => !x.vanity && x.uses <= maxUses,
    );
    await parallel(invites, 3, async (invite) => {
      try {
        await this.port.deleteInvite(invite.code);
        success.push(invite.code);
        details.push({
          code: invite.code,
          ...(invite.creator ? { creator: invite.creator } : {}),
          uses: invite.uses,
          ok: true,
        });
      } catch {
        failed.push(invite.code);
        details.push({
          code: invite.code,
          ...(invite.creator ? { creator: invite.creator } : {}),
          uses: invite.uses,
          ok: false,
        });
      }
    });
    return { success, failed, details };
  }
  public async lookup(query: string): Promise<Result<LookupResult>> {
    if (query.length < 2 || query.length > 200)
      return err('INVALID_INPUT', t('tools:errors.queryLength'));
    const normalized = query.trim().replace(/^<|>$/gu, '').replace(/\/$/u, '');
    const match = normalized.match(
      /^(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([\w-]+)$/iu,
    );
    const candidate = match?.[1] ?? normalized;
    if (match) {
      const invite = await this.port.invite(candidate);
      return invite
        ? ok({ kind: 'invite', ...invite })
        : err('USER_NOT_FOUND', t('tools:errors.inviteNotFound'));
    }
    const bareInvite = await this.port.invite(normalized);
    if (bareInvite) return ok({ kind: 'invite', ...bareInvite });
    if (/^\d{17,20}$/u.test(normalized)) {
      const user = await this.port.user(normalized);
      if (user) return ok({ kind: 'user', ...user });
      const preview = await this.port.preview(normalized);
      if (preview) return ok({ kind: 'preview', ...preview });
      return err('USER_NOT_FOUND', t('tools:errors.guildIdOnlyUnavailable'));
    }
    return err('USER_NOT_FOUND', t('tools:errors.userOrInviteNotFound'));
  }
}
