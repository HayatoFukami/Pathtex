import { PermissionFlagsBits } from 'discord.js';
import type { CommandDefinition } from '../../commands/contract.js';
import type { VoiceService } from './service.js';
import { parseVoiceTargets } from './validation.js';
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
    requiredBotPermissions: [],
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
          ? `完了: 成功 ${String(result.value.success.length)} / 失敗 ${String(result.value.failed.length)}\n${result.value.outcomes.map((outcome) => `${outcome.userId}: ${outcome.ok ? `成功${outcome.caseNumber === undefined ? '' : ` Case #${String(outcome.caseNumber)}`}` : (outcome.code ?? '失敗')}`).join('\n')}`
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
    requiredBotPermissions: [],
    actorNativePermissions: [PermissionFlagsBits.MoveMembers],
    authorizationPolicy: 'MODERATOR',
    deferMode: 'EPHEMERAL',
    execute: async ({ interaction }) => {
      const guildId = interaction.guildId;
      if (!guildId) throw new Error('guild required');
      const action = interaction.options.getSubcommand();
      const result =
        action === 'status'
          ? service.status(guildId)
          : action === 'stop'
            ? await service.stop(guildId, interaction.user.id, true)
            : await service.start(
                guildId,
                interaction.user.id,
                interaction.options.getChannel('channel')?.id,
              );
      await interaction.editReply(
        result.ok ? JSON.stringify(result.value) : result.error.message,
      );
    },
  };
  return [command, move];
}
