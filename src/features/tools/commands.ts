import { randomUUID } from 'node:crypto';
import {
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
  type ButtonInteraction,
} from 'discord.js';
import type { CommandDefinition } from '../../commands/contract.js';
import type { ToolsService } from './service.js';
const definition = (
  name: string,
  description: string,
  options: readonly Record<string, unknown>[] = [],
): Record<string, unknown> => ({
  name,
  description,
  type: 1,
  options,
  contexts: [0],
  integration_types: [0],
});
const command = (
  name: string,
  data: Record<string, unknown>,
  execute: CommandDefinition['execute'],
  permission: bigint,
  policy: 'PUBLIC' | 'MODERATOR' | 'MANAGE_GUILD' = 'MODERATOR',
): CommandDefinition => ({
  name,
  data,
  guildOnly: true,
  requiredBotPermissions: name === 'announce' ? [] : [permission],
  actorNativePermissions: [permission],
  authorizationPolicy: policy,
  deferMode: 'EPHEMERAL',
  execute,
  ...(name === 'audit'
    ? {
        autocomplete: async (interaction: AutocompleteInteraction) => {
          const query = (
            interaction.options.getString('action') ?? ''
          ).toUpperCase();
          const actions = [
            'CREATE_INSTANT_INVITE',
            'KICK',
            'BAN',
            'MEMBER_UPDATE',
            'MESSAGE_DELETE',
            'MESSAGE_BULK_DELETE',
          ];
          const values: Record<string, number> = {
            CREATE_INSTANT_INVITE: 1,
            KICK: 20,
            BAN: 22,
            MEMBER_UPDATE: 24,
            MESSAGE_DELETE: 72,
            MESSAGE_BULK_DELETE: 73,
          };
          await interaction.respond(
            actions
              .filter((action) => action.includes(query))
              .slice(0, 25)
              .map((action) => ({
                name: action,
                value: String(values[action]),
              })),
          );
        },
      }
    : {}),
});
const value = (i: ChatInputCommandInteraction) =>
  i.guildId ??
  (() => {
    throw new Error('guild required');
  })();
