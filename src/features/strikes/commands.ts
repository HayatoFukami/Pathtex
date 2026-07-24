import { PermissionFlagsBits } from 'discord.js';
import type { CommandDefinition } from '../../commands/contract.js';
import { StrikeService, parseAdditionalTargets } from './strike-service.js';
import { DEFAULT_BULK_TARGET_LIMIT } from '../../domain/parsers.js';
import { t } from '../../i18n/index.js';

const data = (name: string, description: string, options: unknown[] = []) => ({
  name,
  description,
  type: 1,
  options,
  contexts: [0],
  integration_types: [0],
  ...(name === 'punishment'
    ? { default_member_permissions: PermissionFlagsBits.ManageGuild.toString() }
    : {}),
});
const user = {
  name: 'target',
  description: t('strikes:commands.options.target'),
  type: 6,
  required: false,
};
const checkUser = {
  name: 'user',
  description: t('strikes:commands.options.checkUser'),
  type: 6,
  required: true,
};
const additionalTargets = {
  name: 'additional_targets',
  description: t('strikes:commands.options.additionalTargets'),
  type: 3,
  required: false,
  max_length: 400,
};
const amount = {
  name: 'amount',
  description: t('strikes:commands.options.amount'),
  type: 4,
  required: false,
  min_value: 1,
  max_value: 100,
};
const reason = {
  name: 'reason',
  description: t('strikes:commands.options.reason'),
  type: 3,
  required: true,
};
const command = (
  name: string,
  definition: Record<string, unknown>,
  execute: CommandDefinition['execute'],
  authorizationPolicy: 'MODERATOR' | 'MANAGE_GUILD' = 'MODERATOR',
): CommandDefinition => ({
  name,
  data: definition,
  guildOnly: true,
  requiredBotPermissions: [],
  actorNativePermissions: [
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.ManageGuild,
  ],
  authorizationPolicy,
  deferMode: 'EPHEMERAL',
  execute,
});
const guild = (i: { guildId: string | null }) => {
  if (!i.guildId) throw new Error('guild only');
  return i.guildId;
};

