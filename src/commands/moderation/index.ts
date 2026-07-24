import type {
  ChatInputCommandInteraction,
  PermissionResolvable,
} from 'discord.js';
import type { CommandDefinition } from '../contract.js';
import type { ModerationService } from '../../features/moderation/moderation-service.js';
import {
  resolveReason,
  resolveTargets,
  resolveUserIds,
  resolveDuration,
} from '../../features/moderation/validation.js';
import { DEFAULT_BULK_TARGET_LIMIT } from '../../domain/parsers.js';
import RE2 from 're2';
import {
  TargetIdentitySchema,
  type TargetIdentity,
} from '../../services/target-identity.js';

type Options = {
  getUser(name: string): {
    id: string;
    globalName?: string | null;
    username?: string;
  } | null;
  getMember?(name: string): { displayName?: string } | null;
  getString(name: string): string | null;
  getInteger(name: string): number | null;
  getBoolean(name: string): boolean | null;
  getSubcommand?(): string;
};
type Action = 'kick' | 'ban' | 'silentban' | 'softban' | 'mute' | 'unmute';
const guildCommand = (
  name: string,
  description: string,
  options: readonly Record<string, unknown>[] = [],
) => ({
  name,
  type: 1,
  description,
  options,
  contexts: [0],
  integration_types: [0],
});
const targetOptions = [
  { name: 'target', type: 6, description: '主対象', required: false },
  {
    name: 'additional_targets',
    type: 3,
    description: '追加対象Snowflake',
    required: false,
    max_length: 400,
  },
  {
    name: 'reason',
    type: 3,
    description: '理由',
    required: false,
    max_length: 1000,
  },
];
const reply = async (
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> => {
  await interaction.editReply({ content });
};
const resultText = (action: string, result: unknown): string => {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('ok' in result) ||
    !(result as { ok: boolean }).ok
  )
    return `処理結果: ${action}`;
  const outcomes = (
    result as unknown as {
      value: {
        outcomes: readonly { targetId: string; ok: boolean; code?: string }[];
      };
    }
  ).value.outcomes;
  const success = outcomes.filter((item) => item.ok).length;
  const failed = outcomes.length - success;
  const details = outcomes
    .filter((item) => !item.ok)
    .map((item) => `${item.targetId}: ${item.code ?? 'FAILED'}`)
    .join('\n');
  return `処理結果: ${action}\n成功: ${String(success)} / 失敗: ${String(failed)}${details ? `\n${details}` : ''}`;
};
const targetLabel = (
  targetId: string,
  names?: Readonly<Record<string, string>>,
  identity?: TargetIdentity,
): string => {
  if (identity) return `${identity.displayName} (${identity.userId})`;
  const name = names?.[targetId];
  return name ? `${name} (${targetId})` : targetId;
};
const replyOutcome = async (
  interaction: ChatInputCommandInteraction,
  action: string,
  result: unknown,
  names?: Readonly<Record<string, string>>,
): Promise<void> => {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('ok' in result) ||
    !(result as { ok: boolean }).ok
  ) {
    await reply(interaction, resultText(action, result));
    return;
  }
  const outcomes = (
    result as unknown as {
      value: {
        outcomes: readonly { targetId: string; ok: boolean; code?: string }[];
      };
    }
  ).value.outcomes;
  const success = outcomes.filter((item) => item.ok).length;
  const failed = outcomes.length - success;
  await interaction.editReply({
    embeds: [
      {
        title: `処理結果: ${action}`,
        color: failed === 0 ? 0x2ecc71 : success === 0 ? 0xe74c3c : 0xf1c40f,
        fields: outcomes.map((item) => ({
          name: targetLabel(
            item.targetId,
            names,
            (item as { identity?: TargetIdentity }).identity,
          ),
          value: item.ok ? '成功' : `失敗: ${item.code ?? 'FAILED'}`,
        })),
        footer: {
          text: `成功 ${String(success)} / 失敗 ${String(failed)} / 合計 ${String(outcomes.length)}`,
        },
      },
    ],
  });
};

