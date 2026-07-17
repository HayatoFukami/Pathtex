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
          value: value || 'なし',
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
  const about = base('about', 'Botの情報を表示します');
  const invite = base('invite', 'Botの招待リンクを表示します');
  const ping = base('ping', '応答を確認します');
  const roleinfo = {
    ...base('roleinfo', 'ロールの情報を表示します'),
    data: {
      ...base('roleinfo', '').data,
      options: [
        { name: 'role', description: 'ロール', type: 8, required: true },
      ],
    },
    deferMode: 'PUBLIC' as const,
  };
  const serverinfo = base('serverinfo', 'サーバーの情報を表示します');
  const userinfo = {
    ...base('userinfo', 'ユーザーの情報を表示します'),
    data: {
      ...base('userinfo', '').data,
      options: [
        { name: 'user', description: 'ユーザー', type: 6, required: false },
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
        'Vortex TypeScript Reimplementation',
        service.runtime.avatarUrl,
      );
    }),
    command(invite, async ({ interaction }) => {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Botを招待')
            .setColor(0x3498db)
            .setDescription('Vortexをサーバーへ招待します。'),
        ],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setLabel('招待リンク')
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
          Interaction応答遅延: `${String(p.interactionMs)}ms`,
          'Gateway ping': `${String(p.gatewayMs)}ms`,
          'DB ping':
            p.databaseMs === null ? '失敗' : `${String(p.databaseMs)}ms`,
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
        名前: info.name,
        ID: info.id,
        色: info.color,
        作成日時: info.createdAt,
        順位: info.position === null ? '取得不能' : String(info.position),
        メンバー数:
          info.members === null
            ? '取得不能（キャッシュ外）'
            : `${String(info.members)}${info.memberCountApproximate ? '（概算）' : ''}`,
        mentionable: String(info.mentionable),
        hoist: String(info.hoist),
        managed: String(info.managed),
        アイコン: info.icon,
        Bot最高ロール比較: info.botComparison,
      };
      splitList(info.permissions).forEach((value, index) => {
        fields[`権限${String(index + 1)}`] = value;
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
          名前: info.name,
          ID: info.id,
          アイコン: info.icon,
          Owner: info.owner,
          作成日時: info.createdAt,
          メンバー: String(info.memberCount),
          ユーザー: String(info.userCount),
          Bot: String(info.botCount),
          テキスト: String(info.textChannels),
          ボイス: String(info.voiceChannels),
          カテゴリ: String(info.categories),
          スレッド: String(info.threads),
          ロール: String(info.roles),
          Boost: `${String(info.boosts)} (Tier ${info.tier})`,
          Verification: info.verification,
          'Explicit Filter': info.filter,
          Locale: info.locale,
          Features: info.features.join(', ') || 'なし',
          Vanity: info.vanity,
        },
        info.approximate ? '一部は概算値' : undefined,
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
          作成日時: info.createdAt,
          参加日時: info.joinedAt,
          Nickname: info.nickname,
          最高ロール: info.highestRole,
          ロール: info.roles.join(', ') || '@everyone',
          Avatar: info.avatar,
          'Guild Avatar': info.guildAvatar,
          'Guild Avatar available': String(info.guildAvatarAvailable),
          Banner: info.banner,
          'Accent color': info.accent,
          Timeout: info.timeout,
        },
        undefined,
        service.runtime.avatarUrl,
      );
    }),
  ];
}

export const generalCommandPermissions = [
  PermissionFlagsBits.ViewChannel,
] as const;