export const splitToolOutput = (
  text: string,
  limit = 1900,
): readonly string[] => {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += limit)
    chunks.push(text.slice(offset, offset + limit));
  return chunks.length ? chunks : [''];
};
const replySplit = async (
  interaction: ChatInputCommandInteraction,
  text: string,
): Promise<void> => {
  const chunks = splitToolOutput(text);
  await interaction.editReply(chunks[0] ?? '');
  for (const chunk of chunks.slice(1))
    await interaction.followUp({ content: chunk, ephemeral: true });
};
type AuditCursorState = {
  scope: 'all' | 'from' | 'action';
  userId?: string;
  action?: string;
  cursor: string;
  total: number;
  backTotal: number;
  priorBackTotal: number;
  expiresAt: number;
  depth: number;
  actorId: string;
};
const auditCursorRegistry = new Map<string, AuditCursorState>();
const AUDIT_CURSOR_MAX = 10_000;
export const cleanupAuditCursorRegistry = (now = Date.now()): void => {
  for (const [token, state] of auditCursorRegistry)
    if (state.expiresAt <= now) auditCursorRegistry.delete(token);
};
export const auditCursorRegistrySize = (): number => auditCursorRegistry.size;
export const createAuditCustomId = (
  direction: 'next' | 'previous',
  cursor: string,
  actorId: string,
  scope: string,
  userId?: string,
  action?: string,
  total = 0,
  expiresAt = Date.now() + 900000,
  depth = 0,
  backTotal = total,
  priorBackTotal = 0,
): string | null => {
  cleanupAuditCursorRegistry();
  const customId = `audit:${direction}:${[scope, userId ?? '', action ?? '', cursor, String(total), String(expiresAt), String(depth), String(backTotal), String(priorBackTotal)].join('~')}:${actorId}`;
  if (customId.length > 100) {
    while (auditCursorRegistry.size >= AUDIT_CURSOR_MAX) {
      const oldest = auditCursorRegistry.keys().next().value;
      if (typeof oldest !== 'string') break;
      auditCursorRegistry.delete(oldest);
    }
    const token = `r${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    auditCursorRegistry.set(token, {
      scope: scope as AuditCursorState['scope'],
      ...(userId ? { userId } : {}),
      ...(action ? { action } : {}),
      cursor,
      total,
      backTotal,
      priorBackTotal,
      expiresAt,
      depth,
      actorId,
    });
    return `audit:${direction}:${token}:${actorId}`;
  }
  return customId;
};
export const validateAuditCustomId = (
  customId: string,
  actorId: string,
): boolean => {
  cleanupAuditCursorRegistry();
  if (customId.length > 100) return false;
  const [feature, direction, state, actor] = customId.split(':');
  if (
    feature !== 'audit' ||
    (direction !== 'next' && direction !== 'previous') ||
    actor !== actorId ||
    !state
  )
    return false;
  const registered = auditCursorRegistry.get(state);
  if (registered)
    return registered.actorId === actorId && registered.expiresAt > Date.now();
  const fields = state.split('~');
  return (
    fields.length === 9 &&
    (fields[0] === 'all' || fields[0] === 'from' || fields[0] === 'action') &&
    /^\d{17,20}$/.test(fields[3] ?? '') &&
    /^\d+$/.test(fields[4] ?? '') &&
    Number(fields[5]) > Date.now() &&
    Number.isInteger(Number(fields[6])) &&
    Number(fields[6]) >= 0 &&
    /^\d+$/.test(fields[7] ?? '') &&
    /^\d+$/.test(fields[8] ?? '')
  );
};
const auditButton = (
  direction: 'next' | 'previous',
  cursor: string,
  actorId: string,
  scope: string,
  userId: string | undefined,
  action: string | undefined,
  total: number,
  expiresAt?: number,
  depth = 0,
  backTotal = total,
  priorBackTotal = 0,
  label = direction === 'next' ? '次へ' : '前へ',
): ButtonBuilder | null => {
  const id = createAuditCustomId(
    direction,
    cursor,
    actorId,
    scope,
    userId,
    action,
    total,
    expiresAt,
    depth,
    backTotal,
    priorBackTotal,
  );
  if (!id || !validateAuditCustomId(id, actorId)) return null;
  return new ButtonBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(ButtonStyle.Secondary);
};
export function toolsCommands(
  service: ToolsService,
): readonly CommandDefinition[] {
  return [
    command(
      'announce',
      definition('announce', '告知を送信', [
        {
          name: 'channel',
          description: 'チャンネル',
          type: 7,
          required: true,
          channel_types: [0],
        },
        { name: 'role', description: 'ロール', type: 8, required: true },
        {
          name: 'message',
          description: '本文',
          type: 3,
          required: true,
          min_length: 1,
          max_length: 2000,
        },
      ]),
      async ({ interaction }) => {
        const result = await service.announce(
          interaction.options.getChannel('channel', true).id,
          interaction.options.getRole('role', true).id,
          interaction.options.getString('message', true),
        );
        await interaction.editReply(
          result.ok
            ? `告知を送信しました${result.value.restored ? '' : '（ロール復元に失敗）'}`
            : result.error.message,
        );
      },
      PermissionFlagsBits.ManageMessages,
    ),
    command(
      'audit',
      definition('audit', '監査ログを表示', [
        {
          name: 'scope',
          description: '範囲',
          type: 3,
          required: true,
          choices: [
            { name: 'すべて', value: 'all' },
            { name: '実行者', value: 'from' },
            { name: '操作', value: 'action' },
          ],
        },
        { name: 'user', description: '実行者', type: 6 },
        { name: 'action', description: '操作', type: 3, autocomplete: true },
        {
          name: 'limit',
          description: '件数',
          type: 4,
          min_value: 1,
          max_value: 100,
        },
      ]),
      async ({ interaction }) => {
        const selectedUser = interaction.options.getUser('user');
        const selectedAction = interaction.options.getString('action');
        const selectedLimit = interaction.options.getInteger('limit');
        const result = await service.auditPage(
          value(interaction),
          interaction.options.getString('scope', true) as
            'all' | 'from' | 'action',
          {
            ...(selectedUser ? { userId: selectedUser.id } : {}),
            ...(selectedAction ? { action: selectedAction } : {}),
            limit: 10,
            totalLimit: selectedLimit ?? 25,
          },
        );
        const auditScope = interaction.options.getString('scope', true);
        const previousButton =
          result.ok && result.value.previousAfter
            ? auditButton(
                'previous',
                result.value.previousAfter,
                interaction.user.id,
                auditScope,
                selectedUser?.id,
                selectedAction ?? undefined,
                Math.max(
                  0,
                  (selectedLimit ?? 25) - result.value.entries.length,
                ),
                undefined,
                0,
              )
            : null;
        const nextButton =
          result.ok && result.value.hasMore && result.value.nextBefore
            ? auditButton(
                'next',
                result.value.nextBefore,
                interaction.user.id,
                auditScope,
                selectedUser?.id,
                selectedAction ?? undefined,
                Math.max(
                  0,
                  (selectedLimit ?? 25) - result.value.entries.length,
                ),
                undefined,
                1,
                selectedLimit ?? 25,
                0,
              )
            : null;
        await interaction.editReply({
          embeds: result.ok
            ? [
                new EmbedBuilder()
                  .setTitle('監査ログ')
                  .setDescription(
                    result.value.entries
                      .map((e) =>
                        [
                          `[${e.createdAt.toISOString()}] ${e.action}`,
                          `実行者: ${e.userName} (${e.userId})`,
                          `対象: ${e.targetType ?? '不明'} / ${e.target ?? 'なし'}`,
                          `理由: ${e.reason ?? 'なし'}`,
                          ...(e.changes
                            ? [
                                `変更: ${Object.entries(e.changes)
                                  .map(([key, change]) => `${key}: ${change}`)
                                  .join(', ')}`,
                              ]
                            : []),
                        ].join('\n'),
                      )
                      .join('\n\n') || '監査ログはありません',
                  )
                  .setFooter({ text: `合計 ${String(result.value.total)}件` }),
              ]
            : [],
          ...(result.ok ? {} : { content: result.error.message }),
          components:
            previousButton || nextButton
              ? [
                  new ActionRowBuilder<ButtonBuilder>().addComponents(
                    ...[previousButton, nextButton].filter(
                      (button): button is ButtonBuilder => button !== null,
                    ),
                  ),
                ]
              : [],
        });
      },
      PermissionFlagsBits.ViewAuditLog,
    ),
    command(
      'dehoist',
      definition('dehoist', '名前の先頭記号を除去', [
        { name: 'symbol', description: '記号', type: 3, max_length: 8 },
      ]),
      async ({ interaction }) => {
        const result = await service.dehoist(
          value(interaction),
          interaction.options.getString('symbol') ?? '!',
        );
        await replySplit(
          interaction,
          `完了: 成功 ${String(result.success.length)} / 失敗 ${String(result.failed.length)}\n${result.outcomes.map((item) => `${item.userId}: ${item.ok ? (item.nickname ?? '変更済み') : (item.code ?? '失敗')}`).join('\n')}`,
        );
      },
      PermissionFlagsBits.ManageNicknames,
    ),
    command(
      'inviteprune',
      definition('inviteprune', '招待を整理', [
        {
          name: 'max_uses',
          description: '最大使用回数',
          type: 4,
          min_value: 0,
        },
      ]),
      async ({ interaction }) => {
        const result = await service.invitePrune(
          value(interaction),
          interaction.options.getInteger('max_uses') ?? 1,
        );
        await replySplit(
          interaction,
          `完了: 成功 ${String(result.success.length)} / 失敗 ${String(result.failed.length)}\n${result.details.map((item) => `${item.code} (${String(item.uses)}) ${item.creator ?? '作成者不明'}: ${item.ok ? '削除済み' : '削除失敗'}`).join('\n')}`,
        );
      },
      PermissionFlagsBits.ManageGuild,
    ),
    command(
      'lookup',
      definition('lookup', 'ユーザーまたは招待を検索', [
        {
          name: 'query',
          description: '検索語',
          type: 3,
          required: true,
          min_length: 2,
          max_length: 200,
        },
      ]),
      async ({ interaction }) => {
        const result = await service.lookup(
          interaction.options.getString('query', true),
        );
        if (!result.ok) {
          await interaction.editReply(result.error.message);
          return;
        }
        const embed = new EmbedBuilder()
          .setTitle(
            result.value.kind === 'user'
              ? 'ユーザー情報'
              : result.value.kind === 'invite'
                ? '招待情報'
                : 'ギルド情報',
          )
          .setDescription(
            result.value.kind === 'user'
              ? `ユーザー名: ${result.value.username}\nGlobal Name: ${result.value.globalName ?? 'なし'}\nID: ${result.value.id}\nBot: ${result.value.bot ? 'はい' : 'いいえ'}\n作成日時: ${result.value.createdAt.toISOString()}\nAvatar: ${result.value.avatarUrl ?? 'なし'}`
              : result.value.kind === 'invite'
                ? `ギルド: ${result.value.guildName} (${result.value.guildId})\n招待コード: ${result.value.code}\nチャンネル: ${result.value.channelName ?? 'なし'}\nメンバー数: ${String(result.value.memberCount ?? '不明')} / オンライン: ${String(result.value.onlineCount ?? '不明')}\nVerification: ${result.value.verification ?? '不明'}\nBoost: ${String(result.value.boost ?? '不明')}\nFeatures: ${result.value.features.join(', ') || 'なし'}\n${result.value.description ?? '説明なし'}`
                : `ギルド: ${result.value.guildName} (${result.value.guildId})\n${result.value.description ?? '説明なし'}\nメンバー数: ${String(result.value.memberCount ?? '不明')} / オンライン: ${String(result.value.onlineCount ?? '不明')}`,
          );
        const icon =
          result.value.kind === 'user'
            ? result.value.avatarUrl
            : result.value.icon;
        if (icon) embed.setThumbnail(icon);
        await interaction.editReply({ embeds: [embed] });
      },
      PermissionFlagsBits.ViewChannel,
      'PUBLIC',
    ),
  ];
}
export async function handleToolsComponent(
  interaction: ButtonInteraction,
  service: ToolsService,
): Promise<boolean> {
  const [feature, direction, encoded, actorId] =
    interaction.customId.split(':');
  if (feature !== 'audit' || (direction !== 'next' && direction !== 'previous'))
    return false;
  if (!encoded) return false;
  if (!validateAuditCustomId(interaction.customId, interaction.user.id))
    return false;
  if (interaction.user.id !== actorId || !interaction.guildId) {
    await interaction.reply({
      content: 'この操作は実行者本人のみ利用できます。',
      ephemeral: true,
    });
    return true;
  }
  const registered = auditCursorRegistry.get(encoded);
  let state: AuditCursorState;
  if (registered) state = registered;
  else {
    const fields = encoded.split('~');
    if (
      fields.length !== 9 ||
      !fields[0] ||
      !fields[3] ||
      Number(fields[5]) <= Date.now() ||
      !/^\d+$/.test(fields[6] ?? '') ||
      !/^\d+$/.test(fields[7] ?? '') ||
      !/^\d+$/.test(fields[8] ?? '')
    )
      return false;
    state = {
      scope: fields[0] as AuditCursorState['scope'],
      ...(fields[1] ? { userId: fields[1] } : {}),
      ...(fields[2] ? { action: fields[2] } : {}),
      cursor: fields[3],
      total: Number(fields[4]),
      backTotal: Number(fields[7]),
      priorBackTotal: Number(fields[8]),
      expiresAt: Number(fields[5]),
      depth: Number(fields[6]),
      actorId,
    };
  }
  const pageOptions =
    direction === 'next' ? { before: state.cursor } : { after: state.cursor };
  const result = await service.auditPage(interaction.guildId, state.scope, {
    limit: 10,
    totalLimit: direction === 'previous' ? state.backTotal : state.total,
    ...pageOptions,
    ...(state.userId ? { userId: state.userId } : {}),
    ...(state.action ? { action: state.action } : {}),
  });
  const pageCount = result.ok ? result.value.entries.length : 0;
  const currentTotal =
    direction === 'next'
      ? Math.max(0, state.total - pageCount)
      : state.total + pageCount;
  const nextTotal = direction === 'next' ? currentTotal : state.total;
  const nextBackTotal = state.backTotal;
  const nextPriorBackTotal =
    direction === 'next' ? state.backTotal : state.priorBackTotal;
  const previousButton =
    result.ok && result.value.previousAfter && state.depth > 0
      ? auditButton(
          'previous',
          result.value.previousAfter,
          interaction.user.id,
          state.scope,
          state.userId,
          state.action,
          state.total,
          state.expiresAt,
          Math.max(0, state.depth - 1),
          state.backTotal,
          state.priorBackTotal,
        )
      : null;
  const nextButton =
    result.ok && result.value.hasMore && result.value.nextBefore
      ? auditButton(
          'next',
          result.value.nextBefore,
          interaction.user.id,
          state.scope,
          state.userId,
          state.action,
          nextTotal,
          state.expiresAt,
          state.depth + 1,
          nextBackTotal,
          nextPriorBackTotal,
        )
      : null;
  await interaction.update({
    ...(result.ok
      ? {
          embeds: [
            new EmbedBuilder()
              .setTitle('監査ログ')
              .setDescription(
                result.value.entries
                  .map(
                    (entry) =>
                      `${entry.action} / ${entry.userName} (${entry.userId})\n対象: ${entry.targetType ?? '不明'} / ${entry.target ?? 'なし'}\n理由: ${entry.reason ?? 'なし'}${
                        entry.changes
                          ? `\n変更: ${Object.entries(entry.changes)
                              .map(([key, change]) => `${key}: ${change}`)
                              .join(', ')}`
                          : ''
                      }`,
                  )
                  .join('\n\n') || '監査ログはありません',
              )
              .setFooter({
                text: `合計 ${String(currentTotal)}件`,
              }),
          ],
        }
      : { content: result.error.message }),
    components:
      previousButton || nextButton
        ? [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              ...[previousButton, nextButton].filter(
                (button): button is ButtonBuilder => button !== null,
              ),
            ),
          ]
        : [] /*
      result.ok && (result.value.hasMore || result.value.previousAfter)
        ? [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              ...(result.value.previousAfter
                ? [
                    new ButtonBuilder()
                      .setCustomId(
                        createAuditCustomId(
                          'previous',
                          result.value.previousAfter,
                          interaction.user.id,
                          state.scope,
                          state.userId,
                          state.action,
                          nextTotal,
                          state.expiresAt,
                        ),
                      )
                      .setLabel('前へ')
                      .setStyle(ButtonStyle.Secondary),
                  ]
                : []),
              ...(result.value.hasMore && result.value.nextBefore
                ? [
                    new ButtonBuilder()
                      .setCustomId(
                        createAuditCustomId(
                          'next',
                          result.value.nextBefore,
                          interaction.user.id,
                          state.scope,
                          state.userId,
                          state.action,
                          nextTotal,
                          state.expiresAt,
                        ),
                      )
                      .setLabel('次へ')
                      .setStyle(ButtonStyle.Secondary),
                  ]
                : []),
            ),
          ]
        : [], */,
  });
  return true;
}