const permissions: Record<Action, PermissionResolvable> = {
  kick: 'KickMembers',
  ban: 'BanMembers',
  silentban: 'BanMembers',
  softban: 'BanMembers',
  mute: 'ManageRoles',
  unmute: 'ManageRoles',
};
const actions: Record<Action, keyof ModerationService> = {
  kick: 'kick',
  ban: 'ban',
  silentban: 'silentBan',
  softban: 'softBan',
  mute: 'mute',
  unmute: 'unmute',
};

function command(
  action: Action,
  service: ModerationService,
  maxBulkTargets: number = DEFAULT_BULK_TARGET_LIMIT,
): CommandDefinition {
  return {
    name: action,
    guildOnly: true,
    requiredBotPermissions: [permissions[action]],
    actorNativePermissions: [permissions[action]],
    authorizationPolicy: 'MODERATOR',
    deferMode: 'EPHEMERAL',
    data: guildCommand(
      action,
      `${action} moderation command`,
      action === 'ban'
        ? [
            ...targetOptions,
            { name: 'duration', type: 3, description: '期間', required: false },
            {
              name: 'delete_messages',
              type: 4,
              description: '削除日数',
              required: false,
              min_value: 0,
              max_value: 7,
            },
          ]
        : action === 'silentban'
          ? [
              ...targetOptions,
              {
                name: 'duration',
                type: 3,
                description: '期間',
                required: false,
              },
            ]
          : action === 'softban'
            ? [
                ...targetOptions,
                {
                  name: 'delete_messages',
                  type: 4,
                  description: '削除日数',
                  required: false,
                  min_value: 0,
                  max_value: 7,
                },
              ]
            : action === 'mute'
              ? [
                  ...targetOptions,
                  {
                    name: 'duration',
                    type: 3,
                    description: '期間',
                    required: false,
                  },
                ]
              : targetOptions,
    ),
    async execute({ interaction }) {
      const options = interaction.options as unknown as Options;
      const target = options.getUser('target');
      const member = options.getMember?.('target');
      const additional = options.getString('additional_targets');
      const parsed = resolveTargets(target?.id, additional, maxBulkTargets);
      if (!parsed.ok) {
        await reply(interaction, parsed.error.message);
        return;
      }
      const reason = resolveReason(options.getString('reason'));
      if (!reason.ok) {
        await reply(interaction, reason.error.message);
        return;
      }
      const targets: Array<{ id: string; identity?: TargetIdentity }> =
        parsed.value.map((id) => ({ id }));
      if (target) {
        const displayName =
          member?.displayName ?? target.globalName ?? target.username;
        const interactionIdentity = TargetIdentitySchema.safeParse({
          userId: target.id,
          displayName,
        });
        if (interactionIdentity.success) {
          targets[0] = { id: target.id, identity: interactionIdentity.data };
        }
      }
      const fn = service[actions[action]] as (input: {
        guildId: string;
        actorId: string;
        targets: readonly {
          id: string;
        }[];
        reason: string;
        deleteMessages?: number;
      }) => Promise<unknown>;
      const input = {
        guildId: interaction.guildId ?? '',
        actorId: interaction.user.id,
        targets,
        reason: reason.value,
      };
      const deleteMessages = options.getInteger('delete_messages');
      const durationText = options.getString('duration');
      const duration =
        durationText === null
          ? null
          : resolveDuration(
              durationText,
              action === 'ban' || action === 'silentban'
                ? 365 * 86400
                : 28 * 86400,
            );
      if (duration !== null && !duration.ok) {
        await reply(interaction, duration.error.message);
        return;
      }
      const result = await fn.call(service, {
        ...input,
        ...(deleteMessages === null ? {} : { deleteMessages }),
        ...(duration?.ok ? { durationSeconds: duration.value } : {}),
      });
      const targetName =
        member?.displayName ?? target?.globalName ?? target?.username;
      await replyOutcome(
        interaction,
        action,
        result,
        action === 'kick' && targetName && target
          ? { [target.id]: targetName }
          : undefined,
      );
    },
  };
}

