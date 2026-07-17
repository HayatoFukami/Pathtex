import {
  REST,
  Routes,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { DiscordRestPort } from '../runtime/ports.js';

export class DiscordRestAdapter implements DiscordRestPort {
  public constructor(private readonly rest: REST) {}

  public static withToken(token: string): DiscordRestAdapter {
    return new DiscordRestAdapter(new REST({ version: '10' }).setToken(token));
  }

  public async putGlobal(
    applicationId: string,
    commands: readonly RESTPostAPIChatInputApplicationCommandsJSONBody[],
  ): Promise<void> {
    await this.rest.put(Routes.applicationCommands(applicationId), {
      body: [...commands],
    });
  }

  public async putGuild(
    applicationId: string,
    guildId: string,
    commands: readonly RESTPostAPIChatInputApplicationCommandsJSONBody[],
  ): Promise<void> {
    await this.rest.put(
      Routes.applicationGuildCommands(applicationId, guildId),
      { body: [...commands] },
    );
  }
}
