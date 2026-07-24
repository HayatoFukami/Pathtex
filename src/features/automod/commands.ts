import {
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type { CommandDefinition } from '../../commands/contract.js';
import { AutomodService } from './service.js';
import { t } from '../../i18n/index.js';

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
  const none = t('automod:ignoreResult.none');
  const content =
    value &&
    typeof value === 'object' &&
    'ok' in value &&
    (value as { ok: boolean }).ok &&
    'value' in value &&
    (value as { value?: unknown }).value &&
    typeof (value as { value: unknown }).value === 'object' &&
    'automaticIgnoreContinues' in (value as { value: object }).value
      ? t('automod:ignoreResult.autoContinues')
      : value &&
          typeof value === 'object' &&
          'roles' in value &&
          'channels' in value
        ? t('automod:ignoreResult.list', {
            roles:
              (value as { roles: readonly { roleId: string }[] }).roles
                .map((item) => item.roleId)
                .join(', ') || none,
            channels:
              (value as { channels: readonly { channelId: string }[] }).channels
                .map((item) => item.channelId)
                .join(', ') || none,
            hierarchyRoles:
              (
                (value as { hierarchyRoles?: readonly string[] })
                  .hierarchyRoles ?? []
              ).join(', ') || none,
            strongPermissionRoles:
              (
                (value as { strongPermissionRoles?: readonly string[] })
                  .strongPermissionRoles ?? []
              ).join(', ') || none,
            resourceWarnings:
              (
                (value as { resourceWarnings?: readonly string[] })
                  .resourceWarnings ?? []
              ).join(', ') || none,
          })
        : value &&
            typeof value === 'object' &&
            'ok' in value &&
            !(value as { ok: boolean }).ok
          ? t('automod:result.updateFailed', {
              message: (value as unknown as { error: { message: string } })
                .error.message,
            })
          : value &&
              typeof value === 'object' &&
              'ok' in value &&
              (value as { ok: boolean }).ok &&
              'value' in value &&
              (value as { value?: unknown }).value &&
              typeof (value as { value: unknown }).value === 'object' &&
              'warning' in (value as { value: object }).value
            ? t('automod:result.updatedWithWarning', {
                warning: (value as { value: { warning: string } }).value
                  .warning,
              })
            : t('automod:result.updated');
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
      root(name, t('automod:commands.fixedDescription', { name }), [
        sub('set', t('automod:commands.labels.enable'), [
          option('strikes', t('automod:commands.labels.strikeCount'), 4, {
            required: true,
            min_value: 1,
            max_value: 100,
          }),
        ]),
        sub('off', t('automod:commands.labels.disable')),
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
      root('maxmentions', t('automod:commands.maxmentions.description'), [
        group('user', t('automod:commands.maxmentions.user'), [
          sub('set', t('automod:commands.labels.configure'), [
            option('maximum', t('automod:commands.labels.maximum'), 4, {
              required: true,
              min_value: 1,
              max_value: 100,
            }),
          ]),
          sub('off', t('automod:commands.labels.disable')),
        ]),
        group('role', t('automod:commands.maxmentions.role'), [
          sub('set', t('automod:commands.labels.configure'), [
            option('maximum', t('automod:commands.labels.maximum'), 4, {
              required: true,
              min_value: 1,
              max_value: 100,
            }),
          ]),
          sub('off', t('automod:commands.labels.disable')),
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
      root('maxlines', t('automod:commands.maxlines.description'), [
        sub('set', t('automod:commands.labels.configure'), [
          option('maximum', t('automod:commands.labels.maxLines'), 4, {
            required: true,
            min_value: 1,
            max_value: 500,
          }),
        ]),
        sub('off', t('automod:commands.labels.disable')),
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
      root('antiduplicate', t('automod:commands.antiduplicate.description'), [
        sub('set', t('automod:commands.labels.configure'), [
          option(
            'strike_threshold',
            t('automod:commands.labels.strikeThresholdCount'),
            4,
            {
              required: true,
              min_value: 2,
              max_value: 20,
            },
          ),
          option(
            'delete_threshold',
            t('automod:commands.labels.deleteThresholdCount'),
            4,
            {
              min_value: 2,
              max_value: 20,
            },
          ),
          option('strikes', t('automod:commands.labels.strikeCount'), 4, {
            min_value: 1,
            max_value: 100,
          }),
        ]),
        sub('off', t('automod:commands.labels.disable')),
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
      root('autodehoist', t('automod:commands.autodehoist.description'), [
        sub('set', t('automod:commands.labels.configure'), [
          option(
            'character',
            t('automod:commands.labels.leadingCharacter'),
            3,
            { required: true, max_length: 8 },
          ),
        ]),
        sub('default', t('automod:commands.labels.defaultValue')),
        sub('off', t('automod:commands.labels.disable')),
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
      root('ignore', t('automod:commands.ignore.description'), [
        sub('role', t('automod:commands.labels.role'), [
          option('role', t('automod:commands.labels.role'), 8, {
            required: true,
          }),
        ]),
        sub('channel', t('automod:commands.ignore.channel'), [
          option('channel', t('automod:commands.labels.channel'), 7, {
            required: true,
          }),
        ]),
        sub('list', t('automod:commands.labels.list')),
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
      root('unignore', t('automod:commands.unignore.description'), [
        sub('role', t('automod:commands.labels.role'), [
          option('role', t('automod:commands.labels.role'), 8, {
            required: true,
          }),
        ]),
        sub('channel', t('automod:commands.labels.channel'), [
          option('channel', t('automod:commands.labels.channel'), 7, {
            required: true,
          }),
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
