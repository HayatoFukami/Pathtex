import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { CommandDefinition } from '../../commands/contract.js';
import { splitList, type GeneralService } from './service.js';
import type { DiscordGeneralAdapter } from './adapters.js';
import { t } from '../../i18n/index.js';

const base = (
  name: string,
  description: string,
): Pick<
  CommandDefinition,
  | 'name'
  | 'data'
  | 'guildOnly'
  | 'requiredBotPermissions'
  | 'actorNativePermissions'
  | 'authorizationPolicy'
  | 'deferMode'
> => ({
  name,
  data: { name, description, type: 1, contexts: [0], integration_types: [0] },
  guildOnly: true,
  requiredBotPermissions: [],
  actorNativePermissions: [],
  authorizationPolicy: 'PUBLIC',
  deferMode: 'NONE',
});
const response = async (
  interaction: ChatInputCommandInteraction,
  title: string,
  fields: Record<string, string>,
  footer?: string,
  avatarUrl?: string,
): Promise<void> => {
  const entries = Object.entries(fields);
  const chunks: [string, string][][] = [];
  for (let index = 0; index < entries.length; index += 25)
    chunks.push(entries.slice(index, index + 25));
  const makeEmbed = (chunk: [string, string][]): EmbedBuilder => {
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(0x3498db)
      .addFields(
        chunk.map(([name, value]) => ({
          name,
          value: value || t('general:common.none'),
          inline: true,
        })),
      );
    if (footer) embed.setFooter({ text: footer });
    if (avatarUrl) embed.setThumbnail(avatarUrl);
    return embed;
  };
  const payload = { embeds: [makeEmbed(chunks[0] ?? [])] };
  if (interaction.deferred || interaction.replied)
    await interaction.editReply(payload);
  else await interaction.reply(payload);
  for (const chunk of chunks.slice(1))
    await interaction.followUp({ embeds: [makeEmbed(chunk)] });
};
const command = (
  definition: Pick<
    CommandDefinition,
    | 'name'
    | 'data'
    | 'guildOnly'
    | 'requiredBotPermissions'
    | 'actorNativePermissions'
    | 'authorizationPolicy'
    | 'deferMode'
  >,
  execute: CommandDefinition['execute'],
): CommandDefinition => ({ ...definition, execute });

