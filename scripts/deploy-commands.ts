import { loadConfig } from '../src/config/env.js';
import { commandManifest, registerCommands } from '../src/runtime/index.js';
import { DiscordRestAdapter } from '../src/adapters/index.js';
import { createBootstrapDependencies } from '../src/index.js';
import { createLogger } from '../src/logging/logger.js';

const config = loadConfig();
const logger = createLogger(config, {
  event: 'command-deploy',
  correlationId: config.INSTANCE_ID,
  interactionId: null,
  guildId: null,
  channelId: null,
  userId: null,
  caseId: null,
  durationMs: null,
  errorName: null,
  discordCode: null,
});
const dependencies = createBootstrapDependencies(config, logger);
const commands = commandManifest(dependencies.commandDefinitions);
try {
  await registerCommands(
    config,
    DiscordRestAdapter.withToken(config.DISCORD_TOKEN),
    commands,
  );
} catch (error) {
  if (
    config.COMMAND_SCOPE === 'guild' &&
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 50001
  ) {
    throw new Error(
      'DEV_GUILD_IDにBotアプリケーションが参加できません。DEV_GUILD_IDを確認し、Botを対象サーバーへ招待してください。',
    );
  }
  throw error;
}
