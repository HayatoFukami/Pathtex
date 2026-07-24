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
import { t } from '../../i18n/index.js';
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
  requiredBotPermissions:
    name === 'announce'
      ? [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.MentionEveryone,
          PermissionFlagsBits.ManageRoles,
        ]
      : [permission],
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
  label = direction === 'next'
    ? t('tools:audit.nextLabel')
    : t('tools:audit.previousLabel'),
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
      definition('announce', t('tools:announce.command.description'), [
        {
          name: 'channel',
          description: t('tools:announce.command.channelOption'),
          type: 7,
          required: true,
          channel_types: [0],
        },
        {
          name: 'role',
          description: t('tools:announce.command.roleOption'),
          type: 8,
          required: true,
        },
        {
          name: 'message',
          description: t('tools:announce.command.messageOption'),
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
            ? `${t('tools:announce.sent')}${result.value.restored ? '' : t('tools:announce.roleRestoreFailedSuffix')}`
            : result.error.message,
        );
      },
      PermissionFlagsBits.ManageMessages,
    ),
    command(
      'audit',
      definition('audit', t('tools:audit.command.description'), [
        {
          name: 'scope',
          description: t('tools:audit.command.scopeOption'),
          type: 3,
          required: true,
          choices: [
            { name: t('tools:audit.command.scopeAll'), value: 'all' },
            { name: t('tools:audit.command.scopeFrom'), value: 'from' },
            { name: t('tools:audit.command.scopeAction'), value: 'action' },
          ],
        },
        {
          name: 'user',
          description: t('tools:audit.command.userOption'),
          type: 6,
        },
        {
          name: 'action',
          description: t('tools:audit.command.actionOption'),
          type: 3,
          autocomplete: true,
        },
        {
          name: 'limit',
          description: t('tools:audit.command.limitOption'),
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
                  .setTitle(t('tools:audit.embedTitle'))
                  .setDescription(
                    result.value.entries
                      .map((e) =>
                        [
                          `[${e.createdAt.toISOString()}] ${e.action}`,
                          t('tools:audit.executorLine', {
                            name: e.userName,
                            id: e.userId,
                          }),
                          t('tools:audit.targetLine', {
                            type: e.targetType ?? t('tools:common.unknown'),
                            target: e.target ?? t('tools:common.none'),
                          }),
                          t('tools:audit.reasonLine', {
                            reason: e.reason ?? t('tools:common.none'),
                          }),
                          ...(e.changes
                            ? [
                                t('tools:audit.changesLine', {
                                  changes: Object.entries(e.changes)
                                    .map(
                                      ([key, change]) => `${key}: ${change}`,
                                    )
                                    .join(', '),
                                }),
                              ]
                            : []),
                        ].join('\n'),
                      )
                      .join('\n\n') || t('tools:audit.empty'),
                  )
                  .setFooter({
                    text: t('tools:audit.footer', {
                      total: result.value.total,
                    }),
                  }),
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
      definition('dehoist', t('tools:dehoist.command.description'), [
        {
          name: 'symbol',
          description: t('tools:dehoist.command.symbolOption'),
          type: 3,
          max_length: 8,
        },
      ]),
      async ({ interaction }) => {
        const result = await service.dehoist(
          value(interaction),
          interaction.options.getString('symbol') ?? '!',
        );
        await replySplit(
          interaction,
          t('tools:completedSummary', {
            success: result.success.length,
            failed: result.failed.length,
            lines: result.outcomes
              .map((item) =>
                t('tools:dehoist.outcomeLine', {
                  userId: item.userId,
                  status: item.ok
                    ? (item.nickname ?? t('tools:dehoist.changed'))
                    : (item.code ?? t('tools:dehoist.failed')),
                }),
              )
              .join('\n'),
          }),
        );
      },
      PermissionFlagsBits.ManageNicknames,
    ),
    command(
      'inviteprune',
      definition('inviteprune', t('tools:inviteprune.command.description'), [
        {
          name: 'max_uses',
          description: t('tools:inviteprune.command.maxUsesOption'),
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
          t('tools:completedSummary', {
            success: result.success.length,
            failed: result.failed.length,
            lines: result.details
              .map((item) =>
                t('tools:inviteprune.outcomeLine', {
                  code: item.code,
                  uses: item.uses,
                  creator: item.creator ?? t('tools:inviteprune.creatorUnknown'),
                  status: item.ok
                    ? t('tools:inviteprune.deleted')
                    : t('tools:inviteprune.deleteFailed'),
                }),
              )
              .join('\n'),
          }),
        );
      },
      PermissionFlagsBits.ManageGuild,
    ),
    command(
      'lookup',
      definition('lookup', t('tools:lookup.command.description'), [
        {
          name: 'query',
          description: t('tools:lookup.command.queryOption'),
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
              ? t('tools:lookup.userTitle')
              : result.value.kind === 'invite'
                ? t('tools:lookup.inviteTitle')
                : t('tools:lookup.guildTitle'),
          )
          .setDescription(
            result.value.kind === 'user'
              ? t('tools:lookup.userDescription', {
                  username: result.value.username,
                  globalName: result.value.globalName ?? t('tools:common.none'),
                  id: result.value.id,
                  bot: result.value.bot
                    ? t('tools:lookup.yes')
                    : t('tools:lookup.no'),
                  createdAt: result.value.createdAt.toISOString(),
                  avatar: result.value.avatarUrl ?? t('tools:common.none'),
                })
              : result.value.kind === 'invite'
                ? t('tools:lookup.inviteDescription', {
                    guildName: result.value.guildName,
                    guildId: result.value.guildId,
                    code: result.value.code,
                    channelName:
                      result.value.channelName ?? t('tools:common.none'),
                    memberCount:
                      result.value.memberCount ?? t('tools:common.unknown'),
                    onlineCount:
                      result.value.onlineCount ?? t('tools:common.unknown'),
                    verification:
                      result.value.verification ?? t('tools:common.unknown'),
                    boost: result.value.boost ?? t('tools:common.unknown'),
                    features:
                      result.value.features.join(', ') ||
                      t('tools:common.none'),
                    description:
                      result.value.description ?? t('tools:lookup.noDescription'),
                  })
                : t('tools:lookup.guildDescription', {
                    guildName: result.value.guildName,
                    guildId: result.value.guildId,
                    description:
                      result.value.description ?? t('tools:lookup.noDescription'),
                    memberCount:
                      result.value.memberCount ?? t('tools:common.unknown'),
                    onlineCount:
                      result.value.onlineCount ?? t('tools:common.unknown'),
                  }),
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
      content: t('tools:audit.actorOnly'),
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
              .setTitle(t('tools:audit.embedTitle'))
              .setDescription(
                result.value.entries
                  .map(
                    (entry) =>
                      `${t('tools:audit.compactHeader', {
                        action: entry.action,
                        userName: entry.userName,
                        userId: entry.userId,
                      })}\n${t('tools:audit.targetLine', {
                        type: entry.targetType ?? t('tools:common.unknown'),
                        target: entry.target ?? t('tools:common.none'),
                      })}\n${t('tools:audit.reasonLine', {
                        reason: entry.reason ?? t('tools:common.none'),
                      })}${
                        entry.changes
                          ? `\n${t('tools:audit.changesLine', {
                              changes: Object.entries(entry.changes)
                                .map(([key, change]) => `${key}: ${change}`)
                                .join(', '),
                            })}`
                          : ''
                      }`,
                  )
                  .join('\n\n') || t('tools:audit.empty'),
              )
              .setFooter({
                text: t('tools:audit.footer', { total: currentTotal }),
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
