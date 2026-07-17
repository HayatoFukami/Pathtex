import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import type { RuntimeConfig } from './ports.js';
import type { CommandDefinition } from '../commands/contract.js';

export function commandManifest(
  commands: readonly CommandDefinition[],
): readonly RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  if (commands.some((command) => !(command.guildOnly as boolean)))
    throw new Error('all commands must be guild-only');
  const names = commands.map((command) => command.name);
  if (new Set(names).size !== names.length)
    throw new Error('duplicate command name');
  return commands.map((command) => {
    const data = command.data;
    if (
      data.type !== 1 ||
      data.name !== command.name ||
      data.contexts?.toString() !== [0].toString() ||
      data.integration_types?.toString() !== [0].toString()
    )
      throw new Error(`invalid guild-only manifest for ${command.name}`);
    return data as unknown as RESTPostAPIChatInputApplicationCommandsJSONBody;
  });
}

export async function registerCommands(
  config: RuntimeConfig,
  rest: {
    putGlobal(
      applicationId: string,
      commands: readonly RESTPostAPIChatInputApplicationCommandsJSONBody[],
    ): Promise<void>;
    putGuild(
      applicationId: string,
      guildId: string,
      commands: readonly RESTPostAPIChatInputApplicationCommandsJSONBody[],
    ): Promise<void>;
  },
  commands: readonly RESTPostAPIChatInputApplicationCommandsJSONBody[],
): Promise<void> {
  if (config.COMMAND_SCOPE === 'global')
    return rest.putGlobal(config.DISCORD_CLIENT_ID, commands);
  if (config.DEV_GUILD_ID === undefined)
    throw new Error('DEV_GUILD_ID is required for guild command registration');
  return rest.putGuild(config.DISCORD_CLIENT_ID, config.DEV_GUILD_ID, commands);
}
