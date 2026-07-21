import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Routes } from 'discord.js';
import type { AppConfig } from '../src/config/env.js';
import {
  buildPreviewInventory,
  type PreviewEntry,
  validateChannelData,
  sanitizeErrorMessage,
  parseArgs,
  main,
  type RuntimeDeps,
  type ChannelConfig,
  sendPreviews,
} from '../scripts/log-preview.js';

const PREVIEW_LABEL = 'Pathtex UI Preview';
const PREVIEW_FOOTER = 'Pathtex UI Preview — dummy data, not a real event';
const DEV_GUILD = '123456789012345678';

// ---- minimal config stub ----
function stubConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    DISCORD_TOKEN: 'stub-token',
    DISCORD_CLIENT_ID: '111111111111111111',
    DATABASE_URL: 'postgresql://u:p@localhost/db',
    COMMAND_SCOPE: 'guild',
    DEV_GUILD_ID: DEV_GUILD,
    BOT_VERSION: '0.1.0',
    LOG_LEVEL: 'silent',
    MESSAGE_RETENTION_DAYS: 7,
    MAX_BULK_TARGETS: 20,
    OWNER_USER_IDS: undefined,
    INSTANCE_ID: 'test',
    ...overrides,
  };
}

// ---------------------------------------------------------------
// Required inventory labels
// ---------------------------------------------------------------
const REQUIRED_LABELS = new Set([
  'MessageEdit',
  'MessageDelete',
  'BulkDelete',
  'Case-KICK-writeCase',
  'Case-BAN-writeCase',
  'Case-MUTE-writeCase',
  'Case-UNBAN-writeCase',
  'Case-SOFTBAN-writeCase',
  'Case-UNMUTE-writeCase',
  'Case-EXTERNAL-BAN-writeCase',
  'Case-EXTERNAL-KICK-writeCase',
  'Case-FAILED-writeCase',
  'Action-KICK',
  'Action-BAN',
  'VoiceKick-Success',
  'VoiceKick-Failure',
  'MemberJoin',
  'MemberLeave',
  'MemberNameUpdate',
  'UserUpdate',
  'ChannelCreate',
  'ChannelUpdate',
  'RoleAdd',
  'RoleRemove',
  'BanEvent',
  'UnbanEvent',
  'VoiceJoin',
  'VoiceLeave',
  'VoiceMove',
]);

