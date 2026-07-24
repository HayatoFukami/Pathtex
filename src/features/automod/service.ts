import { err, ok, type Result } from '../../domain/result.js';
import {
  aggregateViolations,
  topicDisabledRules,
  type AutomodRuleResult,
} from '../../domain/automod.js';
import {
  duplicateKey,
  DuplicateLru,
  antiInvites,
  antiReferral,
  copypastaMatch,
  parseCopypastaResource,
  lineCount,
  mentionCount,
} from './domain.js';
import type {
  AutomodDependencies,
  AutomodMessage,
  AutomodResult,
} from './contracts.js';
import type { MessageView } from '../logging/events.js';
import { isUnauthorized } from '../logging/adapters.js';
import { TargetIdentitySchema } from '../../services/target-identity.js';
import { t } from '../../i18n/index.js';

export class AutomodService {
  public readonly duplicate = new DuplicateLru();
  private readonly editedRules = new Map<string, number>();
  private resourcesLoad: Promise<void> | undefined;
  private resourceCopypastas: readonly import('./domain.js').CopypastaDefinition[] =
    [];
  private resourceReferralDomains: readonly string[] = [];
  private resourceWarningMessages: string[] = [];
  public constructor(private readonly deps: AutomodDependencies) {}
  public async initialize(): Promise<void> {
    await this.loadResources();
  }
  public async inspect(
    message: MessageView,
    previous?: MessageView,
  ): Promise<void> {
    await this.loadResources();
    const topic = await this.deps.discord.getChannelTopic?.(message.channelId);
    let parentId: string | null = message.parentChannelId ?? null;
    if (!parentId && this.deps.discord.getParentChannelId)
      parentId = await this.deps.discord.getParentChannelId(message.channelId);
    let parentTopic: string | null = null;
    if (parentId && this.deps.discord.getChannelTopic)
      parentTopic = await this.deps.discord.getChannelTopic(parentId);
    else if (this.deps.discord.getParentTopic)
      parentTopic = await this.deps.discord.getParentTopic(message.channelId);
    await this.evaluate({
      id: message.messageId,
      guildId: message.guildId,
      channelId: message.channelId,
      authorId: message.authorId,
      content: message.content,
      ...(message.authorIsBot === undefined
        ? {}
        : { authorIsBot: message.authorIsBot }),
      ...(message.webhook === undefined ? {} : { webhook: message.webhook }),
      ...(message.system === undefined ? {} : { system: message.system }),
      isEdit: message.isEdit ?? previous !== undefined,
      topic: topic ?? null,
      parentTopic: parentTopic ?? null,
      attachments: (message.attachments ?? []).map((item) =>
        typeof item === 'string'
          ? item
          : typeof item.filename === 'string'
            ? item.filename
            : JSON.stringify(item),
      ),
      ...(message.mentions === undefined
        ? {}
        : { userMentions: message.mentions }),
      ...(message.roleMentions === undefined
        ? {}
        : { roleMentions: message.roleMentions }),
      ...(message.everyoneMentioned === undefined
        ? {}
        : { everyoneMentioned: message.everyoneMentioned }),
      ...(message.flags === undefined ? {} : { flags: message.flags }),
      ...(parentId === null ? {} : { parentChannelId: parentId }),
      embeds: (message.embeds ?? []).flatMap((embed) => {
        if (typeof embed === 'string')
          return [{ title: embed, description: null }];
        return [
          {
            title: typeof embed.title === 'string' ? embed.title : null,
            description:
              typeof embed.description === 'string' ? embed.description : null,
          },
        ];
      }),
    });
  }
  public async update(
    guildId: string,
    patch: Parameters<AutomodDependencies['settings']['update']>[1],
  ): Promise<unknown> {
    const enablesStrikeRule =
      (patch.antiInviteStrikes !== undefined && patch.antiInviteStrikes > 0) ||
      (patch.antiReferralStrikes !== undefined &&
        patch.antiReferralStrikes > 0) ||
      (patch.antiEveryoneStrikes !== undefined &&
        patch.antiEveryoneStrikes > 0) ||
      (patch.antiCopypastaStrikes !== undefined &&
        patch.antiCopypastaStrikes > 0) ||
      patch.maxUserMentions != null ||
      patch.maxRoleMentions != null ||
      patch.maxLines != null ||
      patch.duplicateEnabled === true;
    if (
      enablesStrikeRule &&
      (await this.deps.punishments.list(guildId)).length === 0
    )
      return err(
        'CONFIGURATION_MISSING',
        t('automod:errors.punishmentRequired'),
      );
    if (
      patch.autodehoistCharacter !== undefined &&
      patch.autodehoistCharacter !== null &&
      Array.from(patch.autodehoistCharacter).length !== 1
    )
      return err('INVALID_INPUT', t('automod:errors.characterLength'));
    const updated = await this.deps.settings.update(guildId, patch);
    const character = patch.autodehoistCharacter;
    return ok({
      updated,
      ...(character && /[\p{L}\p{N}\s]/u.test(character)
        ? {
            warning: t('automod:warnings.dehoistCharacterConflict'),
          }
        : {}),
    });
  }
  public async getOrCreate(guildId: string) {
    return this.deps.settings.getOrCreate(guildId);
  }
  public async ignore(
    kind: 'role' | 'channel',
    guildId: string,
    id: string,
    actor: string,
    remove = false,
  ): Promise<Result<undefined | { automaticIgnoreContinues: true }>> {
    if (!this.deps.ignores)
      return err(
        'CONFIGURATION_MISSING',
        t('automod:errors.ignoreUnavailable'),
      );
    if (kind === 'role') {
      if (remove) {
        const roles = (await this.deps.discord.listRoles?.(guildId)) ?? [];
        const botPosition =
          await this.deps.discord.getBotRolePosition?.(guildId);
        const role = roles.find((item) => item.id === id);
        const automatic = Boolean(
          role &&
          (role.position >= (botPosition ?? Number.MAX_SAFE_INTEGER) ||
            role.permissions.some((permission) =>
              [
                'Administrator',
                'BanMembers',
                'ManageMessages',
                'KickMembers',
                'ManageGuild',
              ].includes(permission),
            )),
        );
        await this.deps.ignores.removeRole(guildId, id);
        if (automatic) return ok({ automaticIgnoreContinues: true });
      } else await this.deps.ignores.setRole(guildId, id, actor);
    } else if (remove) await this.deps.ignores.removeChannel(guildId, id);
    else {
      await this.deps.ignores.setChannel(guildId, id, actor);
      for (const child of (await this.deps.discord.listCategoryChildren?.(
        guildId,
        id,
      )) ?? [])
        await this.deps.ignores.setChannel(guildId, child, actor);
    }
    return ok(undefined);
  }
  public async ignoreList(guildId: string) {
    await this.loadResources();
    const allRoles = (await this.deps.discord.listRoles?.(guildId)) ?? [];
    const botPosition =
      (await this.deps.discord.getBotRolePosition?.(guildId)) ??
      Number.MAX_SAFE_INTEGER;
    const hierarchyRoles = allRoles
      .filter((role) => role.position >= botPosition)
      .map((role) => role.id);
    const strongPermissionRoles = allRoles
      .filter((role) =>
        role.permissions.some((permission) =>
          [
            'Administrator',
            'BanMembers',
            'ManageMessages',
            'KickMembers',
            'ManageGuild',
          ].includes(permission),
        ),
      )
      .map((role) => role.id);
    const automatic = allRoles
      .filter(
        (role) =>
          role.position >= botPosition ||
          role.permissions.some((permission) =>
            [
              'Administrator',
              'BanMembers',
              'ManageMessages',
              'KickMembers',
              'ManageGuild',
            ].includes(permission),
          ),
      )
      .map((role) => role.id);
    return {
      roles: (await this.deps.ignores?.listRoles(guildId)) ?? [],
      channels: (await this.deps.ignores?.listChannels(guildId)) ?? [],
      automaticRoles: automatic,
      hierarchyRoles,
      strongPermissionRoles,
      resourceWarnings: this.resourceWarningMessages,
    };
  }
  public resourceWarnings(): readonly string[] {
    return [...this.resourceWarningMessages];
  }
  public async autoDehoist(
    guildId: string,
    userId: string,
    displayName: string,
  ): Promise<boolean> {
    const character = (await this.deps.settings.getOrCreate(guildId))
      .autodehoistCharacter;
    if (!character || !displayName || !this.deps.discord.dehoist) return false;
    const first = Array.from(displayName)[0] ?? '';
    if (!first || /[\p{L}\p{N}]/u.test(first) || first === character)
      return false;
    try {
      await this.deps.discord.dehoist(guildId, userId, character);
    } catch (error) {
      if (isUnauthorized(error)) throw error;
      this.deps.warning?.(
        guildId,
        error instanceof Error
          ? error.message
          : t('automod:warnings.autoDehoistFailed'),
      );
      return false;
    }
    this.deps.metrics?.increment('automod.dehoist');
    return true;
  }
  public async evaluate(
    message: AutomodMessage,
    now = this.deps.clock?.() ?? Date.now(),
  ): Promise<Result<AutomodResult>> {
    await this.loadResources();
    if (
      !message.guildId ||
      (!message.content &&
        !(message.attachments?.length || message.embeds?.length)) ||
      message.authorIsBot ||
      message.webhook ||
      message.system
    )
      return ok({
        deleted: false,
        strikes: 0,
        reasons: [],
        rules: [],
        warnings: [],
      });
    const settings = await this.deps.settings.getOrCreate(message.guildId);
    const member = await this.deps.discord.getMember(
      message.guildId,
      message.authorId,
    );
    if (!member || member.isOwner)
      return ok({
        deleted: false,
        strikes: 0,
        reasons: [],
        rules: [],
        warnings: [],
      });
    const effectivePermissions = this.deps.discord.getEffectiveMemberPermissions
      ? await this.deps.discord.getEffectiveMemberPermissions(
          message.guildId,
          message.channelId,
          message.authorId,
        )
      : [];
    const ignored = await this.isIgnored(message, member, effectivePermissions);
    if (ignored)
      return ok({
        deleted: false,
        strikes: 0,
        reasons: [],
        rules: [],
        warnings: [],
      });
    const topic = topicDisabledRules(
      message.topic ?? message.parentTopic ?? '',
    );
    const disabled = topic.ok ? topic.value : new Set<string>();
    const results: AutomodRuleResult[] = [];
    const add = (rule: AutomodRuleResult) => results.push(rule);
    if (settings.antiInviteStrikes && !disabled.has('ANTI_INVITE')) {
      const hits = antiInvites(message.content);
      const hit = hits[0] ?? null;
      let foreign = false;
      if (hits.length && this.deps.discord.getInvite)
        for (const inviteHit of hits) {
          const invite = await this.deps.discord.getInvite(inviteHit.code);
          if (!invite || invite.guildId !== message.guildId) {
            foreign = true;
            break;
          }
        }
      else foreign = !!hit;
      if (foreign)
        add({
          rule: 'ANTI_INVITE',
          matched: true,
          deleteMessage: true,
          strikes: settings.antiInviteStrikes,
          reason: t('automod:reasons.antiInvite'),
          evidence: hits,
        });
    }
    if (
      settings.antiReferralStrikes &&
      antiReferral(
        message.content,
        this.deps.referralDomains ?? this.resourceReferralDomains,
      )
    )
      add({
        rule: 'ANTI_REFERRAL',
        matched: true,
        deleteMessage: true,
        strikes: settings.antiReferralStrikes,
        reason: t('automod:reasons.antiReferral'),
      });
    const everyoneRole = await this.hasEveryoneRoleMention(message);
    if (
      settings.antiEveryoneStrikes &&
      !disabled.has('ANTI_EVERYONE') &&
      !effectivePermissions.includes('MentionEveryone') &&
      (message.everyoneMentioned || everyoneRole)
    )
      add({
        rule: 'ANTI_EVERYONE',
        matched: true,
        deleteMessage: true,
        strikes: settings.antiEveryoneStrikes,
        reason: t('automod:reasons.antiEveryone'),
      });
    if (
      settings.antiCopypastaStrikes &&
      !disabled.has('ANTI_COPYPASTA') &&
      copypastaMatch(
        message.content,
        this.deps.copypastas ?? this.resourceCopypastas,
      )
    )
      add({
        rule: 'ANTI_COPYPASTA',
        matched: true,
        deleteMessage: true,
        strikes: settings.antiCopypastaStrikes,
        reason: t('automod:reasons.antiCopypasta'),
      });
    const users = mentionCount(
      (message.userMentions ?? []).map((x) => x.id),
      message.authorId,
      new Set(
        (message.userMentions ?? []).filter((x) => x.bot).map((x) => x.id),
      ),
    );
    if (settings.maxUserMentions && users > settings.maxUserMentions)
      add({
        rule: 'MAX_USER_MENTIONS',
        matched: true,
        deleteMessage: true,
        strikes: users - settings.maxUserMentions,
        reason: t('automod:reasons.maxUserMentions'),
        evidence: { count: users },
      });
    const roles = new Set(message.roleMentions ?? []).size;
    if (settings.maxRoleMentions && roles > settings.maxRoleMentions)
      add({
        rule: 'MAX_ROLE_MENTIONS',
        matched: true,
        deleteMessage: true,
        strikes: roles - settings.maxRoleMentions,
        reason: t('automod:reasons.maxRoleMentions'),
      });
    const lines = lineCount(message.content);
    if (
      settings.maxLines &&
      !disabled.has('MAX_LINES') &&
      lines > settings.maxLines
    )
      add({
        rule: 'MAX_LINES',
        matched: true,
        deleteMessage: true,
        strikes: Math.ceil((lines - settings.maxLines) / settings.maxLines),
        reason: t('automod:reasons.maxLines'),
        evidence: { count: lines },
      });
    if (
      settings.duplicateEnabled &&
      settings.duplicateStrikeThreshold &&
      !disabled.has('ANTI_DUPLICATE')
    ) {
      const content = duplicateKey(message);
      const existing = this.duplicate.get(
        `${message.guildId}:${message.authorId}`,
      );
      const sameEditedMessage =
        message.isEdit &&
        existing?.messages.some((item) => item.messageId === message.id);
      if (content && !sameEditedMessage) {
        const duplicate = this.duplicate.observe(
          `${message.guildId}:${message.authorId}`,
          content,
          message.channelId,
          message.id,
          now,
        );
        if (
          duplicate.ordinal >= (settings.duplicateDeleteThreshold ?? 2) ||
          duplicate.ordinal >= settings.duplicateStrikeThreshold
        )
          add({
            rule: 'ANTI_DUPLICATE',
            matched: true,
            deleteMessage:
              duplicate.ordinal >= (settings.duplicateDeleteThreshold ?? 2),
            strikes:
              duplicate.ordinal >= settings.duplicateStrikeThreshold
                ? settings.duplicateStrikes
                : 0,
            reason: t('automod:reasons.antiDuplicate'),
            evidence: {
              ordinal: duplicate.ordinal,
              deleteThreshold: settings.duplicateDeleteThreshold ?? 2,
              priorMessageIds: duplicate.messages
                .filter(
                  (item) =>
                    item.messageId !== message.id &&
                    item.channelId === message.channelId,
                )
                .map((item) => item.messageId),
            },
          });
      }
    }
    const ruleOrder = [
      'ANTI_INVITE',
      'ANTI_REFERRAL',
      'ANTI_EVERYONE',
      'ANTI_COPYPASTA',
      'MAX_USER_MENTIONS',
      'MAX_ROLE_MENTIONS',
      'MAX_LINES',
      'ANTI_DUPLICATE',
    ];
    results.sort(
      (left, right) =>
        ruleOrder.indexOf(left.rule) - ruleOrder.indexOf(right.rule),
    );
    const aggregate = aggregateViolations(results);
    const warnings: string[] = [...this.resourceWarningMessages];
    if (!aggregate.ok || aggregate.value.rules.length === 0) {
      for (const warning of warnings)
        await this.deps.messageLog?.warning?.(message, warning);
      if (warnings.length)
        this.deps.metrics?.increment(
          'automod.resource_warnings',
          warnings.length,
        );
      return ok({
        deleted: false,
        strikes: 0,
        reasons: [],
        rules: [],
        warnings,
      });
    }
    let deleted = false;
    try {
      if (aggregate.value.deleteMessage) {
        const duplicateRule = aggregate.value.rules.find(
          (rule) => rule.rule === 'ANTI_DUPLICATE',
        );
        const prior =
          duplicateRule &&
          duplicateRule.evidence &&
          typeof duplicateRule.evidence === 'object' &&
          'ordinal' in duplicateRule.evidence &&
          (
            duplicateRule.evidence as {
              ordinal: number;
              deleteThreshold?: number;
            }
          ).ordinal ===
            (duplicateRule.evidence as { deleteThreshold?: number })
              .deleteThreshold
            ? ((
                duplicateRule.evidence as {
                  priorMessageIds?: readonly string[];
                }
              ).priorMessageIds ?? this.duplicateEntry(message))
            : [];
        const ids = [message.id, ...prior];
        for (const id of ids)
          this.deps.correlation?.add(`${message.guildId}:${id}`, {
            reason: aggregate.value.reason,
          });
        if (ids.length > 1 && this.deps.discord.deleteMessages)
          await this.deleteBatchWithRetry(message.channelId, ids);
        else await this.deleteWithRetry(message.channelId, message.id);
        deleted = true;
        await this.deps.messageLog?.deleted(message, aggregate.value.reason);
      }
    } catch (error) {
      if (isUnauthorized(error)) throw error;
      warnings.push(
        error instanceof Error
          ? error.message
          : t('automod:warnings.messageDeleteFailed'),
      );
    }
    const pendingCacheKeys: string[] = [];
    const activeRules = aggregate.value.rules.filter((rule) => {
      const key = `${message.id}:${rule.rule}`;
      if (!message.isEdit) {
        pendingCacheKeys.push(key);
        return true;
      }
      const expires = this.editedRules.get(key) ?? 0;
      if (expires > now) return false;
      pendingCacheKeys.push(key);
      for (const [cachedKey, expiry] of this.editedRules)
        if (expiry <= now) this.editedRules.delete(cachedKey);
      while (this.editedRules.size > 10_000) {
        const oldest = this.editedRules.keys().next().value;
        if (oldest === undefined) break;
        this.editedRules.delete(oldest);
      }
      return true;
    });
    const strikeAmount = Math.min(
      100,
      Math.max(
        0,
        activeRules.reduce((sum, rule) => sum + rule.strikes, 0),
      ),
    );
    if (strikeAmount > 0)
      try {
        const strikeResult = await this.deps.strikes.autoModStrike({
          guildId: message.guildId,
          userId: message.authorId,
          actorId: this.deps.discord.getBotUserId
            ? await this.deps.discord.getBotUserId(message.guildId)
            : message.authorId,
          amount: strikeAmount,
          reason: aggregate.value.reason,
          ...this.authorIdentity(message.authorId, member.displayName),
          evidence: aggregate.value.evidence,
          warnings,
        });
        if (!strikeResult.ok) warnings.push(strikeResult.error.message);
        else if (
          pendingCacheKeys.length &&
          ((strikeResult.value as { delta?: number } | undefined)?.delta ??
            1) !== 0
        )
          for (const key of pendingCacheKeys)
            this.editedRules.set(key, now + 600_000);
      } catch (error) {
        if (isUnauthorized(error)) throw error;
        warnings.push(
          error instanceof Error
            ? error.message
            : t('automod:warnings.strikeFailed'),
        );
      }
    for (const warning of warnings)
      await this.deps.messageLog?.warning?.(message, warning);
    if (strikeAmount > 0)
      await this.deps.messageLog?.strike?.(message, {
        amount: strikeAmount,
        evidence: aggregate.value.evidence,
        warnings,
      });
    this.deps.metrics?.increment('automod.matches', activeRules.length);
    return ok({
      deleted,
      strikes: strikeAmount,
      reasons: activeRules.map((r) => r.reason),
      rules: aggregate.value.rules,
      warnings,
    });
  }
  private async loadResources(): Promise<void> {
    if (!this.resourcesLoad)
      this.resourcesLoad = (async () => {
        if (!this.deps.resourceLoader) return;
        const [copypastas, referrals] = await Promise.all([
          this.deps.resourceLoader.text('resources/copypastas.txt'),
          this.deps.resourceLoader.text('resources/referral_domains.txt'),
        ]);
        if (copypastas)
          this.resourceCopypastas = parseCopypastaResource(copypastas);
        else
          this.resourceWarningMessages.push(
            t('automod:warnings.copypastaResourceLoadFailed'),
          );
        if (referrals)
          this.resourceReferralDomains = referrals
            .split(/\r?\n/u)
            .map((line) => line.trim().toLocaleLowerCase())
            .filter((line) => line && !line.startsWith('#'));
        else
          this.resourceWarningMessages.push(
            t('automod:warnings.referralResourceLoadFailed'),
          );
      })();
    await this.resourcesLoad;
  }
  private async deleteWithRetry(
    channelId: string,
    messageId: string,
  ): Promise<void> {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.deps.discord.deleteMessage(channelId, messageId);
        return;
      } catch (error) {
        if (isUnauthorized(error)) throw error;
        const code = (error as { code?: number; status?: number }).code;
        const status = (error as { status?: number }).status;
        if (code === 10008) return;
        if (status === 403 || (status !== undefined && status < 500))
          throw error;
        last = error;
        if (attempt < 2)
          await new Promise((resolve) =>
            setTimeout(resolve, 2 ** attempt * 100),
          );
      }
    }
    throw last instanceof Error
      ? last
      : new Error(t('automod:warnings.messageDeleteFailed'));
  }
  private async deleteBatchWithRetry(
    channelId: string,
    ids: readonly string[],
  ): Promise<void> {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.deps.discord.deleteMessages?.(channelId, ids);
        return;
      } catch (error) {
        if (isUnauthorized(error)) throw error;
        const code = (error as { code?: number }).code;
        const status = (error as { status?: number }).status;
        if (code === 10008) return;
        if (status !== undefined && status < 500) throw error;
        last = error;
        if (attempt < 2)
          await new Promise((resolve) =>
            setTimeout(resolve, 2 ** attempt * 100),
          );
      }
    }
    throw last instanceof Error
      ? last
      : new Error(t('automod:warnings.batchMessageDeleteFailed'));
  }
  private duplicateEntry(message: AutomodMessage): readonly string[] {
    const key = `${message.guildId}:${message.authorId}`;
    return (
      this.duplicate
        .get(key)
        ?.messages.filter(
          (item) =>
            item.channelId === message.channelId &&
            item.messageId !== message.id,
        )
        .map((item) => item.messageId) ?? []
    );
  }
  private async isIgnored(
    message: AutomodMessage,
    member: {
      roleIds: readonly string[];
      canManageMessages?: boolean;
      highestRolePosition?: number;
      botRolePosition?: number;
      permissions?: readonly string[];
    },
    effectivePermissions: readonly string[],
  ): Promise<boolean> {
    if (
      effectivePermissions.some((permission) =>
        [
          'Administrator',
          'BanMembers',
          'KickMembers',
          'ManageGuild',
          'ManageMessages',
        ].includes(permission),
      ) ||
      (member.highestRolePosition !== undefined &&
        member.botRolePosition !== undefined &&
        member.highestRolePosition >= member.botRolePosition)
    )
      return true;
    const roles = (await this.deps.ignores?.listRoles(message.guildId)) ?? [];
    const channels =
      (await this.deps.ignores?.listChannels(message.guildId)) ?? [];
    const parent =
      message.parentChannelId ??
      (await this.deps.discord.getParentChannelId?.(message.channelId));
    const category = parent
      ? await this.deps.discord.getChannelCategoryId?.(parent)
      : undefined;
    return (
      roles.some((r) => member.roleIds.includes(r.roleId)) ||
      channels.some(
        (c) =>
          c.channelId === message.channelId ||
          c.channelId === parent ||
          c.channelId === category,
      )
    );
  }

  private authorIdentity(userId: string, displayName?: string) {
    const parsed = TargetIdentitySchema.safeParse({ userId, displayName });
    return parsed.success ? { identity: parsed.data } : {};
  }

  private async hasEveryoneRoleMention(
    message: AutomodMessage,
  ): Promise<boolean> {
    if (message.everyoneMentioned) return true;
    for (const id of message.roleMentions ?? []) {
      const role = await this.deps.discord.getRole?.(message.guildId, id);
      if (role?.mentionable && /^(everyone|here)$/iu.test(role.name))
        return true;
    }
    return false;
  }
}
