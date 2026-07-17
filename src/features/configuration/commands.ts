import { PermissionFlagsBits, ChannelType } from 'discord.js';
import type { CommandDefinition } from '../../commands/contract.js';
import { ConfigurationService, type LogKind } from './service.js';

const guildData = (
  name: string,
  description: string,
  options: unknown[] = [],
) => ({
  name,
  description,
  type: 1,
  options,
  contexts: [0],
  integration_types: [0],
  default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
});
const channelOption = {
  name: 'channel',
  description: 'ログチャンネル',
  type: 7,
  required: true,
  channel_types: [ChannelType.GuildText],
};
const setOffOptions = [
  {
    name: 'set',
    description: 'ログチャンネルを設定',
    type: 1,
    options: [channelOption],
  },
  { name: 'off', description: 'ログを無効化', type: 1 },
];
const names = [
  'setup',
  'messagelog',
  'modlog',
  'serverlog',
  'voicelog',
  'timezone',
  'modrole',
  'settings',
] as const;
export const configurationCommandNames = names;
export function configurationCommands(
  service: ConfigurationService,
): readonly CommandDefinition[] {
  const definitions: Record<(typeof names)[number], CommandDefinition> = {
    setup: command(
      'setup',
      guildData('setup', 'Mutedロールと権限上書きを準備'),
      service,
      [
        PermissionFlagsBits.ManageRoles,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ViewChannel,
      ],
      async ({ interaction }) => {
        const result = await service.setup(requireGuildId(interaction.guildId));
        await interaction.editReply(
          result.ok
            ? `Mutedロールを設定しました（成功 ${String(result.value.succeeded)} / 失敗 ${String(result.value.failed)}）`
            : result.error.message,
        );
      },
    ),
    messagelog: logCommand('messagelog', 'message', service),
    modlog: logCommand('modlog', 'moderation', service),
    serverlog: logCommand('serverlog', 'server', service),
    voicelog: logCommand('voicelog', 'voice', service),
    timezone: command(
      'timezone',
      guildData('timezone', '表示タイムゾーン', [
        {
          name: 'zone',
          description: 'IANAタイムゾーン',
          type: 3,
          required: true,
        },
      ]),
      service,
      [],
      async ({ interaction }) => {
        const result = await service.setTimezone(
          requireGuildId(interaction.guildId),
          interaction.options.getString('zone', true),
        );
        await interaction.editReply(
          result.ok
            ? `Timezone: ${result.value.settings.timezone}\n現在時刻: ${result.value.currentTime}`
            : result.error.message,
        );
      },
    ),
    modrole: command(
      'modrole',
      guildData('modrole', 'MODロール', [
        {
          name: 'set',
          description: 'ロールを設定',
          type: 1,
          options: [
            { name: 'role', description: 'ロール', type: 8, required: true },
          ],
        },
        { name: 'off', description: '解除', type: 1 },
      ]),
      service,
      [],
      async ({ interaction }) => {
        const sub = interaction.options.getSubcommand();
        const role =
          sub === 'set' ? interaction.options.getRole('role', true) : null;
        const result = await service.setModRole(
          requireGuildId(interaction.guildId),
          role?.id ?? null,
          role
            ? {
                managed: role.managed,
                everyone: role.id === interaction.guild?.id,
                botIntegration:
                  role.tags !== undefined &&
                  role.tags !== null &&
                  'botId' in role.tags,
              }
            : undefined,
        );
        await interaction.editReply(
          result.ok ? 'MODロールを更新しました。' : result.error.message,
        );
      },
    ),
    settings: command(
      'settings',
      guildData('settings', 'サーバー設定を表示'),
      service,
      [],
      async ({ interaction }) => {
        const result = await service.overview(
          requireGuildId(interaction.guildId),
        );
        await interaction.editReply(
          result.ok ? serviceSettingsText(result.value) : result.error.message,
        );
      },
    ),
  };
  definitions.timezone = {
    ...definitions.timezone,
    autocomplete: async (interaction) => {
      const query = interaction.options.getString('zone')?.toLowerCase() ?? '';
      const zones = [
        'UTC',
        'Asia/Tokyo',
        'America/New_York',
        'Europe/London',
        'Europe/Berlin',
        'Australia/Sydney',
      ];
      await interaction.respond(
        zones
          .filter((zone) => zone.toLowerCase().includes(query))
          .slice(0, 25)
          .map((name) => ({ name, value: name })),
      );
    },
  };
  return names.map((name) => definitions[name]);
}
function logCommand(
  name: string,
  kind: LogKind,
  service: ConfigurationService,
): CommandDefinition {
  return command(
    name,
    guildData(name, `${name}設定`, setOffOptions),
    service,
    [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.ReadMessageHistory,
    ],
    async ({ interaction }) => {
      const sub = interaction.options.getSubcommand();
      const result =
        sub === 'off'
          ? await service.disableLog(requireGuildId(interaction.guildId), kind)
          : await service.setLogChannel(
              requireGuildId(interaction.guildId),
              kind,
              interaction.options.getChannel('channel', true).id,
            );
      await interaction.editReply(
        result.ok ? 'ログ設定を更新しました。' : result.error.message,
      );
    },
  );
}
function requireGuildId(value: string | null): string {
  if (!value) throw new Error('Guild-only command received without a guild');
  return value;
}
function command(
  name: string,
  data: Record<string, unknown>,
  _service: ConfigurationService,
  requiredBotPermissions: readonly bigint[] = [],
  execute: CommandDefinition['execute'],
): CommandDefinition {
  return {
    name,
    data,
    guildOnly: true,
    requiredBotPermissions,
    actorNativePermissions: [PermissionFlagsBits.ManageGuild],
    authorizationPolicy: 'MANAGE_GUILD',
    deferMode: 'EPHEMERAL',
    execute,
  };
}
function serviceSettingsText(value: Record<string, unknown>): string {
  const settings = value.settings as {
    timezone?: string;
    modlogChannelId?: string | null;
    messageLogChannelId?: string | null;
    serverLogChannelId?: string | null;
    voiceLogChannelId?: string | null;
    modRoleId?: string | null;
    mutedRoleId?: string | null;
  };
  return [
    `ログ: message=${settings.messageLogChannelId ?? '未設定'} mod=${settings.modlogChannelId ?? '未設定'} server=${settings.serverLogChannelId ?? '未設定'} voice=${settings.voiceLogChannelId ?? '未設定'}`,
    `ロール: MOD=${settings.modRoleId ?? '未設定'} Muted=${settings.mutedRoleId ?? '未設定'}`,
    `Timezone: ${settings.timezone ?? 'UTC'}`,
    `AutoMod: ${Array.isArray(value.automod) ? '未設定' : '設定済み'}`,
    `Punishment: ${Array.isArray(value.punishments) ? String(value.punishments.length) : '0'}件`,
    `Ignore: role ${Array.isArray(value.ignoredRoles) ? String(value.ignoredRoles.length) : '0'} / channel ${Array.isArray(value.ignoredChannels) ? String(value.ignoredChannels.length) : '0'}`,
    `AutoMod resource warnings: ${Array.isArray(value.resourceWarnings) && value.resourceWarnings.length ? value.resourceWarnings.join('; ') : 'なし'}`,
  ].join('\n');
}
export function logKindForCommand(name: string): LogKind | null {
  return (
    (
      {
        messagelog: 'message',
        modlog: 'moderation',
        serverlog: 'server',
        voicelog: 'voice',
      } as Record<string, LogKind | undefined>
    )[name] ?? null
  );
}
