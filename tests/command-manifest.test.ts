import { describe, expect, it, vi } from 'vitest';
import { createCommandManifest } from '../src/commands/index.js';
import {
  createModerationCommandManifest,
  createModerationUtilityCommands,
} from '../src/commands/moderation/index.js';
import {
  createGeneralManifest,
  GeneralService,
} from '../src/features/general/index.js';
import { commandManifest } from '../src/runtime/commands.js';
import type { CommandDefinition } from '../src/commands/contract.js';

const runtime = {
  botName: 'Pathtex',
  avatarUrl: undefined,
  version: '1.0.0',
  nodeVersion: 'v22',
  discordVersion: '14.x',
  uptimeMs: 0,
  guildCount: 0,
  cachedUserCount: 0,
  clientId: '12345678901234567',
  invitePermissions: '8',
  gatewayPing: 0,
  dbPing: vi.fn(() => Promise.resolve(0)),
};

/**
 * Composes the full production manifest exactly as `src/index.ts` does at
 * startup (general + moderation + every wired feature), using inert service
 * stubs. Registration metadata is static, so stubs are sufficient.
 */
function productionManifest(): readonly CommandDefinition[] {
  const general = createGeneralManifest(
    new GeneralService({ runtime }),
    {} as never,
  ).commands;
  const moderation = [
    ...createModerationCommandManifest({} as never),
    ...createModerationUtilityCommands({} as never),
  ];
  return createCommandManifest(
    { health: () => Promise.resolve(true) },
    moderation,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    general,
  );
}

const CANONICAL_COMMANDS = [
  'about',
  'announce',
  'anticopypasta',
  'antiduplicate',
  'antieveryone',
  'antiinvite',
  'antireferral',
  'audit',
  'autodehoist',
  'autoraidmode',
  'ban',
  'check',
  'clean',
  'dehoist',
  'ignore',
  'invite',
  'inviteprune',
  'kick',
  'lookup',
  'maxlines',
  'maxmentions',
  'messagelog',
  'modlog',
  'modrole',
  'mute',
  'pardon',
  'ping',
  'punishment',
  'raidmode',
  'reason',
  'roleinfo',
  'serverinfo',
  'serverlog',
  'settings',
  'setup',
  'silentban',
  'slowmode',
  'softban',
  'strike',
  'timezone',
  'unban',
  'unignore',
  'unmute',
  'userinfo',
  'voicekick',
  'voicelog',
  'voicemove',
] as const;

describe('production command manifest invariants', () => {
  it('registers exactly the canonical guild command set', () => {
    const commands = productionManifest();
    const names = commands.map((command) => command.name).sort();
    expect(names).toEqual([...CANONICAL_COMMANDS].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it('marks every command guild-only with guild context and integration types', () => {
    for (const command of productionManifest()) {
      expect(command.guildOnly, command.name).toBe(true);
      expect(command.data.type, command.name).toBe(1);
      expect(command.data.name, command.name).toBe(command.name);
      expect(command.data.contexts, command.name).toEqual([0]);
      expect(command.data.integration_types, command.name).toEqual([0]);
      expect(
        (command.data.description as string | undefined)?.trim().length ?? 0,
        command.name,
      ).toBeGreaterThan(0);
    }
  });

  it('produces a runtime manifest without tripping the guild-only invariant', () => {
    const bodies = commandManifest(productionManifest());
    expect(bodies).toHaveLength(CANONICAL_COMMANDS.length);
    for (const body of bodies) {
      expect(body.contexts).toEqual([0]);
      expect(body.integration_types).toEqual([0]);
    }
  });

  it('only exposes autocomplete on the audit and timezone commands', () => {
    const autocomplete = productionManifest()
      .filter((command) => typeof command.autocomplete === 'function')
      .map((command) => command.name)
      .sort();
    expect(autocomplete).toEqual(['audit', 'timezone']);
  });

  it('keeps the fast public commands non-deferred and member lookups public-deferred', () => {
    const commands = productionManifest();
    const deferMode = (name: string) =>
      commands.find((command) => command.name === name)?.deferMode;
    for (const name of ['about', 'invite', 'ping', 'serverinfo'])
      expect(deferMode(name), name).toBe('NONE');
    for (const name of ['roleinfo', 'userinfo'])
      expect(deferMode(name), name).toBe('PUBLIC');
  });

  it('authorizes public read commands publicly and config commands via MANAGE_GUILD', () => {
    const commands = productionManifest();
    const policy = (name: string) =>
      commands.find((command) => command.name === name)?.authorizationPolicy;
    for (const name of [
      'about',
      'invite',
      'ping',
      'roleinfo',
      'serverinfo',
      'userinfo',
    ])
      expect(policy(name), name).toBe('PUBLIC');
    for (const name of [
      'messagelog',
      'modlog',
      'serverlog',
      'voicelog',
      'modrole',
      'settings',
      'setup',
      'timezone',
      'autoraidmode',
    ])
      expect(policy(name), name).toBe('MANAGE_GUILD');
    for (const name of ['ban', 'kick', 'strike', 'voicemove', 'voicekick'])
      expect(policy(name), name).toBe('MODERATOR');
  });

  it('fails closed when two composed commands share a name', () => {
    const stub = (name: string): CommandDefinition => ({
      name,
      guildOnly: true,
      data: {
        name,
        description: name,
        type: 1,
        contexts: [0],
        integration_types: [0],
      },
      requiredBotPermissions: [],
      actorNativePermissions: [],
      authorizationPolicy: 'PUBLIC',
      deferMode: 'NONE',
      execute: () => Promise.resolve(),
    });
    expect(() =>
      createCommandManifest(
        { health: () => Promise.resolve(true) },
        [stub('reason')],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [stub('ping'), stub('reason')],
      ),
    ).toThrow(/duplicate command name\(s\) in manifest: reason/);
  });
});
