import {
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { CommandDefinition } from '../../commands/contract.js';
import type { RaidService } from './service.js';
import type {
  AutomodSettingsDto,
  GuildSettingsDto,
} from '../../repositories/contracts.js';
import { t } from '../../i18n/index.js';
/** Discord timestamp markdown seconds; renders in each viewer's timezone. */
const epoch = (date: Date): number => Math.floor(date.getTime() / 1000);
/** The raid state block: ON/OFF, source, start, reason, and the pre-raid
 * verification level. Composed with the AutoRaid settings for `/raidmode
 * status` (§5.3.12). */
const renderRaidState = (settings: GuildSettingsDto): string => {
  if (!settings.raidModeEnabled) return 'RaidMode: OFF';
  const lines = [
    `RaidMode: ON${settings.raidModeSource ? ` (${settings.raidModeSource})` : ''}`,
  ];
  if (settings.raidStartedAt)
    lines.push(
      t('raid:status.startedAt', {
        epoch: epoch(settings.raidStartedAt),
      }),
    );
  if (settings.raidModeReason)
    lines.push(t('raid:status.reason', { reason: settings.raidModeReason }));
  if (settings.verificationLevelBeforeRaid != null)
    lines.push(
      t('raid:status.verificationLevelBeforeRaid', {
        level: settings.verificationLevelBeforeRaid,
      }),
    );
  return lines.join('\n');
};
/** Renders an ON/OFF transition result. A returned case means the state changed;
 * its absence means the idempotent no-op (already ON/OFF, §8.4). */
const renderRaidTransition = (value: unknown, label: 'ON' | 'OFF'): string => {
  const caseNumber = (value as { case?: { caseNumber?: number } } | undefined)
    ?.case?.caseNumber;
  return caseNumber === undefined
    ? t('raid:status.alreadyState', { label })
    : t('raid:status.transition', { label, caseNumber });
};
const renderAutoRaid = (settings: AutomodSettingsDto): string =>
  t('raid:status.autoRaid', {
    state: settings.autoRaidEnabled ? 'ON' : 'OFF',
    joins: settings.autoRaidJoinCount,
    seconds: settings.autoRaidWindowSeconds,
  });
/** Spec §5.3.12 `/raidmode status` display: the raid state plus the AutoRaid
 * settings (AutoRaid設定). */
const renderRaidStatus = (status: {
  settings: GuildSettingsDto;
  autoRaid: AutomodSettingsDto;
}): string =>
  `${renderRaidState(status.settings)}\n${renderAutoRaid(status.autoRaid)}`;
const data = (
  name: string,
  description: string,
  options: unknown[],
  defaultMemberPermissions?: string,
) => ({
  name,
  description,
  type: 1,
  options,
  contexts: [0],
  integration_types: [0],
  ...(defaultMemberPermissions
    ? { default_member_permissions: defaultMemberPermissions }
    : {}),
});
const reason = {
  name: 'reason',
  description: t('raid:commands.options.reason'),
  type: 3,
  required: false,
};
const command = (
  name: string,
  definition: Record<string, unknown>,
  execute: CommandDefinition['execute'],
): CommandDefinition => ({
  name,
  data: definition,
  guildOnly: true,
  // Subcommands need different permissions, so the handler performs the
  // effective channel/guild check immediately before the mutating call.
  requiredBotPermissions: [],
  actorNativePermissions: [
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.KickMembers,
  ],
  authorizationPolicy: 'MODERATOR',
  deferMode: 'EPHEMERAL',
  execute,
});
const gid = (value: string | null) => {
  if (!value) throw new Error('guild required');
  return value;
};
const missingBotPermissions = (
  interaction: ChatInputCommandInteraction,
  permissions: readonly bigint[],
): string[] => {
  const guild = interaction.guild;
  if (guild === null) return permissions.map(String);
  const me = guild.members.me;
  const channel = interaction.channel;
  if (!channel || !('permissionsFor' in channel))
    return permissions.map(String);
  if (me === null) return permissions.map(String);
  const effective = channel.permissionsFor(me);
  return permissions
    .filter((permission) => !effective.has(permission))
    .map(String);
};
const permissionReply = async (
  interaction: ChatInputCommandInteraction,
  permissions: readonly bigint[],
): Promise<boolean> => {
  const missing = missingBotPermissions(interaction, permissions);
  if (missing.length === 0) return true;
  await interaction.editReply(
    t('raid:errors.missingBotPermissions', { missing: missing.join(', ') }),
  );
  return false;
};
export function raidCommands(
  service: RaidService,
): readonly CommandDefinition[] {
  const definitions = [
    command(
      'raidmode',
      data('raidmode', t('raid:commands.raidmode.description'), [
        {
          name: 'status',
          description: t('raid:commands.raidmode.status.description'),
          type: 1,
        },
        {
          name: 'on',
          description: t('raid:commands.raidmode.on.description'),
          type: 1,
          options: [reason],
        },
        {
          name: 'off',
          description: t('raid:commands.raidmode.off.description'),
          type: 1,
          options: [reason],
        },
      ]),
      async ({ interaction }) => {
        const guildId = gid(interaction.guildId);
        const sub = interaction.options.getSubcommand();
        if (
          sub === 'on' &&
          !(await permissionReply(interaction, [
            PermissionFlagsBits.ManageGuild,
            PermissionFlagsBits.KickMembers,
          ]))
        )
          return;
        if (
          sub === 'off' &&
          !(await permissionReply(interaction, [
            PermissionFlagsBits.ManageGuild,
          ]))
        )
          return;
        const reason = interaction.options.getString('reason') ?? undefined;
        if (sub === 'status') {
          const result = await service.status(guildId);
          await interaction.editReply(
            result.ok ? renderRaidStatus(result.value) : result.error.message,
          );
          return;
        }
        const result =
          sub === 'on'
            ? await service.on(guildId, interaction.user.id, reason)
            : await service.off(guildId, interaction.user.id, reason);
        await interaction.editReply(
          result.ok
            ? renderRaidTransition(result.value, sub === 'on' ? 'ON' : 'OFF')
            : result.error.message,
        );
      },
    ),
    command(
      'autoraidmode',
      data(
        'autoraidmode',
        t('raid:commands.autoraidmode.description'),
        [
          {
            name: 'on',
            description: t('raid:commands.autoraidmode.on.description'),
            type: 1,
          },
          {
            name: 'off',
            description: t('raid:commands.autoraidmode.off.description'),
            type: 1,
          },
          {
            name: 'set',
            description: t('raid:commands.autoraidmode.set.description'),
            type: 1,
            options: [
              {
                name: 'joins',
                description: t(
                  'raid:commands.autoraidmode.set.joins.description',
                ),
                type: 4,
                required: true,
                min_value: 3,
                max_value: 100,
              },
              {
                name: 'seconds',
                description: t(
                  'raid:commands.autoraidmode.set.seconds.description',
                ),
                type: 4,
                required: true,
                min_value: 2,
                max_value: 300,
              },
            ],
          },
          {
            name: 'status',
            description: t('raid:commands.autoraidmode.status.description'),
            type: 1,
          },
        ],
        PermissionFlagsBits.ManageGuild.toString(),
      ),
      async ({ interaction }) => {
        const guildId = gid(interaction.guildId);
        const sub = interaction.options.getSubcommand();
        if (sub === 'status') {
          const result = await service.status(guildId);
          await interaction.editReply(
            result.ok
              ? renderAutoRaid(result.value.autoRaid)
              : result.error.message,
          );
          return;
        }
        const result = await service.setAutoRaid(
          guildId,
          sub === 'on' ? true : sub === 'off' ? false : undefined,
          sub === 'set'
            ? interaction.options.getInteger('joins', true)
            : undefined,
          sub === 'set'
            ? interaction.options.getInteger('seconds', true)
            : undefined,
        );
        await interaction.editReply(
          result.ok ? renderAutoRaid(result.value) : result.error.message,
        );
      },
    ),
  ];
  const auto = definitions[1];
  if (auto)
    definitions[1] = {
      ...auto,
      authorizationPolicy: 'MANAGE_GUILD',
      actorNativePermissions: [PermissionFlagsBits.ManageGuild],
    };
  return definitions;
}