export function strikesCommands(
  service: StrikeService,
  maxBulkTargets: number = DEFAULT_BULK_TARGET_LIMIT,
): readonly CommandDefinition[] {
  const result = [
    command(
      'strike',
      data('strike', t('strikes:commands.strike.description'), [
        reason,
        user,
        additionalTargets,
        amount,
      ]),
      async ({ interaction }) => {
        const ids = targetIds(interaction, maxBulkTargets);
        if (!ids.ok) {
          await interaction.editReply(ids.error);
          return;
        }
        const results = await service.strikeMany({
          guildId: guild(interaction),
          userIds: ids.value,
          actorId: interaction.user.id,
          amount: interaction.options.getInteger('amount') ?? 1,
          reason: interaction.options.getString('reason', true),
        });
        if (!Array.isArray(results)) {
          const failure = results as {
            ok: false;
            error: { message?: unknown };
          };
          await interaction.editReply(
            typeof failure.error.message === 'string'
              ? failure.error.message
              : t('strikes:reply.processingFailed'),
          );
          return;
        }
        await interaction.editReply(
          results
            .map((result) =>
              result.ok
                ? t('strikes:reply.delta', {
                    before: result.value.beforeCount,
                    after: result.value.afterCount,
                  })
                : result.error.message,
            )
            .join('\n'),
        );
      },
    ),
    command(
      'pardon',
      data('pardon', t('strikes:commands.pardon.description'), [
        reason,
        user,
        additionalTargets,
        amount,
      ]),
      async ({ interaction }) => {
        const ids = targetIds(interaction, maxBulkTargets);
        if (!ids.ok) {
          await interaction.editReply(ids.error);
          return;
        }
        const results = await service.pardonMany({
          guildId: guild(interaction),
          userIds: ids.value,
          actorId: interaction.user.id,
          amount: interaction.options.getInteger('amount') ?? 1,
          reason: interaction.options.getString('reason', true),
        });
        if (!Array.isArray(results)) {
          const failure = results as {
            ok: false;
            error: { message?: unknown };
          };
          await interaction.editReply(
            typeof failure.error.message === 'string'
              ? failure.error.message
              : t('strikes:reply.processingFailed'),
          );
          return;
        }
        await interaction.editReply(
          results
            .map((result) =>
              result.ok
                ? t('strikes:reply.delta', {
                    before: result.value.beforeCount,
                    after: result.value.afterCount,
                  })
                : result.error.message,
            )
            .join('\n'),
        );
      },
    ),
    command(
      'check',
      data('check', t('strikes:commands.check.description'), [checkUser]),
      async ({ interaction }) => {
        const result = await service.check(
          guild(interaction),
          interaction.options.getUser('user', true).id,
        );
        await interaction.editReply(
          result.ok
            ? [
                t('strikes:reply.count', { count: result.value.count }),
                `Mute: ${result.value.muted ? t('strikes:reply.yes') : t('strikes:reply.no')}${result.value.muteExpiresAt ? t('strikes:reply.expirySuffix', { date: result.value.muteExpiresAt.toISOString() }) : ''}`,
                `BAN: ${result.value.banned === null ? t('strikes:reply.banFetchFailed') : result.value.banned ? t('strikes:reply.yes') : t('strikes:reply.no')}${result.value.banExpiresAt ? t('strikes:reply.expirySuffix', { date: result.value.banExpiresAt.toISOString() }) : ''}`,
                t('strikes:reply.next', {
                  value: result.value.next
                    ? `${String(result.value.next.threshold)} / ${result.value.next.action}`
                    : t('strikes:reply.none'),
                }),
                t('strikes:reply.history', {
                  entries:
                    result.value.history
                      .map(
                        (entry) =>
                          `${entry.delta > 0 ? '+' : ''}${String(entry.delta)}: ${entry.reason} (${entry.createdAt.toISOString()})`,
                      )
                      .join('\n') || t('strikes:reply.none'),
                }),
              ].join('\n')
            : result.error.message,
        );
      },
    ),
  ];
  result.push(
    command(
      'punishment',
      data('punishment', t('strikes:commands.punishment.description'), [
        {
          name: 'set',
          description: t('strikes:commands.punishment.set.description'),
          type: 1,
          options: [
            {
              name: 'threshold',
              description: t('strikes:commands.options.threshold'),
              type: 4,
              required: true,
              min_value: 1,
              max_value: 1000000,
            },
            {
              name: 'action',
              description: 'Action',
              type: 3,
              required: true,
              choices: ['none', 'mute', 'kick', 'softban', 'ban'].map(
                (name) => ({ name, value: name }),
              ),
            },
            {
              name: 'duration',
              description: t('strikes:commands.options.duration'),
              type: 3,
              required: false,
            },
          ],
        },
        {
          name: 'remove',
          description: t('strikes:commands.punishment.remove.description'),
          type: 1,
          options: [
            {
              name: 'threshold',
              description: t('strikes:commands.options.threshold'),
              type: 4,
              required: true,
              min_value: 1,
              max_value: 1000000,
            },
          ],
        },
        {
          name: 'list',
          description: t('strikes:commands.punishment.list.description'),
          type: 1,
        },
      ]),
      async ({ interaction }) => {
        const sub = interaction.options.getSubcommand();
        const guildId = guild(interaction);
        if (sub === 'list') {
          const r = await service.listPunishments(guildId);
          await interaction.editReply(
            r.ok
              ? r.value
                  .map(
                    (p) =>
                      `${String(p.threshold)}: ${p.action}${p.durationSeconds ? ` (${String(p.durationSeconds)}s)` : ''}${t('strikes:reply.punishmentMeta', { createdBy: p.createdBy, updatedAt: p.updatedAt.toISOString() })}`,
                  )
                  .join('\n') || t('strikes:reply.punishmentEmpty')
              : r.error.message,
          );
          return;
        }
        const threshold = interaction.options.getInteger('threshold', true);
        const r =
          sub === 'remove'
            ? await service.removePunishment(guildId, threshold)
            : await service.setPunishment({
                guildId,
                actorId: interaction.user.id,
                threshold,
                action: interaction.options
                  .getString('action', true)
                  .toUpperCase() as
                  'NONE' | 'MUTE' | 'KICK' | 'SOFTBAN' | 'BAN',
                durationSeconds: interaction.options.getString('duration'),
              });
        await interaction.editReply(
          r.ok ? t('strikes:reply.punishmentUpdated') : r.error.message,
        );
      },
      'MANAGE_GUILD',
    ),
  );
  return result;
}

function targetIds(
  interaction: Parameters<CommandDefinition['execute']>[0]['interaction'],
  maxBulkTargets: number = DEFAULT_BULK_TARGET_LIMIT,
): { ok: true; value: string[] } | { ok: false; error: string } {
  const primary = interaction.options.getUser('target')?.id;
  const parsed = parseAdditionalTargets(
    interaction.options.getString('additional_targets'),
    maxBulkTargets,
  );
  if (!parsed.ok) return { ok: false, error: parsed.error.message };
  const value = [...new Set([...(primary ? [primary] : []), ...parsed.value])];
  return value.length > 0 && value.length <= maxBulkTargets
    ? { ok: true, value }
    : {
        ok: false,
        error: t('strikes:reply.targetRange', { max: maxBulkTargets }),
      };
}
