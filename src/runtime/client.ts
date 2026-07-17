import { Client, GatewayIntentBits, Events } from 'discord.js';

export const REQUIRED_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildInvites,
] as const;

export function createDiscordClient(
  onFatal: (error: Error) => void = () => undefined,
): Client {
  const client = new Client({ intents: [...REQUIRED_INTENTS] });
  client.on(Events.ShardError, (error) => {
    if ((error as Error & { code?: number }).code === 4014) onFatal(error);
  });
  client.on(Events.ShardDisconnect, (event) => {
    if (event.code === 4014)
      onFatal(
        Object.assign(
          new Error('Discord Gateway closed with fatal code 4014'),
          { code: 4014 },
        ),
      );
  });
  return client;
}
