import type { GeneralManifest } from './contracts.js';
import type { GeneralService } from './service.js';
import type { DiscordGeneralAdapter } from './adapters.js';
import { generalCommands } from './handlers.js';

export const createGeneralManifest = (
  service: GeneralService,
  adapter: DiscordGeneralAdapter,
): GeneralManifest => ({ commands: generalCommands(service, adapter) });
