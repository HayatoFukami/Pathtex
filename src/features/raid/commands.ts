import {
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { CommandDefinition } from '../../commands/contract.js';
import type { RaidService } from './service.js';
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
  description: '理由',
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
    `Botに必要な権限がありません: ${missing.join(', ')}`,
  );
  return false;
};
export function raidCommands(
  service: RaidService,
): readonly CommandDefinition[] {
  const definitions = [
    command(
      'raidmode',
      data('raidmode', 'RaidModeを管理', [
        { name: 'status', description: '状態', type: 1 },
        { name: 'on', description: '有効化', type: 1, options: [reason] },
        { name: 'off', description: '無効化', type: 1, options: [reason] },
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
        const result =
          sub === 'status'
            ? await service.status(guildId)
            : sub === 'on'
              ? await service.on(
                  guildId,
                  interaction.user.id,
                  interaction.options.getString('reason') ?? undefined,
                )
              : await service.off(
                  guildId,
                  interaction.user.id,
                  interaction.options.getString('reason') ?? undefined,
                );
        await interaction.editReply(
          result.ok ? JSON.stringify(result.value) : result.error.message,
        );
      },
    ),
    command(
      'autoraidmode',
      data(
        'autoraidmode',
        'AutoRaidModeを設定',
        [
          { name: 'on', description: '有効化', type: 1 },
          { name: 'off', description: '無効化', type: 1 },
          {
            name: 'set',
            description: '閾値設定',
            type: 1,
            options: [
              {
                name: 'joins',
                description: '参加数',
                type: 4,
                required: true,
                min_value: 3,
                max_value: 100,
              },
              {
                name: 'seconds',
                description: '秒数',
                type: 4,
                required: true,
                min_value: 2,
                max_value: 300,
              },
            ],
          },
          { name: 'status', description: '状態', type: 1 },
        ],
        PermissionFlagsBits.ManageGuild.toString(),
      ),
      async ({ interaction }) => {
        const guildId = gid(interaction.guildId);
        const sub = interaction.options.getSubcommand();
        const result =
          sub === 'status'
            ? await service.status(guildId)
            : await service.setAutoRaid(
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
          result.ok ? JSON.stringify(result.value) : result.error.message,
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