export function generalCommands(
  service: GeneralService,
  adapter: DiscordGeneralAdapter,
): readonly CommandDefinition[] {
  const aboutDescription = t('general:command.about');
  const inviteDescription = t('general:command.invite');
  const pingDescription = t('general:command.ping');
  const roleinfoDescription = t('general:command.roleinfo');
  const serverinfoDescription = t('general:command.serverinfo');
  const userinfoDescription = t('general:command.userinfo');
  const about = base('about', aboutDescription);
  const invite = base('invite', inviteDescription);
  const ping = base('ping', pingDescription);
  const roleinfo = {
    ...base('roleinfo', roleinfoDescription),
    data: {
      ...base('roleinfo', roleinfoDescription).data,
      options: [
        {
          name: 'role',
          description: t('general:command.roleinfoRoleOption'),
          type: 8,
          required: true,
        },
      ],
    },
    deferMode: 'PUBLIC' as const,
  };
  const serverinfo = base('serverinfo', serverinfoDescription);
  const userinfo = {
    ...base('userinfo', userinfoDescription),
    data: {
      ...base('userinfo', userinfoDescription).data,
      options: [
        {
          name: 'user',
          description: t('general:command.userinfoUserOption'),
          type: 6,
          required: false,
        },
      ],
    },
    deferMode: 'PUBLIC' as const,
  };
  return [
    command(about, async ({ interaction }) => {
      await response(
        interaction,
        'About',
        await service.about(),
        'Pathtex Discord Moderation Bot',
        service.runtime.avatarUrl,
      );
    }),
    command(invite, async ({ interaction }) => {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle(t('general:invite.title'))
            .setColor(0x3498db)
            .setDescription(t('general:invite.description')),
        ],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setLabel(t('general:invite.linkLabel'))
              .setStyle(ButtonStyle.Link)
              .setURL(service.invite()),
          ),
        ],
      });
    }),
    command(ping, async ({ interaction, receivedAt }) => {
      const p = await service.ping(receivedAt);
      await response(
        interaction,
        'Ping',
        {
          [t('general:ping.fields.interactionLatency')]: `${String(p.interactionMs)}ms`,
          'Gateway ping': `${String(p.gatewayMs)}ms`,
          'DB ping':
            p.databaseMs === null
              ? t('general:ping.dbFailed')
              : `${String(p.databaseMs)}ms`,
        },
        undefined,
        service.runtime.avatarUrl,
      );
    }),
    command(roleinfo, async ({ interaction }) => {
      const role = interaction.options.getRole('role', true);
      const resolvedRole = interaction.guild?.roles.cache.get(role.id) ?? role;
      const info = service.roleInfo(
        interaction.guild
          ? await adapter.roleWithMemberCount(
              resolvedRole,
              interaction.guild,
              interaction.guild.members.me?.roles.highest,
            )
          : adapter.role(resolvedRole),
      );
      const fields: Record<string, string> = {
        [t('general:roleinfo.fields.name')]: info.name,
        ID: info.id,
        [t('general:roleinfo.fields.color')]: info.color,
        [t('general:roleinfo.fields.createdAt')]: info.createdAt,
        [t('general:roleinfo.fields.position')]:
          info.position === null
            ? t('general:common.unavailable')
            : String(info.position),
        [t('general:roleinfo.fields.memberCount')]:
          info.members === null
            ? t('general:common.unavailableCached')
            : `${String(info.members)}${info.memberCountApproximate ? t('general:common.approximateSuffix') : ''}`,
        mentionable: String(info.mentionable),
        hoist: String(info.hoist),
        managed: String(info.managed),
        [t('general:roleinfo.fields.icon')]: info.icon,
        [t('general:roleinfo.fields.botComparison')]: info.botComparison,
      };
      splitList(info.permissions).forEach((value, index) => {
        fields[t('general:roleinfo.fields.permission', { index: index + 1 })] =
          value;
      });
      await response(
        interaction,
        'Role Info',
        fields,
        undefined,
        service.runtime.avatarUrl,
      );
    }),
    command(serverinfo, async ({ interaction }) => {
      const guild = interaction.guild;
      if (!guild) return;
      const info = service.serverInfo(adapter.server(guild));
      await response(
        interaction,
        'Server Info',
        {
          [t('general:serverinfo.fields.name')]: info.name,
          ID: info.id,
          [t('general:serverinfo.fields.icon')]: info.icon,
          Owner: info.owner,
          [t('general:serverinfo.fields.createdAt')]: info.createdAt,
          [t('general:serverinfo.fields.memberCount')]: String(
            info.memberCount,
          ),
          [t('general:serverinfo.fields.userCount')]: String(info.userCount),
          Bot: String(info.botCount),
          [t('general:serverinfo.fields.textChannels')]: String(
            info.textChannels,
          ),
          [t('general:serverinfo.fields.voiceChannels')]: String(
            info.voiceChannels,
          ),
          [t('general:serverinfo.fields.categories')]: String(
            info.categories,
          ),
          [t('general:serverinfo.fields.threads')]: String(info.threads),
          [t('general:serverinfo.fields.roles')]: String(info.roles),
          Boost: `${String(info.boosts)} (Tier ${info.tier})`,
          Verification: info.verification,
          'Explicit Filter': info.filter,
          Locale: info.locale,
          Features: info.features.join(', ') || t('general:common.none'),
          Vanity: info.vanity,
        },
        info.approximate
          ? t('general:serverinfo.approximateFooter')
          : undefined,
        service.runtime.avatarUrl,
      );
    }),
    command(userinfo, async ({ interaction }) => {
      const user = interaction.options.getUser('user') ?? interaction.user;
      const member = interaction.guild
        ? await adapter.resolveMember(
            interaction.guild,
            user.id,
            interaction.guild.members.cache.get(user.id),
          )
        : undefined;
      const info = service.userInfo(
        await adapter.userWithDetails(user, member),
      );
      await response(
        interaction,
        'User Info',
        {
          username: info.username,
          'Global display name': info.globalName,
          ID: info.id,
          Bot: String(info.bot),
          System: String(info.system),
          [t('general:userinfo.fields.createdAt')]: info.createdAt,
          [t('general:userinfo.fields.joinedAt')]: info.joinedAt,
          Nickname: info.nickname,
          [t('general:userinfo.fields.highestRole')]: info.highestRole,
          [t('general:userinfo.fields.roles')]:
            info.roles.join(', ') || '@everyone',
          Avatar: info.avatar,
          'Guild Avatar': info.guildAvatar,
          'Guild Avatar available': String(info.guildAvatarAvailable),
          Banner: info.banner,
          'Accent color': info.accent,
          Timeout: info.timeout,
        },
        undefined,
        info.guildAvatarAvailable &&
        info.guildAvatar !== t('general:common.none')
          ? info.guildAvatar
          : info.avatar,
      );
    }),
  ];
}

export const generalCommandPermissions = [
  PermissionFlagsBits.ViewChannel,
] as const;
