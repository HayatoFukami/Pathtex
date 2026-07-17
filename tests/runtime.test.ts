import { describe, expect, it, vi } from 'vitest';
import {
  commandManifest,
  registerCommands,
  InteractionDedupe,
} from '../src/runtime/index.js';

const command = (name: string, guildOnly = true) => ({
  name,
  guildOnly: guildOnly as true,
  data: {
    name,
    description: name,
    type: 1,
    contexts: [0],
    integration_types: [0],
  },
  requiredBotPermissions: [],
  actorNativePermissions: [],
  authorizationPolicy: 'PUBLIC' as const,
  deferMode: 'NONE' as const,
  execute: () => Promise.resolve(),
});

describe('runtime walking skeleton', () => {
  it('produces only guild command manifests', () => {
    expect(commandManifest([command('ping')])).toEqual([
      {
        name: 'ping',
        description: 'ping',
        type: 1,
        contexts: [0],
        integration_types: [0],
      },
    ]);
  });

  it('uses the configured global or development guild scope', async () => {
    const rest = {
      putGlobal: vi.fn(() => Promise.resolve()),
      putGuild: vi.fn(() => Promise.resolve()),
    };
    await registerCommands(
      {
        DISCORD_CLIENT_ID: '12345678901234567',
        COMMAND_SCOPE: 'global',
        DISCORD_TOKEN: 'x',
      },
      rest,
      [],
    );
    await registerCommands(
      {
        DISCORD_CLIENT_ID: '12345678901234567',
        COMMAND_SCOPE: 'guild',
        DEV_GUILD_ID: '12345678901234567',
        DISCORD_TOKEN: 'x',
      },
      rest,
      [],
    );
    expect(rest.putGlobal).toHaveBeenCalledOnce();
    expect(rest.putGuild).toHaveBeenCalledOnce();
  });

  it('deduplicates interaction IDs for five minutes', () => {
    let now = 0;
    const cache = new InteractionDedupe(300_000, () => now);
    expect(cache.accept('i')).toBe(true);
    expect(cache.accept('i')).toBe(false);
    now = 300_000;
    expect(cache.accept('i')).toBe(true);
  });
});
