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
await registerCommands(
  config,
  DiscordRestAdapter.withToken(config.DISCORD_TOKEN),
  commands,
);
