import type { CommandDefinition } from './contract.js';
import type { DatabaseHealthPort } from './ping.js';
import type { ConfigurationService } from '../features/configuration/service.js';
import { configurationCommands } from '../features/configuration/commands.js';
import type { StrikeService } from '../features/strikes/strike-service.js';
import { strikesCommands } from '../features/strikes/commands.js';
import type { RaidService } from '../features/raid/service.js';
import { raidCommands } from '../features/raid/commands.js';
import type { AutomodService } from '../features/automod/service.js';
import { automodCommands } from '../features/automod/commands.js';
import type { ToolsService } from '../features/tools/service.js';
import { toolsCommands } from '../features/tools/commands.js';
import type { VoiceService } from '../features/voice/service.js';
import { voiceCommands } from '../features/voice/commands.js';

export function createCommandManifest(
  database: DatabaseHealthPort,
  moderation: readonly CommandDefinition[] = [],
  configuration?: ConfigurationService,
  strikes?: StrikeService,
  raid?: RaidService,
  automod?: AutomodService,
  tools?: ToolsService,
  voice?: VoiceService,
  general: readonly CommandDefinition[] = [],
): readonly CommandDefinition[] {
  void database;
  const all = [
    ...general,
    ...moderation,
    ...(configuration ? configurationCommands(configuration) : []),
    ...(strikes ? strikesCommands(strikes) : []),
    ...(raid ? raidCommands(raid) : []),
    ...(automod ? automodCommands(automod) : []),
    ...(tools ? toolsCommands(tools) : []),
    ...(voice ? voiceCommands(voice) : []),
  ];
  const seen = new Map<string, number>();
  for (const command of all)
    seen.set(command.name, (seen.get(command.name) ?? 0) + 1);
  const duplicates = [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort();
  if (duplicates.length > 0)
    throw new Error(
      `duplicate command name(s) in manifest: ${duplicates.join(', ')}`,
    );
  return all;
}

export { createPingCommand } from './ping.js';
export type { DatabaseHealthPort } from './ping.js';
export type {
  CommandContext,
  CommandDefinition,
  AuthorizationPolicy,
  DeferMode,
} from './contract.js';
