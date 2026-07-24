import { PermissionFlagsBits, ChannelType } from 'discord.js';
import type { CommandDefinition } from '../../commands/contract.js';
import { ConfigurationService, type LogKind } from './service.js';
import {
  configurationDashboard,
  configurationDashboardError,
} from './dashboard.js';
import { t } from '../../i18n/index.js';

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
  description: t('configuration:log.channelOption'),
  type: 7,
  required: true,
  channel_types: [ChannelType.GuildText],
};
const setOffOptions = [
  {
    name: 'set',
    description: t('configuration:log.setDescription'),
    type: 1,
    options: [channelOption],
  },
  { name: 'off', description: t('configuration:log.offDescription'), type: 1 },
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
      guildData('setup', t('configuration:setup.description')),
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
            ? t('configuration:setup.success', {
                succeeded: result.value.succeeded,
                failed: result.value.failed,
              })
            : t('configuration:common.genericUpdateFailure'),
        );
      },
    ),
    messagelog: logCommand('messagelog', 'message', service),
    modlog: logCommand('modlog', 'moderation', service),
    serverlog: logCommand('serverlog', 'server', service),
    voicelog: logCommand('voicelog', 'voice', service),
    timezone: command(
      'timezone',
      guildData('timezone', t('configuration:timezone.description'), [
        {
          name: 'zone',
          description: t('configuration:timezone.zoneOption'),
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
            ? t('configuration:timezone.result', {
                timezone: result.value.settings.timezone,
                time: result.value.currentTime,
              })
            : t('configuration:common.genericUpdateFailure'),
        );
      },
    ),
    modrole: command(
      'modrole',
      guildData('modrole', t('configuration:modrole.description'), [
        {
          name: 'set',
          description: t('configuration:modrole.setDescription'),
          type: 1,
          options: [
            {
              name: 'role',
              description: t('configuration:modrole.roleOption'),
              type: 8,
              required: true,
            },
          ],
        },
        {
          name: 'off',
          description: t('configuration:modrole.offDescription'),
          type: 1,
        },
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
          result.ok
            ? t('configuration:common.modRoleUpdated')
            : t('configuration:common.genericUpdateFailure'),
        );
      },
    ),
    settings: command(
      'settings',
      guildData('settings', t('configuration:settings.description')),
      service,
      [],
      async ({ interaction }) => {
        const result = await service.overview(
          requireGuildId(interaction.guildId),
        );
        if (!result.ok) {
          await interaction.editReply(configurationDashboardError());
          return;
        }
        await interaction.editReply(
          configurationDashboard(result.value, {
            guildId: requireGuildId(interaction.guildId),
            actorId: interaction.user.id,
          }),
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
    guildData(
      name,
      t('configuration:log.commandDescription', { name }),
      setOffOptions,
    ),
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
        result.ok
          ? t('configuration:log.updated')
          : t('configuration:common.genericUpdateFailure'),
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
export function serviceSettingsText(value: Record<string, unknown>): string {
  const settings = value.settings as {
    timezone?: string;
    modlogChannelId?: string | null;
    messageLogChannelId?: string | null;
    serverLogChannelId?: string | null;
    voiceLogChannelId?: string | null;
    modRoleId?: string | null;
    mutedRoleId?: string | null;
  };
  const notSet = t('configuration:common.notSet');
  const none = t('configuration:common.none');
  return [
    t('configuration:settingsText.log', {
      message: settings.messageLogChannelId ?? notSet,
      mod: settings.modlogChannelId ?? notSet,
      server: settings.serverLogChannelId ?? notSet,
      voice: settings.voiceLogChannelId ?? notSet,
    }),
    t('configuration:settingsText.role', {
      mod: settings.modRoleId ?? notSet,
      muted: settings.mutedRoleId ?? notSet,
    }),
    t('configuration:settingsText.timezone', {
      timezone: settings.timezone ?? 'UTC',
    }),
    t('configuration:settingsText.automod', {
      status: Array.isArray(value.automod)
        ? notSet
        : t('configuration:settingsText.automodConfigured'),
    }),
    t('configuration:settingsText.punishment', {
      count: Array.isArray(value.punishments)
        ? String(value.punishments.length)
        : '0',
    }),
    t('configuration:settingsText.ignore', {
      roles: Array.isArray(value.ignoredRoles)
        ? String(value.ignoredRoles.length)
        : '0',
      channels: Array.isArray(value.ignoredChannels)
        ? String(value.ignoredChannels.length)
        : '0',
    }),
    t('configuration:settingsText.automaticIgnoreRoles', {
      value:
        Array.isArray(value.automaticIgnoredRoles) &&
        value.automaticIgnoredRoles.length
          ? value.automaticIgnoredRoles.join(', ')
          : none,
    }),
    t('configuration:settingsText.botWarnings', {
      value:
        Array.isArray(value.botWarnings) && value.botWarnings.length
          ? value.botWarnings.join('; ')
          : none,
    }),
    t('configuration:settingsText.resourceWarnings', {
      value:
        Array.isArray(value.resourceWarnings) && value.resourceWarnings.length
          ? value.resourceWarnings.join('; ')
          : none,
    }),
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
