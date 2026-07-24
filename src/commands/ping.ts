import type { ChatInputCommandInteraction } from 'discord.js';
import type { CommandDefinition } from './contract.js';
import { t } from '../i18n/index.js';

export interface DatabaseHealthPort {
  health(): Promise<boolean>;
  readonly gatewayPing?: () => number;
}

export function createPingCommand(
  database: DatabaseHealthPort,
): CommandDefinition {
  return {
    name: 'ping',
    data: {
      name: 'ping',
      description: t('general:pingCommand.description'),
      type: 1,
      contexts: [0],
      integration_types: [0],
    },
    guildOnly: true,
    requiredBotPermissions: [],
    actorNativePermissions: [],
    authorizationPolicy: 'PUBLIC',
    deferMode: 'NONE',
    execute: async ({
      interaction,
      receivedAt,
    }: {
      interaction: ChatInputCommandInteraction;
      receivedAt: number;
    }) => {
      let databaseOk = false;
      const dbStarted = Date.now();
      try {
        let timer: NodeJS.Timeout | undefined;
        try {
          databaseOk = await Promise.race([
            database.health(),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => {
                resolve(false);
              }, 1_500);
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      } catch {
        databaseOk = false;
      }
      const dbRtt = Date.now() - dbStarted;
      const interactionRtt = Date.now() - receivedAt;
      const gateway = database.gatewayPing?.() ?? -1;
      await interaction.reply({
        content: `${t('general:pingCommand.pong')}\n${t('general:pingCommand.interactionLabel')}: ${String(interactionRtt)}ms\n${t('general:pingCommand.gatewayLabel')}: ${gateway >= 0 ? `${String(gateway)}ms` : t('system:common.unknown')}\n${t('general:pingCommand.databaseLabel')}: ${databaseOk ? t('general:pingCommand.dbHealthy', { ms: String(dbRtt) }) : t('general:pingCommand.dbUnavailable')}`,
      });
    },
  };
}
