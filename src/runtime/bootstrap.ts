import type { LifecycleDependencies, LifecycleStep } from '../lifecycle.js';
import { createLifecycle } from '../lifecycle.js';
import type { Logger } from 'pino';
import type { RuntimePorts } from './ports.js';
import type { RuntimeConfig } from './ports.js';
import type { DiscordClientLifecycle } from '../lifecycle.js';

const step = (
  name: string,
  start: (signal: AbortSignal) => Promise<void>,
  stop = (): Promise<void> => Promise.resolve(),
): LifecycleStep => ({ name, start, stop });

/** Maps runtime ports onto the existing lifecycle; no Discord object is created before resources are ready. */
export function createRuntimeLifecycle(
  logger: Logger,
  ports: RuntimePorts,
  config: Pick<RuntimeConfig, 'DISCORD_TOKEN'>,
) {
  const client: { value?: DiscordClientLifecycle } = {};
  return createLifecycle(logger, {
    database: step('database', () => ports.validateDatabase()),
    migrations: step('migrations', () => ports.applyMigrations()),
    resources: step('resources', async () => {
      const resources = await ports.loadResources();
      if (ports.registerCommands)
        await ports.registerCommands(resources.commands);
    }),
    recoverStaleJobs: step('stale job recovery', () =>
      ports.recoverStaleJobs(),
    ),
    scheduler: step(
      'scheduler',
      () => ports.startScheduler(),
      () => ports.stopScheduler(),
    ),
    intake: {
      start: () => ports.startIntake(),
      stopAccepting: () => ports.stopIntake(),
      drain: () => ports.drainIntake(),
    },
    voice: step(
      'voice',
      () => Promise.resolve(),
      () => ports.stopVoice(),
    ),
    prisma: step(
      'prisma',
      () => Promise.resolve(),
      () => ports.disconnectDatabase(),
    ),
    createDiscordClient: async () => {
      const adapter = await ports.createClient();
      client.value = {
        login: (signal) => adapter.login(config.DISCORD_TOKEN, signal),
        destroy: () => adapter.destroy(),
      };
      return client.value;
    },
  } satisfies LifecycleDependencies);
}