export function createModerationCommands(
  service: ModerationService,
  maxBulkTargets: number = DEFAULT_BULK_TARGET_LIMIT,
): readonly CommandDefinition[] {
  const commands: Action[] = [
    'kick',
    'ban',
    'silentban',
    'softban',
    'mute',
    'unmute',
  ];
  return commands.map((action) => command(action, service, maxBulkTargets));
}

export function createUnbanCommand(
  service: ModerationService,
  maxBulkTargets: number = DEFAULT_BULK_TARGET_LIMIT,
): CommandDefinition {
  return {
    name: 'unban',
    guildOnly: true,
    requiredBotPermissions: ['BanMembers'],
    actorNativePermissions: ['BanMembers'],
    authorizationPolicy: 'MODERATOR',
    deferMode: 'EPHEMERAL',
    data: guildCommand('unban', 'unban users', [
      {
        name: 'user_ids',
        type: 3,
        description: '1～20件のSnowflake',
        required: true,
        max_length: 400,
      },
      {
        name: 'reason',
        type: 3,
        description: '理由',
        required: false,
        max_length: 1000,
      },
    ]),
    async execute({ interaction }) {
      const options = interaction.options as unknown as Options;
      const ids = resolveUserIds(options.getString('user_ids'), maxBulkTargets);
      if (!ids.ok) {
        await reply(interaction, ids.error.message);
        return;
      }
      const reason = resolveReason(options.getString('reason'));
      if (!reason.ok) {
        await reply(interaction, reason.error.message);
        return;
      }
      const result = await service.unban({
        guildId: interaction.guildId ?? '',
        actorId: interaction.user.id,
        targets: ids.value.map((id) => ({ id })),
        reason: reason.value,
      });
      await replyOutcome(interaction, 'unban', result);
    },
  };
}

export function createModerationCommandManifest(
  service: ModerationService,
  maxBulkTargets: number = DEFAULT_BULK_TARGET_LIMIT,
): readonly CommandDefinition[] {
  return [
    ...createModerationCommands(service, maxBulkTargets),
    createUnbanCommand(service, maxBulkTargets),
  ];
}

