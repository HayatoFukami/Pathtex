import {
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type { CommandDefinition } from '../../commands/contract.js';
import { AutomodService } from './service.js';

const option = (
  name: string,
  description: string,
  type: number,
  extra: Record<string, unknown> = {},
) => ({ name, description, type, ...extra });
const sub = (
  name: string,
  description: string,
  options: readonly Record<string, unknown>[] = [],
) => ({ name, description, type: 1, options });
const group = (
  name: string,
  description: string,
  options: readonly Record<string, unknown>[],
) => ({ name, description, type: 2, options });
const root = (
  name: string,
  description: string,
  options: readonly Record<string, unknown>[],
) => ({
  name,
  description,
  type: 1,
  options,
  contexts: [0],
  integration_types: [0],
  default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
});
const result = async (
  interaction: ChatInputCommandInteraction,
  value: unknown,
) => {
  const content =
    value &&
    typeof value === 'object' &&
    'ok' in value &&
    (value as { ok: boolean }).ok &&
    'value' in value &&
    (value as { value?: unknown }).value &&
    typeof (value as { value: unknown }).value === 'object' &&
    'automaticIgnoreContinues' in (value as { value: object }).value
      ? '明示Ignoreを解除しました。自動Ignoreは継続します。'
      : value &&
          typeof value === 'object' &&
          'roles' in value &&
          'channels' in value
        ? `明示Ignoreロール: ${(value as { roles: readonly { roleId: string }[] }).roles.map((item) => item.roleId).join(', ') || 'なし'}\n明示Ignoreチャンネル: ${(value as { channels: readonly { channelId: string }[] }).channels.map((item) => item.channelId).join(', ') || 'なし'}\nBot階層による自動Ignore: ${((value as { hierarchyRoles?: readonly string[] }).hierarchyRoles ?? []).join(', ') || 'なし'}\n強権限による自動Ignore: ${((value as { strongPermissionRoles?: readonly string[] }).strongPermissionRoles ?? []).join(', ') || 'なし'}\nリソース警告: ${((value as { resourceWarnings?: readonly string[] }).resourceWarnings ?? []).join(', ') || 'なし'}`
        : value &&
            typeof value === 'object' &&
            'ok' in value &&
            !(value as { ok: boolean }).ok
          ? `設定に失敗しました: ${(value as unknown as { error: { message: string } }).error.message}`
          : value &&
              typeof value === 'object' &&
              'ok' in value &&
              (value as { ok: boolean }).ok &&
              'value' in value &&
              (value as { value?: unknown }).value &&
              typeof (value as { value: unknown }).value === 'object' &&
              'warning' in (value as { value: object }).value
            ? `設定を更新しました。警告: ${(value as { value: { warning: string } }).value.warning}`
            : '設定を更新しました。';
  await interaction.editReply({ content });
};
const make = (
  service: AutomodService,
  name: string,
  data: Record<string, unknown>,
  execute: (i: ChatInputCommandInteraction) => Promise<unknown>,
): CommandDefinition => ({
  name,
  data,
  guildOnly: true,
  requiredBotPermissions: [],
  actorNativePermissions: [PermissionFlagsBits.ManageGuild],
  authorizationPolicy: 'MANAGE_GUILD',
  deferMode: 'EPHEMERAL',
  async execute({ interaction }) {
    if (interaction.guildId) await execute(interaction);
  },
});
export function automodCommands(
  service: AutomodService,
): readonly CommandDefinition[] {
  const fixed = (
    name: string,
    field:
      | 'antiInviteStrikes'
      | 'antiReferralStrikes'
      | 'antiEveryoneStrikes'
      | 'antiCopypastaStrikes',
  ) =>
    make(
      service,
      name,
      root(name, `${name}設定`, [
        sub('set', '有効化', [
          option('strikes', 'ストライク数', 4, {
            required: true,
            min_value: 1,
            max_value: 100,
          }),
        ]),
        sub('off', '無効化'),
      ]),
      async (i) =>
        result(
          i,
          await service.update(i.guildId!, {
            [field]:
              i.options.getSubcommand() === 'off'
                ? 0
                : i.options.getInteger('strikes', true),
          }),
        ),
    );
  return [
    fixed('antiinvite', 'antiInviteStrikes'),
    fixed('antireferral', 'antiReferralStrikes'),
    fixed('antieveryone', 'antiEveryoneStrikes'),
    fixed('anticopypasta', 'antiCopypastaStrikes'),
    make(
      service,
      'maxmentions',
      root('maxmentions', 'メンション数設定', [
        group('user', 'ユーザーメンション', [
          sub('set', '設定', [
            option('maximum', '最大数', 4, {
              required: true,
              min_value: 1,
              max_value: 100,
            }),
          ]),
          sub('off', '無効化'),
        ]),
        group('role', 'ロールメンション', [
          sub('set', '設定', [
            option('maximum', '最大数', 4, {
              required: true,
              min_value: 1,
              max_value: 100,
            }),
          ]),
          sub('off', '無効化'),
        ]),
      ]),
      async (i) => {
        const field =
          i.options.getSubcommandGroup() === 'role'
            ? 'maxRoleMentions'
            : 'maxUserMentions';
        await result(
          i,
          await service.update(i.guildId!, {
            [field]:
              i.options.getSubcommand() === 'off'
                ? null
                : i.options.getInteger('maximum', true),
          }),
        );
      },
    ),
    make(
      service,
      'maxlines',
      root('maxlines', '行数設定', [
        sub('set', '設定', [
          option('maximum', '最大行数', 4, {
            required: true,
            min_value: 1,
            max_value: 500,
          }),
        ]),
        sub('off', '無効化'),
      ]),
      async (i) =>
        result(
          i,
          await service.update(i.guildId!, {
            maxLines:
              i.options.getSubcommand() === 'off'
                ? null
                : i.options.getInteger('maximum', true),
          }),
        ),
    ),
    make(
      service,
      'antiduplicate',
      root('antiduplicate', '重複設定', [
        sub('set', '設定', [
          option('strike_threshold', 'ストライク開始件数', 4, {
            required: true,
            min_value: 2,
            max_value: 20,
          }),
          option('delete_threshold', '削除開始件数', 4, {
            min_value: 2,
            max_value: 20,
          }),
          option('strikes', 'ストライク数', 4, {
            min_value: 1,
            max_value: 100,
          }),
        ]),
        sub('off', '無効化'),
      ]),
      async (i) =>
        result(
          i,
          await service.update(
            i.guildId!,
            i.options.getSubcommand() === 'off'
              ? { duplicateEnabled: false }
              : {
                  duplicateEnabled: true,
                  duplicateStrikeThreshold: i.options.getInteger(
                    'strike_threshold',
                    true,
                  ),
                  duplicateDeleteThreshold:
                    i.options.getInteger('delete_threshold') ?? 2,
                  duplicateStrikes: i.options.getInteger('strikes') ?? 1,
                },
          ),
        ),
    ),
    make(
      service,
      'autodehoist',
      root('autodehoist', '名前の自動修正', [
        sub('set', '設定', [
          option('character', '先頭文字', 3, { required: true, max_length: 8 }),
        ]),
        sub('default', '既定値'),
        sub('off', '無効化'),
      ]),
      async (i) =>
        result(
          i,
          await service.update(i.guildId!, {
            autodehoistCharacter:
              i.options.getSubcommand() === 'off'
                ? null
                : i.options.getSubcommand() === 'default'
                  ? '!'
                  : i.options.getString('character', true),
          }),
        ),
    ),
    make(
      service,
      'ignore',
      root('ignore', 'AutoMod無視設定', [
        sub('role', 'ロール', [
          option('role', 'ロール', 8, { required: true }),
        ]),
        sub('channel', 'チャンネルまたはカテゴリ', [
          option('channel', 'チャンネル', 7, { required: true }),
        ]),
        sub('list', '一覧'),
      ]),
      async (i) => {
        if (i.options.getSubcommand() === 'list')
          return result(i, await service.ignoreList(i.guildId!));
        const kind = i.options.getSubcommand() === 'role' ? 'role' : 'channel';
        const id =
          kind === 'role'
            ? i.options.getRole('role', true).id
            : i.options.getChannel('channel', true).id;
        return result(i, await service.ignore(kind, i.guildId!, id, i.user.id));
      },
    ),
    make(
      service,
      'unignore',
      root('unignore', 'AutoMod無視解除', [
        sub('role', 'ロール', [
          option('role', 'ロール', 8, { required: true }),
        ]),
        sub('channel', 'チャンネル', [
          option('channel', 'チャンネル', 7, { required: true }),
        ]),
      ]),
      async (i) => {
        const kind = i.options.getSubcommand() === 'role' ? 'role' : 'channel';
        const id =
          kind === 'role'
            ? i.options.getRole('role', true).id
            : i.options.getChannel('channel', true).id;
        return result(
          i,
          await service.ignore(kind, i.guildId!, id, i.user.id, true),
        );
      },
    ),
  ];
}
