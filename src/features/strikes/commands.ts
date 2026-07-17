import { PermissionFlagsBits } from 'discord.js';
import type { CommandDefinition } from '../../commands/contract.js';
import { StrikeService, parseAdditionalTargets } from './strike-service.js';

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
  description: '対象ユーザー',
  type: 6,
  required: false,
};
const checkUser = {
  name: 'user',
  description: '確認するユーザー',
  type: 6,
  required: true,
};
const additionalTargets = {
  name: 'additional_targets',
  description: '追加対象（最大19件）',
  type: 3,
  required: false,
  max_length: 400,
};
const amount = {
  name: 'amount',
  description: 'ストライク数',
  type: 4,
  required: false,
  min_value: 1,
  max_value: 100,
};
const reason = { name: 'reason', description: '理由', type: 3, required: true };
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
): readonly CommandDefinition[] {
  const result = [
    command(
      'strike',
      data('strike', 'ストライクを付与', [
        user,
        additionalTargets,
        amount,
        reason,
      ]),
      async ({ interaction }) => {
        const ids = targetIds(interaction);
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
              : '処理に失敗しました。',
          );
          return;
        }
        await interaction.editReply(
          results
            .map((result) =>
              result.ok
                ? `ストライク: ${String(result.value.beforeCount)} → ${String(result.value.afterCount)}`
                : result.error.message,
            )
            .join('\n'),
        );
      },
    ),
    command(
      'pardon',
      data('pardon', 'ストライクを取り消し', [
        user,
        additionalTargets,
        amount,
        reason,
      ]),
      async ({ interaction }) => {
        const ids = targetIds(interaction);
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
              : '処理に失敗しました。',
          );
          return;
        }
        await interaction.editReply(
          results
            .map((result) =>
              result.ok
                ? `ストライク: ${String(result.value.beforeCount)} → ${String(result.value.afterCount)}`
                : result.error.message,
            )
            .join('\n'),
        );
      },
    ),
    command(
      'check',
      data('check', 'ストライク状況を確認', [checkUser]),
      async ({ interaction }) => {
        const result = await service.check(
          guild(interaction),
          interaction.options.getUser('user', true).id,
        );
        await interaction.editReply(
          result.ok
            ? [
                `ストライク: ${String(result.value.count)}`,
                `Mute: ${result.value.muted ? '有' : '無'}${result.value.muteExpiresAt ? ` (解除: ${result.value.muteExpiresAt.toISOString()})` : ''}`,
                `BAN: ${result.value.banned === null ? '取得失敗' : result.value.banned ? '有' : '無'}${result.value.banExpiresAt ? ` (解除: ${result.value.banExpiresAt.toISOString()})` : ''}`,
                `次: ${result.value.next ? `${String(result.value.next.threshold)} / ${result.value.next.action}` : 'なし'}`,
                `履歴:\n${result.value.history.map((entry) => `${entry.delta > 0 ? '+' : ''}${String(entry.delta)}: ${entry.reason} (${entry.createdAt.toISOString()})`).join('\n') || 'なし'}`,
              ].join('\n')
            : result.error.message,
        );
      },
    ),
  ];
  result.push(
    command(
      'punishment',
      data('punishment', '自動制裁設定', [
        {
          name: 'set',
          description: '設定',
          type: 1,
          options: [
            {
              name: 'threshold',
              description: 'しきい値',
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
              description: '期間（例: 7d、2h）',
              type: 3,
              required: false,
            },
          ],
        },
        {
          name: 'remove',
          description: '削除',
          type: 1,
          options: [
            {
              name: 'threshold',
              description: 'しきい値',
              type: 4,
              required: true,
              min_value: 1,
              max_value: 1000000,
            },
          ],
        },
        { name: 'list', description: '一覧', type: 1 },
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
                      `${String(p.threshold)}: ${p.action}${p.durationSeconds ? ` (${String(p.durationSeconds)}s)` : ''} / 設定者: ${p.createdBy} / 更新: ${p.updatedAt.toISOString()}`,
                  )
                  .join('\n') || '設定なし'
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
          r.ok ? 'Punishment設定を更新しました。' : r.error.message,
        );
      },
      'MANAGE_GUILD',
    ),
  );
  return result;
}

function targetIds(
  interaction: Parameters<CommandDefinition['execute']>[0]['interaction'],
): { ok: true; value: string[] } | { ok: false; error: string } {
  const primary = interaction.options.getUser('target')?.id;
  const parsed = parseAdditionalTargets(
    interaction.options.getString('additional_targets'),
  );
  if (!parsed.ok) return { ok: false, error: parsed.error.message };
  const value = [...new Set([...(primary ? [primary] : []), ...parsed.value])];
  return value.length > 0 && value.length <= 20
    ? { ok: true, value }
    : { ok: false, error: '対象を1～20件指定してください。' };
}
