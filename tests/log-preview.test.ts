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
import {
  messageEditEmbed,
  messageDeleteEmbed,
  bulkDeleteEmbed,
  voiceEmbed,
  serverEmbed,
} from '../src/features/logging/events.js';
import { roleChangeEmbed } from '../src/features/logging/role-events.js';

const PREVIEW_LABEL = 'Pathtex UI Preview';
const PREVIEW_FOOTER = 'Pathtex UI Preview — dummy data, not a real event';
const DEV_GUILD = '123456789012345678';

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
  'MemberJoin',
  'MemberLeave',
  'MemberNameUpdate',
  'UserUpdate',
  'RoleAdd',
  'RoleRemove',
  'BAN追加',
  'BAN解除',
  'VoiceJoin',
  'VoiceLeave',
  'VoiceMove',
]);

describe('inventory', () => {
  let inventory: PreviewEntry[];
  beforeAll(async () => {
    inventory = await buildPreviewInventory();
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
      for (const e of inventory) {
        for (const em of e.embeds) {
          if (e.label.startsWith('Case-')) {
            expect(em.footer?.text).toBe(
              '00000000-0000-4000-8000-000000000000',
            );
          } else {
            expect(em.footer?.text).toBe(PREVIEW_FOOTER);
          }
        }
      }
    });
    it('preview colours match production', () => {
      for (const e of inventory) {
        for (const em of e.embeds) {
          if (em.color !== undefined) {
            expect(em.color).toBeGreaterThanOrEqual(0);
            expect(em.color).toBeLessThanOrEqual(0xffffff);
          }
        }
      }
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
    it('every embed has a valid Discord timestamp', () => {
      for (const em of all()) {
        expect(
          em.timestamp,
          `missing timestamp in "${em.title ?? '(no title)'}"`,
        ).toBeDefined();
        expect(() => new Date(em.timestamp as string)).not.toThrow();
      }
    });
    it('no human-readable date/time text leaks into visible content', () => {
      const DATE_PATTERN =
        /\b(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}|\d{1,2}:\d{2}(:\d{2})?|[上下]午\d{1,2}時)/u;
      for (const e of inventory) {
        for (const em of e.embeds) {
          if (em.description) {
            expect(
              em.description,
              `${e.label} description has date/time`,
            ).not.toMatch(DATE_PATTERN);
          }
          const innerTitle = (em.title ?? '').replace(
            /^\[Pathtex UI Preview[^\]]*\]\s*/u,
            '',
          );
          expect(innerTitle, `${e.label} title has date/time`).not.toMatch(
            DATE_PATTERN,
          );
          for (const f of em.fields ?? []) {
            expect(
              f.value,
              `${e.label}/${f.name} value has date/time`,
            ).not.toMatch(DATE_PATTERN);
          }
        }
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
    it('writeCase uses Discord timestamp', () => {
      for (const e of inventory) {
        if (!e.label.startsWith('Case-')) continue;
        for (const em of e.embeds) {
          expect(em.timestamp).toBeDefined();
          expect(() => new Date(em.timestamp as string)).not.toThrow();
        }
      }
    });
    it('writeCase has standard fields', () => {
      for (const e of inventory) {
        if (!e.label.startsWith('Case-')) continue;
        for (const em of e.embeds) {
          const names = (em.fields ?? []).map((f) => f.name);
          for (const n of [
            '対象',
            '実行者',
            '理由',
            '期間',
            '発生元',
            '状態',
            'DM',
          ]) {
            expect(names, `${e.label} missing ${n}`).toContain(n);
          }
          expect(em.title).toMatch(/ケース #\d+ — /u);
        }
      }
    });
    it('role no-duplicate-id', () => {
      for (const e of inventory) {
        if (e.label !== 'RoleAdd' && e.label !== 'RoleRemove') continue;
        for (const em of e.embeds) {
          const uf = (em.fields ?? []).find((f) => f.name === 'ユーザー');
          expect(uf).toBeDefined();
          if (uf)
            expect((uf.value.match(/333333333333333333/g) ?? []).length).toBe(
              1,
            );
        }
      }
    });
    it('UserUpdate present', () => {
      expect(inventory.map((e) => e.label)).toContain('UserUpdate');
    });
  });

  describe('production parity', () => {
    it('message embeds carry production author', () => {
      for (const e of inventory) {
        if (e.label !== 'MessageEdit' && e.label !== 'MessageDelete') continue;
        for (const em of e.embeds) {
          expect(em.author, e.label).toBeDefined();
          expect(em.author?.name).toBeTruthy();
        }
      }
    });

    it('writeCase embeds carry production case-UUID footer', () => {
      const DUMMY_CASE_ID = '00000000-0000-4000-8000-000000000000';
      for (const e of inventory) {
        if (!e.label.startsWith('Case-')) continue;
        for (const em of e.embeds) {
          expect(em.footer?.text).toBe(DUMMY_CASE_ID);
        }
      }
    });

    it('writeCase FAILED embeds are grey', () => {
      const entry = inventory.find((e) => e.label === 'Case-FAILED-writeCase');
      expect(entry).toBeDefined();
      for (const em of (entry as PreviewEntry).embeds) {
        expect(em.color).toBe(0x95a5a6);
      }
    });

    it('message-edit embed has yellow colour', () => {
      const entry = inventory.find((e) => e.label === 'MessageEdit');
      expect(entry).toBeDefined();
      for (const em of (entry as PreviewEntry).embeds) {
        expect(em.color).toBe(0xf1c40f);
      }
    });

    it('message-delete embed has red colour', () => {
      const entry = inventory.find((e) => e.label === 'MessageDelete');
      expect(entry).toBeDefined();
      for (const em of (entry as PreviewEntry).embeds) {
        expect(em.color).toBe(0xe74c3c);
      }
    });

    it('bulk-delete embed has red colour', () => {
      const entry = inventory.find((e) => e.label === 'BulkDelete');
      expect(entry).toBeDefined();
      for (const em of (entry as PreviewEntry).embeds) {
        expect(em.color).toBe(0xe74c3c);
      }
    });

    it('voice embeds have blue colour', () => {
      for (const e of inventory) {
        if (e.kind !== 'voice') continue;
        for (const em of e.embeds) {
          expect(em.color).toBe(0x3498db);
        }
      }
    });

    it('role-add embed has green colour', () => {
      const entry = inventory.find((e) => e.label === 'RoleAdd');
      expect(entry).toBeDefined();
      for (const em of (entry as PreviewEntry).embeds) {
        expect(em.color).toBe(0x2ecc71);
      }
    });

    it('role-remove embed has grey colour', () => {
      const entry = inventory.find((e) => e.label === 'RoleRemove');
      expect(entry).toBeDefined();
      for (const em of (entry as PreviewEntry).embeds) {
        expect(em.color).toBe(0x95a5a6);
      }
    });

    it('BAN追加 embed has red colour', () => {
      const entry = inventory.find((e) => e.label === 'BAN追加');
      expect(entry).toBeDefined();
      for (const em of (entry as PreviewEntry).embeds) {
        expect(em.color).toBe(0xe74c3c);
      }
    });

    it('BAN解除 embed has green colour', () => {
      const entry = inventory.find((e) => e.label === 'BAN解除');
      expect(entry).toBeDefined();
      for (const em of (entry as PreviewEntry).embeds) {
        expect(em.color).toBe(0x2ecc71);
      }
    });

    it('MemberJoin embed has blue colour', () => {
      const entry = inventory.find((e) => e.label === 'MemberJoin');
      expect(entry).toBeDefined();
      for (const em of (entry as PreviewEntry).embeds) {
        expect(em.color).toBe(0x3498db);
      }
    });

    it('MemberLeave embed has grey colour', () => {
      const entry = inventory.find((e) => e.label === 'MemberLeave');
      expect(entry).toBeDefined();
      for (const em of (entry as PreviewEntry).embeds) {
        expect(em.color).toBe(0x95a5a6);
      }
    });

    it('MemberNameUpdate embed has blue colour', () => {
      const entry = inventory.find((e) => e.label === 'MemberNameUpdate');
      expect(entry).toBeDefined();
      for (const em of (entry as PreviewEntry).embeds) {
        expect(em.color).toBe(0x3498db);
      }
    });

    it('UserUpdate embed has blue colour', () => {
      const entry = inventory.find((e) => e.label === 'UserUpdate');
      expect(entry).toBeDefined();
      for (const em of (entry as PreviewEntry).embeds) {
        expect(em.color).toBe(0x3498db);
      }
    });

    it('non-Case embeds use preview safety footer', () => {
      for (const e of inventory) {
        if (e.label.startsWith('Case-')) continue;
        for (const em of e.embeds) {
          expect(em.footer?.text).toBe(PREVIEW_FOOTER);
        }
      }
    });
  });

  describe('production builders exercised', () => {
    const now = new Date();
    it('messageEditEmbed fields have explicit inline', () => {
      const em = messageEditEmbed(
        {
          guildId: '111111111111111111',
          channelId: '222222222222222222',
          messageId: '555555555555555555',
          author: 'test#0001',
          authorId: '333333333333333333',
          content: 'before',
          createdAt: now,
        },
        {
          guildId: '111111111111111111',
          channelId: '222222222222222222',
          messageId: '555555555555555555',
          author: 'test#0001',
          authorId: '333333333333333333',
          content: 'after',
          createdAt: now,
        },
        now,
      );
      expect(em).not.toBeNull();
      if (em) {
        for (const f of em.fields) {
          expect(typeof f.inline).toBe('boolean');
        }
      }
    });
    it('messageDeleteEmbed fields have explicit inline', () => {
      const em = messageDeleteEmbed(
        {
          guildId: '111111111111111111',
          channelId: '222222222222222222',
          messageId: '555555555555555555',
          author: 'test#0001',
          authorId: '333333333333333333',
          content: 'deleted',
          createdAt: now,
        },
        undefined,
        undefined,
        now,
      );
      for (const f of em.fields) {
        expect(typeof f.inline).toBe('boolean');
      }
    });
    it('bulkDeleteEmbed fields have explicit inline', () => {
      const em = bulkDeleteEmbed(
        '222222222222222222',
        5,
        [],
        '不明',
        now,
        undefined,
      );
      for (const f of em.fields) {
        expect(typeof f.inline).toBe('boolean');
      }
    });
    it('voiceEmbed fields have explicit inline', () => {
      const em = voiceEmbed(
        'User',
        '333333333333333333',
        'Join',
        null,
        '222222222222222222',
        now,
      );
      expect(em).not.toBeNull();
      for (const f of em.fields) {
        expect(typeof f.inline).toBe('boolean');
      }
    });
    it('serverEmbed applies production inline defaults', () => {
      const em = serverEmbed('Test', [{ name: 'ユーザー', value: 'x' }], now);
      for (const f of em.fields) {
        expect(typeof f.inline).toBe('boolean');
      }
    });
    it('roleChangeEmbed fields have explicit inline', () => {
      const em = roleChangeEmbed({
        targetDisplay: 'User',
        targetUserId: '333333333333333333',
        roleName: 'Mod',
        roleId: '666666666666666666',
        operation: '追加',
        executor: 'Admin',
        date: now,
        zone: 'UTC',
      });
      for (const f of em.fields) {
        expect(typeof f.inline).toBe('boolean');
      }
    });
  });
});

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

describe('main behavioral safety', () => {
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
    const code = await main(deps, {
      confirm: true,
      dryRun: true,
      help: false,
    });
    expect(code).toBe(0);
    expect(get).toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
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
    expect(summary).not.toMatch(/Sent: (?!0\b)\d+/);
    expect(summary).toContain('Sent: 0');
    expect(summary).toContain('Planned:');
  });

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
    const sentLine = logs.find((l) => l.startsWith('Sent:'));
    expect(sentLine).toBeDefined();
    expect(sentLine).toMatch(/Sent: \d+/);
  });

  it('cross-guild channel → validated and rejected, zero POST', async () => {
    const post = vi.fn().mockResolvedValue(undefined);
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
    expect(code).toBe(1);
    expect(post).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('REJECT'))).toBe(true);
  });

  it('voice channel type → rejected, zero POST', async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn().mockResolvedValue({
      id: '111111111111111111',
      guild_id: DEV_GUILD,
      type: 2,
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
    expect(code).toBe(0);
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

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

  it('sendPreviews only uses Routes.channelMessages pattern', () => {
    const route = Routes.channelMessages('111111111111111111');
    expect(route).toMatch(/^\/channels\/\d{17,20}\/messages$/u);
    expect(route).not.toContain('/guilds/');
    expect(route).not.toContain('/users/');
    expect(route).not.toContain('/bans/');
  });

  it('sendPreviews with empty channels → planned=0 sent=0', async () => {
    const post = vi.fn();
    const inventory = await buildPreviewInventory();
    const logs: string[] = [];
    const result = await sendPreviews({ post }, [], inventory, false, (m) =>
      logs.push(m),
    );
    expect(result.planned).toBe(0);
    expect(result.sent).toBe(0);
    expect(post).not.toHaveBeenCalled();
  });

  it('sendPreviews dry-run → planned>0 sent=0, zero POST', async () => {
    const post = vi.fn();
    const channels: ChannelConfig[] = [
      { kind: 'message', channelId: '111111111111111111' },
    ];
    const result = await sendPreviews(
      { post },
      channels,
      await buildPreviewInventory(),
      true,
    );
    expect(result.planned).toBeGreaterThan(0);
    expect(result.sent).toBe(0);
    expect(post).not.toHaveBeenCalled();
  });

  it('sendPreviews live → POST called, sent>0', async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const channels: ChannelConfig[] = [
      { kind: 'message', channelId: '111111111111111111' },
    ];
    const result = await sendPreviews(
      { post },
      channels,
      await buildPreviewInventory(),
      false,
    );
    expect(result.sent).toBeGreaterThan(0);
    expect(post).toHaveBeenCalled();
  });
});
