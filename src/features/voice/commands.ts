import { PermissionFlagsBits } from 'discord.js';
import type { CommandDefinition } from '../../commands/contract.js';
import type { VoiceService } from './service.js';
import type { VoiceSession } from './contracts.js';
import { parseVoiceTargets } from './validation.js';
import {
  fallbackTargetIdentity,
  formatTargetIdentity,
} from '../../services/target-identity.js';
/** Discord timestamp markdown seconds; renders in each viewer's timezone. */
const epoch = (date: Date): number => Math.floor(date.getTime() / 1000);
const renderVoiceStatus = (session: VoiceSession | null): string => {
  if (!session) return 'VoiceMoveセッションはありません。';
  return [
    'VoiceMoveセッション中',
    `開始者: <@${session.controllerUserId}>`,
    `Bot現在VC: <#${session.botCurrentChannelId}>`,
    `開始日時: <t:${String(epoch(session.startedAt))}:F>`,
    `期限: <t:${String(epoch(session.expiresAt))}:R>`,
  ].join('\n');
};
const renderVoiceStart = (session: VoiceSession): string =>
  `VoiceMoveを開始しました。Botが <#${session.botCurrentChannelId}> に接続しました。\n期限: <t:${String(epoch(session.expiresAt))}:R>`;
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
): readonly CommandDefinition[] {
  const command: CommandDefinition = {
    name: 'voicekick',
    data: data('voicekick', 'ボイスから切断', [
      { name: 'target', description: '対象', type: 6 },
      {
        name: 'additional_targets',
        description: '追加対象ID',
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
          ? `完了: 成功 ${String(result.value.success.length)} / 失敗 ${String(result.value.failed.length)}\n${result.value.outcomes.map((outcome) => `${formatTargetIdentity(outcome.identity ?? fallbackTargetIdentity(outcome.userId))}: ${outcome.ok ? `成功${outcome.caseNumber === undefined ? '' : ` Case #${String(outcome.caseNumber)}`}` : (outcome.code ?? '失敗')}`).join('\n')}`
          : result.error.message,
      );
    },
  };
  const move: CommandDefinition = {
    name: 'voicemove',
    data: data('voicemove', 'VoiceMoveセッション', [
      {
        name: 'start',
        description: '開始',
        type: 1,
        options: [
          {
            name: 'channel',
            description: '接続先',
            type: 7,
            channel_types: [2],
          },
        ],
      },
      { name: 'stop', description: '停止', type: 1 },
      { name: 'status', description: '状態', type: 1 },
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
          result.ok
            ? 'VoiceMoveセッションを終了しました。'
            : result.error.message,
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