export function createModerationUtilityCommands(
  service?: ModerationService,
): readonly CommandDefinition[] {
  const definitions: Array<[string, PermissionResolvable]> = [
    ['reason', 'KickMembers'],
    ['slowmode', 'ManageChannels'],
    ['clean', 'ManageMessages'],
  ];
  return definitions.map(([name, permission]) => ({
    name,
    guildOnly: true,
    requiredBotPermissions: [permission],
    actorNativePermissions:
      name === 'reason'
        ? ['KickMembers', 'BanMembers', 'ManageGuild']
        : [permission],
    authorizationPolicy: 'MODERATOR' as const,
    deferMode: 'EPHEMERAL' as const,
    data: guildCommand(
      name,
      `${name} moderation command`,
      name === 'clean'
        ? [
            {
              name: 'limit',
              type: 4,
              description: '検索件数',
              required: false,
              min_value: 2,
              max_value: 1000,
            },
            { name: 'bots', type: 5, description: 'Bot投稿', required: false },
            {
              name: 'embeds',
              type: 5,
              description: 'Embed付き',
              required: false,
            },
            {
              name: 'links',
              type: 5,
              description: 'リンク付き',
              required: false,
            },
            {
              name: 'images',
              type: 5,
              description: '画像・動画付き',
              required: false,
            },
            {
              name: 'user_id',
              type: 3,
              description: '投稿者Snowflake',
              required: false,
            },
            {
              name: 'contains',
              type: 3,
              description: '本文部分一致',
              required: false,
              max_length: 500,
            },
            {
              name: 'regex',
              type: 3,
              description: 'RE2正規表現',
              required: false,
              max_length: 500,
            },
          ]
        : name === 'reason'
          ? [
              {
                name: 'reason',
                type: 3,
                description: '新しい理由',
                required: true,
                max_length: 1000,
              },
              {
                name: 'case_number',
                type: 4,
                description: 'ケース番号',
                required: false,
                min_value: 1,
              },
            ]
          : [
              {
                name: 'set',
                type: 1,
                description: 'slowmodeを設定',
                options: [
                  {
                    name: 'interval',
                    type: 4,
                    description: '秒',
                    required: true,
                    min_value: 0,
                    max_value: 21600,
                  },
                  {
                    name: 'duration',
                    type: 3,
                    description: '復元期間',
                    required: false,
                  },
                ],
              },
              {
                name: 'off',
                type: 1,
                description: 'slowmodeを解除',
                options: [],
              },
              {
                name: 'status',
                type: 1,
                description: 'slowmode状態',
                options: [],
              },
            ],
    ),
    async execute({ interaction }) {
      if (!service) {
        await reply(interaction, `処理結果: ${name}`);
        return;
      }
      if (name === 'reason') {
        const options = interaction.options as unknown as Options;
        const result = await service.reason(
          interaction.guildId ?? '',
          options.getInteger('case_number') ?? undefined,
          options.getString('reason') ?? '',
        );
        await reply(
          interaction,
          result.ok
            ? `ケース #${String(result.value.caseNumber)} の理由を更新しました。`
            : result.error.message,
        );
        return;
      }
      if (name === 'clean') {
        const options = interaction.options as unknown as Options;
        const cleanInput = {
          guildId: interaction.guildId ?? '',
          channelId: interaction.channelId,
        } as {
          guildId: string;
          channelId: string;
          limit?: number;
          bots?: boolean;
          embeds?: boolean;
          links?: boolean;
          images?: boolean;
          userId?: string;
          contains?: string;
          regex?: { test(value: string): boolean };
        };
        const limit = options.getInteger('limit');
        if (limit !== null) cleanInput.limit = limit;
        const bots = options.getBoolean('bots');
        if (bots !== null) cleanInput.bots = bots;
        const embeds = options.getBoolean('embeds');
        if (embeds !== null) cleanInput.embeds = embeds;
        const links = options.getBoolean('links');
        if (links !== null) cleanInput.links = links;
        const images = options.getBoolean('images');
        if (images !== null) cleanInput.images = images;
        const userId = options.getString('user_id');
        if (userId !== null) cleanInput.userId = userId;
        const contains = options.getString('contains');
        if (contains !== null) cleanInput.contains = contains;
        const regexText = options.getString('regex');
        if (regexText !== null) {
          try {
            cleanInput.regex = new RE2(regexText);
          } catch {
            await reply(interaction, '正規表現が不正です。');
            return;
          }
        }
        const result = await service.clean(cleanInput);
        await reply(
          interaction,
          result.ok
            ? `検索: ${String(result.value.searched)}件 / 一致: ${String(result.value.matched)}件 / 削除成功: ${String(result.value.deleted)}件 / 失敗: ${String(result.value.failed)}件`
            : result.error.message,
        );
        return;
      }
      const options = interaction.options as unknown as Options;
      const mode =
        options.getString('mode') ?? options.getSubcommand?.() ?? 'status';
      if (mode === 'status') {
        await reply(
          interaction,
          'Slowmode status は現在のチャンネルで確認してください。',
        );
        return;
      }
      const interval = mode === 'off' ? 0 : options.getInteger('interval');
      if (interval === null) {
        await reply(interaction, 'interval は必須です。');
        return;
      }
      const durationText = options.getString('duration');
      const duration =
        durationText === null
          ? null
          : resolveDuration(durationText, 28 * 86400);
      if (duration !== null && !duration.ok) {
        await reply(interaction, duration.error.message);
        return;
      }
      const slowmode = await service.slowmode(
        interaction.guildId ?? '',
        interaction.user.id,
        interaction.channelId,
        interval,
        duration?.ok ? duration.value : undefined,
      );
      await reply(
        interaction,
        slowmode.ok ? `処理結果: slowmode (${mode})` : slowmode.error.message,
      );
    },
  }));
}
