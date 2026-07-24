import { PermissionFlagsBits } from 'discord.js';
import type { CommandDefinition } from '../../commands/contract.js';
import type { VoiceService } from './service.js';
import type { VoiceSession } from './contracts.js';
import { parseVoiceTargets } from './validation.js';
import { DEFAULT_BULK_TARGET_LIMIT } from '../../domain/parsers.js';
import {
  fallbackTargetIdentity,
  formatTargetIdentity,
} from '../../services/target-identity.js';
import { t } from '../../i18n/index.js';
/** Discord timestamp markdown seconds; renders in each viewer's timezone. */
const epoch = (date: Date): number => Math.floor(date.getTime() / 1000);
const renderVoiceStatus = (session: VoiceSession | null): string => {
  if (!session) return t('voice:status.none');
  return [
    t('voice:status.active'),
    t('voice:status.controller', { userId: session.controllerUserId }),
    t('voice:status.currentChannel', {
      channelId: session.botCurrentChannelId,
    }),
    t('voice:status.startedAt', { epoch: epoch(session.startedAt) }),
    t('voice:status.expiresAt', { epoch: epoch(session.expiresAt) }),
  ].join('\n');
};
const renderVoiceStart = (session: VoiceSession): string =>
  t('voice:start.confirmation', {
    channelId: session.botCurrentChannelId,
    epoch: epoch(session.expiresAt),
  });
const data = (
  name: string,
  description: string,
  options: readonly Record<string, unknown>[],
): Record<string, unknown> => ({
  name,
  description,
  type: 1,
  options,
  contexts: [0],
  integration_types: [0],
});
export function voiceCommands(
  service: VoiceService,
  maxBulkTargets: number = DEFAULT_BULK_TARGET_LIMIT,
): readonly CommandDefinition[] {
  const command: CommandDefinition = {
    name: 'voicekick',
    data: data('voicekick', t('voice:commands.voicekick.description'), [
      {
        name: 'target',
        description: t('voice:commands.voicekick.options.target'),
        type: 6,
      },
      {
        name: 'additional_targets',
        description: t('voice:commands.voicekick.options.additionalTargets'),
        type: 3,
        max_length: 400,
      },
    ]),
    guildOnly: true,
    // Spec §5.3.15: VoiceKick creates a temporary channel and moves members, so
    // the bot needs Move Members, Manage Channels, and View Channel. VoiceKick is
    // a single-action command, so a static preflight set is correct.
    requiredBotPermissions: [
      PermissionFlagsBits.MoveMembers,
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ViewChannel,
    ],
    actorNativePermissions: [PermissionFlagsBits.MoveMembers],
    authorizationPolicy: 'MODERATOR',
    deferMode: 'EPHEMERAL',
    execute: async ({ interaction }) => {
      const guildId = interaction.guildId;
      if (!guildId) throw new Error('guild required');
      const parsed = parseVoiceTargets(
        interaction.options.getUser('target')?.id,
        interaction.options.getString('additional_targets'),
        maxBulkTargets,
      );
      if (!parsed.ok) {
        await interaction.editReply(parsed.error.message);
        return;
      }
      const result = await service.voiceKickTargets(
        guildId,
        interaction.user.id,
        parsed.value,
      );
      await interaction.editReply(
        result.ok
          ? t('voice:kick.summary', {
              success: result.value.success.length,
              failed: result.value.failed.length,
              outcomes: result.value.outcomes
                .map(
                  (outcome) =>
                    `${formatTargetIdentity(outcome.identity ?? fallbackTargetIdentity(outcome.userId))}: ${
                      outcome.ok
                        ? t('voice:kick.outcomeSuccess', {
                            caseSuffix:
                              outcome.caseNumber === undefined
                                ? ''
                                : t('voice:kick.caseSuffix', {
                                    caseNumber: outcome.caseNumber,
                                  }),
                          })
                        : (outcome.code ?? t('voice:kick.outcomeFailure'))
                    }`,
                )
                .join('\n'),
            })
          : result.error.message,
      );
    },
  };
  const move: CommandDefinition = {
    name: 'voicemove',
    data: data('voicemove', t('voice:commands.voicemove.description'), [
      {
        name: 'start',
        description: t('voice:commands.voicemove.start.description'),
        type: 1,
        options: [
          {
            name: 'channel',
            description: t('voice:commands.voicemove.start.options.channel'),
            type: 7,
            channel_types: [2],
          },
        ],
      },
      {
        name: 'stop',
        description: t('voice:commands.voicemove.stop.description'),
        type: 1,
      },
      {
        name: 'status',
        description: t('voice:commands.voicemove.status.description'),
        type: 1,
      },
    ]),
    guildOnly: true,
    // Spec §5.3.16: only `start` needs Connect/Move Members/View Channel, while
    // `stop`/`status` do not. A static preflight set cannot vary per subcommand,
    // so registration stays empty and `start` validates Connect/Move Members/View
    // Channel inside the service (canViewChannel/canMoveToChannel), mirroring the
    // RaidMode subcommand design.
    requiredBotPermissions: [],
    actorNativePermissions: [PermissionFlagsBits.MoveMembers],
    authorizationPolicy: 'MODERATOR',
    deferMode: 'EPHEMERAL',
    execute: async ({ interaction }) => {
      const guildId = interaction.guildId;
      if (!guildId) throw new Error('guild required');
      const action = interaction.options.getSubcommand();
      if (action === 'status') {
        const result = service.status(guildId);
        await interaction.editReply(
          result.ok ? renderVoiceStatus(result.value) : result.error.message,
        );
        return;
      }
      if (action === 'stop') {
        const result = await service.stop(guildId, interaction.user.id, true);
        await interaction.editReply(
          result.ok ? t('voice:stop.confirmation') : result.error.message,
        );
        return;
      }
      const result = await service.start(
        guildId,
        interaction.user.id,
        interaction.options.getChannel('channel')?.id,
      );
      await interaction.editReply(
        result.ok ? renderVoiceStart(result.value) : result.error.message,
      );
    },
  };
  return [command, move];
}