describe('inventory', () => {
  let inventory: PreviewEntry[];
  beforeAll(() => {
    inventory = buildPreviewInventory();
  });

  it('no duplicates', () => {
    expect(new Set(inventory.map((e) => e.label)).size).toBe(inventory.length);
  });
  it('covers all required labels', () => {
    const have = new Set(inventory.map((e) => e.label));
    for (const l of REQUIRED_LABELS) expect(have.has(l), l).toBe(true);
  });
  it('no unexpected labels', () => {
    for (const e of inventory)
      expect(REQUIRED_LABELS.has(e.label), e.label).toBe(true);
  });
  it('valid kinds', () => {
    for (const e of inventory) {
      expect(['message', 'moderation', 'server', 'voice']).toContain(e.kind);
    }
  });
  it('at least one embed', () => {
    for (const e of inventory) expect(e.embeds.length).toBeGreaterThan(0);
  });

  describe('safety', () => {
    function all() {
      return inventory.flatMap((e) => e.embeds);
    }
    it('preview label in title', () => {
      for (const em of all()) expect(em.title).toContain(PREVIEW_LABEL);
    });
    it('preview footer', () => {
      for (const em of all()) expect(em.footer?.text).toBe(PREVIEW_FOOTER);
    });
    it('preview colour', () => {
      for (const em of all()) expect(em.color).toBe(0xf39c12);
    });
    it('no secrets', () => {
      for (const em of all()) {
        const s = JSON.stringify(em);
        expect(s).not.toMatch(/(?:discord_token|token)\s*[:=]\s*\S{20,}/iu);
      }
    });
    it('field limits', () => {
      for (const em of all()) {
        expect(em.title?.length ?? 0).toBeLessThanOrEqual(256);
        for (const f of em.fields ?? []) {
          expect(f.name.length).toBeLessThanOrEqual(256);
          expect(f.value.length).toBeLessThanOrEqual(1024);
        }
        expect((em.fields ?? []).length).toBeLessThanOrEqual(25);
      }
    });
    it('valid timestamps', () => {
      for (const em of all()) {
        const ts: string | undefined = em.timestamp;
        if (ts !== undefined) expect(() => new Date(ts)).not.toThrow();
      }
    });
  });

  describe('dummy IDs', () => {
    const DUMMY = new Set([
      '111111111111111111',
      '222222222222222222',
      '222222222222222223',
      '333333333333333333',
      '444444444444444444',
      '555555555555555555',
      '555555555555555501',
      '555555555555555502',
      '666666666666666666',
    ]);
    it('only dummy IDs', () => {
      const re = /\b(\d{17,20})\b/g;
      for (const e of inventory) {
        for (const m of JSON.stringify(e.embeds).matchAll(re)) {
          if (m[1]) expect(DUMMY.has(m[1]), `${m[1]} in ${e.label}`).toBe(true);
        }
      }
    });
  });

  describe('layout fidelity', () => {
    it('writeCase has no Discord timestamp field', () => {
      for (const e of inventory) {
        if (!e.label.startsWith('Case-')) continue;
        for (const em of e.embeds) {
          // Production writeCase embeds have no top-level timestamp.
          expect(em.timestamp).toBeUndefined();
          // But they DO have a "Timestamp" field.
          const names = (em.fields ?? []).map((f) => f.name);
          expect(names).toContain('Timestamp');
        }
      }
    });
    it('writeCase DM field uses String(dmDelivered) semantics', () => {
      for (const e of inventory) {
        if (!e.label.startsWith('Case-')) continue;
        for (const em of e.embeds) {
          const dm = (em.fields ?? []).find((f) => f.name === 'DM');
          expect(dm).toBeDefined();
          // Must be "true", "false", or "対象外" — never "成功".
          expect(['true', 'false', '対象外']).toContain(dm?.value);
          expect(dm?.value).not.toBe('成功');
        }
      }
    });
    it('writeCase has standard fields', () => {
      for (const e of inventory) {
        if (!e.label.startsWith('Case-')) continue;
        for (const em of e.embeds) {
          const names = (em.fields ?? []).map((f) => f.name);
          for (const n of [
            'Action',
            'Source',
            'Status',
            'Target',
            'Reason',
            'Duration',
            'Moderator',
            'Timestamp',
            'DM',
          ]) {
            expect(names, `${e.label} missing ${n}`).toContain(n);
          }
          expect(em.title).toMatch(/ケース #\d+: /u);
          expect(em.description).toContain('発生時刻');
        }
      }
    });
    it('writeAction compact', () => {
      for (const e of inventory) {
        if (!e.label.startsWith('Action-')) continue;
        for (const em of e.embeds) {
          expect((em.fields ?? []).map((f) => f.name)).toEqual([
            'Target',
            'Reason',
          ]);
          expect(em.title).not.toMatch(/ケース/u);
        }
      }
    });
    it('VoiceKick layout', () => {
      for (const e of inventory) {
        if (!e.label.startsWith('VoiceKick-')) continue;
        for (const em of e.embeds) {
          expect(em.title).toContain('VoiceKick');
          expect(em.description).toContain('対象:');
          expect(em.description).toContain('結果:');
        }
      }
    });
    it('role no-duplicate-id', () => {
      for (const e of inventory) {
        if (e.label !== 'RoleAdd' && e.label !== 'RoleRemove') continue;
        for (const em of e.embeds) {
          const uf = (em.fields ?? []).find((f) => f.name === 'User');
          expect(uf).toBeDefined();
          if (uf)
            expect((uf.value.match(/333333333333333333/g) ?? []).length).toBe(
              1,
            );
        }
      }
    });
    it('MemberLeave no 判定', () => {
      for (const e of inventory) {
        if (e.label !== 'MemberLeave') continue;
        for (const em of e.embeds) {
          expect((em.fields ?? []).map((f) => f.name)).not.toContain('判定');
        }
      }
    });
    it('UserUpdate present', () => {
      expect(inventory.map((e) => e.label)).toContain('UserUpdate');
    });
  });
});

// ---------------------------------------------------------------
// Channel validation — fail-closed
// ---------------------------------------------------------------
describe('validateChannelData', () => {
  const G = '123456789012345678';
  it('rejects null', () => {
    expect(validateChannelData(null, G).valid).toBe(false);
  });
  it('rejects cross-guild', () => {
    expect(
      validateChannelData({ id: '1', guild_id: 'X', type: 0 }, G).valid,
    ).toBe(false);
  });
  it('rejects missing type (fail-closed)', () => {
    expect(validateChannelData({ id: '1', guild_id: G }, G).valid).toBe(false);
  });
  it('rejects voice type 2', () => {
    expect(
      validateChannelData({ id: '1', guild_id: G, type: 2 }, G).valid,
    ).toBe(false);
  });
  it('rejects category type 4', () => {
    expect(
      validateChannelData({ id: '1', guild_id: G, type: 4 }, G).valid,
    ).toBe(false);
  });
  it('accepts GuildText 0', () => {
    expect(
      validateChannelData({ id: '1', guild_id: G, type: 0 }, G).valid,
    ).toBe(true);
  });
  it('accepts GuildAnnouncement 5', () => {
    expect(
      validateChannelData({ id: '1', guild_id: G, type: 5 }, G).valid,
    ).toBe(true);
  });
  it('rejects unknown type 99', () => {
    expect(
      validateChannelData({ id: '1', guild_id: G, type: 99 }, G).valid,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------
// Error sanitisation
// ---------------------------------------------------------------
describe('sanitizeErrorMessage', () => {
  it('redacts token colon', () => {
    expect(sanitizeErrorMessage('discord_token: abc123')).not.toContain(
      'abc123',
    );
  });
  it('redacts token equals', () => {
    expect(sanitizeErrorMessage('token=secret')).not.toContain('secret');
  });
  it('truncates 500', () => {
    expect(sanitizeErrorMessage('x'.repeat(600)).length).toBeLessThanOrEqual(
      500,
    );
  });
  it('preserves safe text', () => {
    expect(sanitizeErrorMessage('Channel 123 (code=10003)')).toContain(
      'Channel 123',
    );
  });
});

// ---------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------
describe('parseArgs', () => {
  it('empty → no flags', () => {
    expect(parseArgs([])).toEqual({
      confirm: false,
      dryRun: false,
      help: false,
    });
  });
  it('--confirm', () => {
    expect(parseArgs(['--confirm']).confirm).toBe(true);
  });
  it('--yes', () => {
    expect(parseArgs(['--yes']).confirm).toBe(true);
  });
  it('--dry-run', () => {
    expect(parseArgs(['--dry-run']).dryRun).toBe(true);
  });
  it('--help', () => {
    expect(parseArgs(['--help']).help).toBe(true);
  });
  it('combined', () => {
    const a = parseArgs(['--confirm', '--dry-run']);
    expect(a.confirm).toBe(true);
    expect(a.dryRun).toBe(true);
  });
});

// ---------------------------------------------------------------
// Behavioral safety tests — full runtime boundary
// ---------------------------------------------------------------
describe('main behavioral safety', () => {
  // --- no-confirm: zero DB / REST init ---
  it('no --confirm → does not call loadConfig / createPrisma / createRest', async () => {
    let loadCalled = false,
      prismaCalled = false,
      restCalled = false;
    const deps: RuntimeDeps = {
      loadConfig: () => {
        loadCalled = true;
        return stubConfig();
      },
      createPrisma: () => {
        prismaCalled = true;
        return {} as never;
      },
      createRest: () => {
        restCalled = true;
        return {} as never;
      },
    };
    const code = await main(deps, {
      confirm: false,
      dryRun: false,
      help: false,
    });
    expect(code).toBe(1);
    expect(loadCalled).toBe(false);
    expect(prismaCalled).toBe(false);
    expect(restCalled).toBe(false);
  });

  it('--help → returns 0, no heavy init', async () => {
    let loadCalled = false,
      restCalled = false;
    const deps: RuntimeDeps = {
      loadConfig: () => {
        loadCalled = true;
        return stubConfig();
      },
      createRest: () => {
        restCalled = true;
        return {} as never;
      },
    };
    const code = await main(deps, {
      confirm: false,
      dryRun: false,
      help: true,
    });
    expect(code).toBe(0);
    expect(loadCalled).toBe(false);
    expect(restCalled).toBe(false);
  });

  // --- no DEV_GUILD_ID ---
  it('no DEV_GUILD_ID → exits 1', async () => {
    const deps: RuntimeDeps = {
      loadConfig: () => stubConfig({ DEV_GUILD_ID: undefined }),
      createRest: () => ({ get: vi.fn(), post: vi.fn() }),
    };
    const code = await main(deps, {
      confirm: true,
      dryRun: false,
      help: false,
    });
    expect(code).toBe(1);
  });

  // --- dry-run: zero POSTs ---
  it('dry-run → zero REST POST calls', async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn().mockResolvedValue({
      id: '111111111111111111',
      guild_id: DEV_GUILD,
      type: 0,
    });
    const rest = { get, post };
    const logs: string[] = [];
    const deps: RuntimeDeps = {
      loadConfig: () => stubConfig(),
      createPrisma: () =>
        ({
          guildSettings: {
            findUnique: vi.fn().mockResolvedValue({
              messageLogChannelId: '111111111111111111',
              modlogChannelId: null,
              serverLogChannelId: null,
              voiceLogChannelId: null,
            }),
          },
          $disconnect: vi.fn().mockResolvedValue(undefined),
        }) as never,
      createRest: () => rest,
      log: (m) => logs.push(m),
      logErr: (m) => logs.push(m),
    };
    const code = await main(deps, { confirm: true, dryRun: true, help: false });
    expect(code).toBe(0);
    // REST.get was called (channel validation), but REST.post was never called.
    expect(get).toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    // Must report planned but sent=0.
    const summary = logs
      .filter((l) => l.includes('Planned') || l.includes('Sent'))
      .join(' ');
    expect(summary).toContain('Planned');
    expect(summary).toContain('Sent: 0');
  });

  it("dry-run reports planned>0 sent=0 (not false 'Sent:N')", async () => {
    const post = vi.fn();
    const get = vi.fn().mockResolvedValue({
      id: '111111111111111111',
      guild_id: DEV_GUILD,
      type: 0,
    });
    const logs: string[] = [];
    const deps: RuntimeDeps = {
      loadConfig: () => stubConfig(),
      createPrisma: () =>
        ({
          guildSettings: {
            findUnique: vi.fn().mockResolvedValue({
              messageLogChannelId: '111111111111111111',
              modlogChannelId: null,
              serverLogChannelId: null,
              voiceLogChannelId: null,
            }),
          },
          $disconnect: vi.fn().mockResolvedValue(undefined),
        }) as never,
      createRest: () => ({ get, post }),
      log: (m) => logs.push(m),
      logErr: (m) => logs.push(m),
    };
    await main(deps, { confirm: true, dryRun: true, help: false });
    expect(post).not.toHaveBeenCalled();
    const summary = logs.join('\n');
    // Must NOT have "Sent:" with a non-zero number nor a bare "Sent:N" separate from "Sent: 0".
    expect(summary).not.toMatch(/Sent: (?!0\b)\d+/);
    expect(summary).toContain('Sent: 0');
    expect(summary).toContain('Planned:');
  });

  // --- live sends with valid channels ---
  it('live → REST.post called for configured channels', async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn().mockResolvedValue({
      id: '111111111111111111',
      guild_id: DEV_GUILD,
      type: 0,
    });
    const logs: string[] = [];
    const deps: RuntimeDeps = {
      loadConfig: () => stubConfig(),
      createPrisma: () =>
        ({
          guildSettings: {
            findUnique: vi.fn().mockResolvedValue({
              messageLogChannelId: '111111111111111111',
              modlogChannelId: null,
              serverLogChannelId: null,
              voiceLogChannelId: null,
            }),
          },
          $disconnect: vi.fn().mockResolvedValue(undefined),
        }) as never,
      createRest: () => ({ get, post }),
      log: (m) => logs.push(m),
      logErr: (m) => logs.push(m),
    };
    const code = await main(deps, {
      confirm: true,
      dryRun: false,
      help: false,
    });
    expect(code).toBe(0);
    expect(post).toHaveBeenCalled();
    // Sent should be > 0
    const sentLine = logs.find((l) => l.startsWith('Sent:'));
    expect(sentLine).toBeDefined();
    expect(sentLine).toMatch(/Sent: \d+/);
  });

  // --- cross-guild channel rejected before any POST ---
  it('cross-guild channel → validated and rejected, zero POST', async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    // Channel API returns guild_id = OTHER guild.
    const get = vi.fn().mockResolvedValue({
      id: '111111111111111111',
      guild_id: '999999999999999999',
      type: 0,
    });
    const logs: string[] = [];
    const deps: RuntimeDeps = {
      loadConfig: () => stubConfig(),
      createPrisma: () =>
        ({
          guildSettings: {
            findUnique: vi.fn().mockResolvedValue({
              messageLogChannelId: '111111111111111111',
              modlogChannelId: null,
              serverLogChannelId: null,
              voiceLogChannelId: null,
            }),
          },
          $disconnect: vi.fn().mockResolvedValue(undefined),
        }) as never,
      createRest: () => ({ get, post }),
      log: (m) => logs.push(m),
      logErr: (m) => logs.push(m),
    };
    const code = await main(deps, {
      confirm: true,
      dryRun: false,
      help: false,
    });
    expect(code).toBe(1); // no valid channels → abort
    expect(post).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('REJECT'))).toBe(true);
  });

  // --- unsuitable channel type rejected ---
  it('voice channel type → rejected, zero POST', async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn().mockResolvedValue({
      id: '111111111111111111',
      guild_id: DEV_GUILD,
      type: 2 /* voice */,
    });
    const deps: RuntimeDeps = {
      loadConfig: () => stubConfig(),
      createPrisma: () =>
        ({
          guildSettings: {
            findUnique: vi.fn().mockResolvedValue({
              messageLogChannelId: '111111111111111111',
              modlogChannelId: null,
              serverLogChannelId: null,
              voiceLogChannelId: null,
            }),
          },
          $disconnect: vi.fn().mockResolvedValue(undefined),
        }) as never,
      createRest: () => ({ get, post }),
    };
    const code = await main(deps, {
      confirm: true,
      dryRun: false,
      help: false,
    });
    expect(code).toBe(1);
    expect(post).not.toHaveBeenCalled();
  });

  // --- missing type rejected ---
  it('missing channel type → rejected (fail-closed)', async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const get = vi
      .fn()
      .mockResolvedValue({ id: '111111111111111111', guild_id: DEV_GUILD });
    const deps: RuntimeDeps = {
      loadConfig: () => stubConfig(),
      createPrisma: () =>
        ({
          guildSettings: {
            findUnique: vi.fn().mockResolvedValue({
              messageLogChannelId: '111111111111111111',
              modlogChannelId: null,
              serverLogChannelId: null,
              voiceLogChannelId: null,
            }),
          },
          $disconnect: vi.fn().mockResolvedValue(undefined),
        }) as never,
      createRest: () => ({ get, post }),
    };
    const code = await main(deps, {
      confirm: true,
      dryRun: false,
      help: false,
    });
    expect(code).toBe(1);
    expect(post).not.toHaveBeenCalled();
  });

  // --- malformed channel ID from DB is silently dropped ---
  it('malformed/non-Snowflake channel IDs dropped at DB-read time', async () => {
    const post = vi.fn();
    const get = vi.fn();
    const deps: RuntimeDeps = {
      loadConfig: () => stubConfig(),
      createPrisma: () =>
        ({
          guildSettings: {
            findUnique: vi.fn().mockResolvedValue({
              messageLogChannelId: 'not-a-snowflake',
              modlogChannelId: null,
              serverLogChannelId: null,
              voiceLogChannelId: null,
            }),
          },
          $disconnect: vi.fn().mockResolvedValue(undefined),
        }) as never,
      createRest: () => ({ get, post }),
    };
    const code = await main(deps, {
      confirm: true,
      dryRun: false,
      help: false,
    });
    expect(code).toBe(0); // no valid channels, but no error
    expect(get).not.toHaveBeenCalled(); // never validated because ID was dropped
    expect(post).not.toHaveBeenCalled();
  });

  // --- error sanitization in main ---
  it('config load failure produces sanitized fatal', async () => {
    const logs: string[] = [];
    const deps: RuntimeDeps = {
      loadConfig: () => {
        throw new Error('token=abc123 postgresql://u:p@h/db');
      },
      createRest: () => ({ get: vi.fn(), post: vi.fn() }),
      logErr: (m) => logs.push(m),
    };
    await main(deps, { confirm: true, dryRun: false, help: false });
    const fatalLine = logs.find((l) => l.includes('Fatal'));
    expect(fatalLine).toBeDefined();
    expect(fatalLine).not.toContain('abc123');
    expect(fatalLine).not.toContain('postgresql://');
    expect(fatalLine).toContain('[REDACTED]');
  });

  // --- route safety: only /channels/{id}/messages ---
  it('sendPreviews only uses Routes.channelMessages pattern', () => {
    const route = Routes.channelMessages('111111111111111111');
    expect(route).toMatch(/^\/channels\/\d{17,20}\/messages$/u);
    expect(route).not.toContain('/guilds/');
    expect(route).not.toContain('/users/');
    expect(route).not.toContain('/bans/');
  });

  // --- sendPreviews with no channels: planned=0 sent=0 ---
  it('sendPreviews with empty channels → planned=0 sent=0', async () => {
    const post = vi.fn();
    const inventory = buildPreviewInventory();
    const logs: string[] = [];
    const result = await sendPreviews(
      { post },
      [], // no channels
      inventory,
      false,
      (m) => logs.push(m),
    );
    expect(result.planned).toBe(0);
    expect(result.sent).toBe(0);
    expect(post).not.toHaveBeenCalled();
  });

  // --- sendPreviews dry-run → planned>0 sent=0 ---
  it('sendPreviews dry-run → planned>0 sent=0, zero POST', async () => {
    const post = vi.fn();
    const channels: ChannelConfig[] = [
      { kind: 'message', channelId: '111111111111111111' },
    ];
    const result = await sendPreviews(
      { post },
      channels,
      buildPreviewInventory(),
      true, // dryRun
    );
    expect(result.planned).toBeGreaterThan(0);
    expect(result.sent).toBe(0);
    expect(post).not.toHaveBeenCalled();
  });

  // --- sendPreviews live → sent>0 ---
  it('sendPreviews live → POST called, sent>0', async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const channels: ChannelConfig[] = [
      { kind: 'message', channelId: '111111111111111111' },
    ];
    const result = await sendPreviews(
      { post },
      channels,
      buildPreviewInventory(),
      false,
    );
    expect(result.sent).toBeGreaterThan(0);
    expect(post).toHaveBeenCalled();
  });
});
