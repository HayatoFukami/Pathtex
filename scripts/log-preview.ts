import { REST, Routes, type APIEmbed } from 'discord.js';
import { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../src/config/env.js';
import { loadConfig } from '../src/config/env.js';
import { SnowflakeSchema } from '../src/repositories/contracts.js';

// ---------------------------------------------------------------
// Embed builders — sourced from the actual production modules.
// The preview wraps production LogEmbeds with a safety label and
// footer; all colours, inline settings, author, and timestamps
// pass through faithfully.
// ---------------------------------------------------------------
import type { LogEmbed } from '../src/features/logging/service.js';
import {
  messageEditEmbed,
  messageDeleteEmbed,
  bulkDeleteEmbed,
  voiceEmbed,
  serverEmbed,
} from '../src/features/logging/events.js';
import { roleChangeEmbed } from '../src/features/logging/role-events.js';
import {
  ModerationLogService,
  type DiscordLogPort,
  type LogSettings,
} from '../src/services/logging-services.js';
import type { CaseDto } from '../src/repositories/contracts.js';
import type { CaseService } from '../src/services/case-service.js';
import { ok } from '../src/domain/result.js';

// ---------------------------------------------------------------
// Preview metadata
// ---------------------------------------------------------------
const PREVIEW_LABEL = 'Pathtex UI Preview';
const PREVIEW_FOOTER_TEXT = 'Pathtex UI Preview — dummy data, not a real event';

const DUMMY = {
  guildId: '111111111111111111',
  channelId: '222222222222222222',
  channelId2: '222222222222222223',
  userId: '333333333333333333',
  userId2: '444444444444444444',
  messageId: '555555555555555555',
  roleId: '666666666666666666',
  caseId: '00000000-0000-4000-8000-000000000000',
} as const;

// ---------------------------------------------------------------
// Preview embed factory — wraps a production LogEmbed.
// Adds the preview title prefix; preserves production color,
// author, footer, timestamp, and inline settings as-is.
// Omits undefined optional fields for clean APIEmbed output.
// ---------------------------------------------------------------
function toPreviewEmbed(embed: LogEmbed, category: string): APIEmbed {
  const result: APIEmbed = {
    title: `[${PREVIEW_LABEL} — ${category}] ${embed.title}`,
    fields: embed.fields.map((f) => ({
      name: f.name,
      value: f.value,
      ...(f.inline !== undefined ? { inline: f.inline } : {}),
    })),
    footer: embed.footer ?? { text: PREVIEW_FOOTER_TEXT },
  };
  if (embed.color !== undefined) result.color = embed.color;
  if (embed.timestamp !== undefined) result.timestamp = embed.timestamp;
  if (embed.author) {
    const { name, icon_url } = embed.author;
    result.author = icon_url !== undefined ? { name, icon_url } : { name };
  }
  return result;
}

// ---------------------------------------------------------------
// Dummy case DTOs for writeCase rendering
// ---------------------------------------------------------------
function dummyCaseDto(overrides: Partial<CaseDto>): CaseDto {
  return {
    id: DUMMY.caseId,
    guildId: DUMMY.guildId,
    caseNumber: overrides.caseNumber ?? 1,
    action: overrides.action ?? 'KICK',
    targetUserId: overrides.targetUserId ?? DUMMY.userId,
    targetDisplay: overrides.targetDisplay ?? '対象ユーザー',
    moderatorUserId: overrides.moderatorUserId ?? DUMMY.userId2,
    reason: overrides.reason ?? 'プレビュー用のダミー理由',
    durationSeconds: overrides.durationSeconds ?? null,
    source: overrides.source ?? 'COMMAND',
    status: overrides.status ?? 'COMPLETED',
    errorCode: overrides.errorCode ?? null,
    logMessageId: null,
    logChannelId: null,
    discordAuditLogEntryId: null,
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
  };
}

/** Render a single case through the production writeCase pipeline
 *  and return the resulting APIEmbed. */
async function renderWriteCaseEmbed(
  dto: CaseDto,
  category: string,
): Promise<APIEmbed> {
  const captured: APIEmbed[] = [];
  const sender: DiscordLogPort = {
    send: (_channelId, event) => {
      captured.push(event.embed as APIEmbed);
      return Promise.resolve();
    },
  };
  const settings: LogSettings = {
    getChannel: () => Promise.resolve(DUMMY.channelId),
    clearChannel: () => Promise.resolve(),
  };
  const cases: Pick<CaseService, 'get'> = {
    get: () => Promise.resolve(ok(dto)),
  };
  const service = new ModerationLogService(
    sender,
    settings,

    cases as unknown as CaseService,
  );
  await service.writeCase(dto.guildId, dto.id);
  const embed = captured[0];
  if (!embed) throw new Error('writeCase did not produce an embed');
  return toPreviewEmbed(embed as LogEmbed, category);
}

// ---------------------------------------------------------------
// Preview inventory generators
// ---------------------------------------------------------------
type PreviewPayload = { label: string; embeds: APIEmbed[] };
const now = new Date();

function messagePreviews(): PreviewPayload[] {
  const C = 'Message';
  const edit = messageEditEmbed(
    {
      guildId: DUMMY.guildId,
      channelId: DUMMY.channelId,
      messageId: DUMMY.messageId,
      author: 'testUser#1234',
      authorId: DUMMY.userId,
      content: '編集前の元の内容',
      attachments: [],
      embeds: [],
      createdAt: new Date(now.getTime() - 300_000),
      url: `https://discord.com/channels/${DUMMY.guildId}/${DUMMY.channelId}/${DUMMY.messageId}`,
    },
    {
      guildId: DUMMY.guildId,
      channelId: DUMMY.channelId,
      messageId: DUMMY.messageId,
      author: 'testUser#1234',
      authorId: DUMMY.userId,
      content: '編集後の変更内容',
      attachments: [],
      embeds: [],
      createdAt: now,
      url: `https://discord.com/channels/${DUMMY.guildId}/${DUMMY.channelId}/${DUMMY.messageId}`,
    },
    now,
  );
  const del = messageDeleteEmbed(
    {
      guildId: DUMMY.guildId,
      channelId: DUMMY.channelId,
      messageId: DUMMY.messageId,
      author: 'deletedUser#5678',
      authorId: DUMMY.userId2,
      content: 'このメッセージは削除されました',
      createdAt: new Date(now.getTime() - 600_000),
      url: `https://discord.com/channels/${DUMMY.guildId}/${DUMMY.channelId}/${DUMMY.messageId}`,
    },
    'Moderator#0001',
    'スパム対策',
    now,
  );
  const bulk = bulkDeleteEmbed(
    DUMMY.channelId,
    15,
    [
      {
        guildId: DUMMY.guildId,
        channelId: DUMMY.channelId,
        messageId: '555555555555555501',
        author: 'user1#1111',
        authorId: DUMMY.userId,
        content: 'スパムメッセージ 1',
        createdAt: new Date(now.getTime() - 100_000),
      },
      {
        guildId: DUMMY.guildId,
        channelId: DUMMY.channelId,
        messageId: '555555555555555502',
        author: 'user2#2222',
        authorId: DUMMY.userId2,
        content: 'スパムメッセージ 2',
        createdAt: new Date(now.getTime() - 110_000),
      },
    ],
    'Moderator#0001',
    now,
    'スパム一括削除',
  );
  return [
    { label: 'MessageEdit', embeds: edit ? [toPreviewEmbed(edit, C)] : [] },
    { label: 'MessageDelete', embeds: [toPreviewEmbed(del, C)] },
    { label: 'BulkDelete', embeds: [toPreviewEmbed(bulk, C)] },
  ];
}

async function moderationPreviews(): Promise<PreviewPayload[]> {
  const C = 'Moderation';

  const cases: Promise<PreviewPayload>[] = [
    renderWriteCaseEmbed(
      dummyCaseDto({ caseNumber: 1, action: 'KICK' }),
      C,
    ).then((embed) => ({ label: 'Case-KICK-writeCase', embeds: [embed] })),
    renderWriteCaseEmbed(
      dummyCaseDto({
        caseNumber: 2,
        action: 'BAN',
        durationSeconds: 604800,
        reason: 'ルール違反',
      }),
      C,
    ).then((embed) => ({ label: 'Case-BAN-writeCase', embeds: [embed] })),
    renderWriteCaseEmbed(
      dummyCaseDto({
        caseNumber: 3,
        action: 'MUTE',
        durationSeconds: 3600,
        reason: 'チャットでのスパム',
      }),
      C,
    ).then((embed) => ({ label: 'Case-MUTE-writeCase', embeds: [embed] })),
    renderWriteCaseEmbed(
      dummyCaseDto({
        caseNumber: 4,
        action: 'UNBAN',
        metadata: { dmDelivered: '対象外' },
      }),
      C,
    ).then((embed) => ({ label: 'Case-UNBAN-writeCase', embeds: [embed] })),
    renderWriteCaseEmbed(
      dummyCaseDto({ caseNumber: 5, action: 'SOFTBAN' }),
      C,
    ).then((embed) => ({ label: 'Case-SOFTBAN-writeCase', embeds: [embed] })),
    renderWriteCaseEmbed(
      dummyCaseDto({
        caseNumber: 6,
        action: 'UNMUTE',
        metadata: { dmDelivered: '対象外' },
      }),
      C,
    ).then((embed) => ({ label: 'Case-UNMUTE-writeCase', embeds: [embed] })),
    renderWriteCaseEmbed(
      dummyCaseDto({
        caseNumber: 100,
        action: 'BAN',
        source: 'EXTERNAL',
        reason: '外部操作',
        metadata: { dmDelivered: '対象外' },
      }),
      C,
    ).then((embed) => ({
      label: 'Case-EXTERNAL-BAN-writeCase',
      embeds: [embed],
    })),
    renderWriteCaseEmbed(
      dummyCaseDto({
        caseNumber: 101,
        action: 'KICK',
        source: 'EXTERNAL',
        reason: '外部操作',
        metadata: { dmDelivered: '対象外' },
      }),
      C,
    ).then((embed) => ({
      label: 'Case-EXTERNAL-KICK-writeCase',
      embeds: [embed],
    })),
    renderWriteCaseEmbed(
      dummyCaseDto({
        caseNumber: 200,
        action: 'BAN',
        status: 'FAILED',
        errorCode: 'DISCORD_API_ERROR',
        metadata: { dmDelivered: false },
      }),
      C,
    ).then((embed) => ({
      label: 'Case-FAILED-writeCase',
      embeds: [embed],
    })),
  ];

  return Promise.all(cases);
}

function serverPreviews(): PreviewPayload[] {
  const C = 'Server';
  const s = (
    title: string,
    fields: ReadonlyArray<{ name: string; value: string }>,
    color?: number,
  ) => serverEmbed(title, fields, now, color);

  return [
    {
      label: 'MemberJoin',
      embeds: [
        toPreviewEmbed(
          s(
            'メンバー参加',
            [
              {
                name: 'ユーザー',
                value: `新規ユーザー#9999 (${DUMMY.userId})`,
              },
            ],
            0x3498db,
          ),
          C,
        ),
      ],
    },
    {
      label: 'MemberLeave',
      embeds: [
        toPreviewEmbed(
          s(
            'メンバー退出',
            [{ name: 'ユーザー', value: `退出ユーザー (${DUMMY.userId})` }],
            0x95a5a6,
          ),
          C,
        ),
      ],
    },
    {
      label: 'MemberNameUpdate',
      embeds: [
        toPreviewEmbed(
          s(
            'メンバー更新',
            [
              {
                name: 'ユーザー',
                value: `変更ユーザー#7777 (${DUMMY.userId})`,
              },
              { name: '変更前', value: '旧ニックネーム' },
              { name: '変更後', value: '新ニックネーム' },
            ],
            0x3498db,
          ),
          C,
        ),
      ],
    },
    {
      label: 'UserUpdate',
      embeds: [
        toPreviewEmbed(
          s(
            'ユーザー更新',
            [
              {
                name: 'ユーザー',
                value: `更新ユーザー#8888 (${DUMMY.userId})`,
              },
            ],
            0x3498db,
          ),
          C,
        ),
      ],
    },
    {
      label: 'ChannelCreate',
      embeds: [
        toPreviewEmbed(
          s(
            'チャンネル作成',
            [
              {
                name: 'チャンネル',
                value: `新規チャンネル (${DUMMY.channelId})`,
              },
            ],
            0x3498db,
          ),
          C,
        ),
      ],
    },
    {
      label: 'ChannelUpdate',
      embeds: [
        toPreviewEmbed(
          s(
            'チャンネル更新',
            [{ name: 'チャンネル', value: DUMMY.channelId }],
            0x3498db,
          ),
          C,
        ),
      ],
    },
    {
      label: 'RoleAdd',
      embeds: [
        toPreviewEmbed(
          roleChangeEmbed({
            targetDisplay: '対象ユーザー',
            targetUserId: DUMMY.userId,
            roleName: 'モデレーター',
            roleId: DUMMY.roleId,
            operation: '追加',
            executor: `管理者ユーザー (${DUMMY.userId2})`,
            date: now,
            zone: 'Asia/Tokyo',
          }),
          C,
        ),
      ],
    },
    {
      label: 'RoleRemove',
      embeds: [
        toPreviewEmbed(
          roleChangeEmbed({
            targetDisplay: '対象ユーザー',
            targetUserId: DUMMY.userId,
            roleName: 'モデレーター',
            roleId: DUMMY.roleId,
            operation: '削除',
            executor: `管理者ユーザー (${DUMMY.userId2})`,
            date: now,
            zone: 'Asia/Tokyo',
          }),
          C,
        ),
      ],
    },
    {
      label: 'BAN追加',
      embeds: [
        toPreviewEmbed(
          s(
            'BAN追加',
            [
              { name: 'ユーザー', value: `BAN対象ユーザー (${DUMMY.userId})` },
              { name: '判定', value: 'Audit Log照合済み' },
            ],
            0xe74c3c,
          ),
          C,
        ),
      ],
    },
    {
      label: 'BAN解除',
      embeds: [
        toPreviewEmbed(
          s(
            'BAN解除',
            [
              {
                name: 'ユーザー',
                value: `UNBAN対象ユーザー (${DUMMY.userId})`,
              },
              { name: '判定', value: '内部操作（Bot起因）' },
            ],
            0x2ecc71,
          ),
          C,
        ),
      ],
    },
  ];
}

function voicePreviews(): PreviewPayload[] {
  const C = 'Voice';
  const vc = (
    kind: 'Join' | 'Leave' | 'Move',
    oldCh: string | null,
    newCh: string | null,
  ) => voiceEmbed('ボイスユーザー#0000', DUMMY.userId, kind, oldCh, newCh, now);
  return [
    {
      label: 'VoiceJoin',
      embeds: [toPreviewEmbed(vc('Join', null, DUMMY.channelId), C)],
    },
    {
      label: 'VoiceLeave',
      embeds: [toPreviewEmbed(vc('Leave', DUMMY.channelId, null), C)],
    },
    {
      label: 'VoiceMove',
      embeds: [
        toPreviewEmbed(vc('Move', DUMMY.channelId, DUMMY.channelId2), C),
      ],
    },
  ];
}

// ---------------------------------------------------------------
// Preview inventory
// ---------------------------------------------------------------
export interface PreviewEntry {
  kind: 'message' | 'moderation' | 'server' | 'voice';
  label: string;
  embeds: APIEmbed[];
}

export async function buildPreviewInventory(): Promise<PreviewEntry[]> {
  const [moderation] = await Promise.all([moderationPreviews()]);
  return [
    ...messagePreviews().map((p): PreviewEntry => ({ kind: 'message', ...p })),
    ...moderation.map((p): PreviewEntry => ({ kind: 'moderation', ...p })),
    ...serverPreviews().map((p): PreviewEntry => ({ kind: 'server', ...p })),
    ...voicePreviews().map((p): PreviewEntry => ({ kind: 'voice', ...p })),
  ];
}

// ---------------------------------------------------------------
// Channel validation — fail-closed.
// ---------------------------------------------------------------
const SUITABLE_CHANNEL_TYPES = new Set([0, 5]);

export interface ChannelValidationResult {
  valid: boolean;
  reason?: string;
}

export function validateChannelData(
  channel: { id: string; guild_id?: string; type?: number } | null,
  expectedGuildId: string,
): ChannelValidationResult {
  if (!channel) return { valid: false, reason: 'channel not found' };
  if (channel.guild_id !== expectedGuildId)
    return {
      valid: false,
      reason: `guild mismatch: expected ${expectedGuildId}, got ${channel.guild_id ?? 'none'}`,
    };
  if (channel.type === undefined || !SUITABLE_CHANNEL_TYPES.has(channel.type))
    return {
      valid: false,
      reason: `unsuitable channel type ${String(channel.type ?? 'undefined')} (expected GuildText or GuildAnnouncement)`,
    };
  return { valid: true };
}

export type LogKind = 'message' | 'moderation' | 'server' | 'voice';

export interface ChannelConfig {
  kind: LogKind;
  channelId: string;
}

function isValidSnowflake(value: unknown): value is string {
  return typeof value === 'string' && SnowflakeSchema.safeParse(value).success;
}

export async function readConfiguredChannels(
  prisma: Pick<PrismaClient, 'guildSettings'>,
  guildId: string,
): Promise<ChannelConfig[]> {
  const settings = await prisma.guildSettings.findUnique({
    where: { guildId },
    select: {
      messageLogChannelId: true,
      modlogChannelId: true,
      serverLogChannelId: true,
      voiceLogChannelId: true,
    },
  });
  if (!settings) return [];

  const mapping: [LogKind, string | null][] = [
    ['message', settings.messageLogChannelId],
    ['moderation', settings.modlogChannelId],
    ['server', settings.serverLogChannelId],
    ['voice', settings.voiceLogChannelId],
  ];

  return mapping
    .filter((entry): entry is [LogKind, string] => isValidSnowflake(entry[1]))
    .map(([kind, channelId]) => ({ kind, channelId }));
}

async function fetchAndValidateChannel(
  rest: Pick<REST, 'get'>,
  channelId: string,
  guildId: string,
): Promise<ChannelValidationResult> {
  try {
    const channel = (await rest.get(Routes.channel(channelId))) as {
      id: string;
      guild_id?: string;
      type?: number;
    } | null;
    return validateChannelData(channel, guildId);
  } catch (error: unknown) {
    const code = (error as { code?: unknown }).code;
    const status = (error as { status?: unknown }).status;
    if (status === 404 || code === 10003)
      return { valid: false, reason: 'channel not found (404)' };
    const ec =
      typeof code === 'string' || typeof code === 'number'
        ? String(code)
        : typeof status === 'string' || typeof status === 'number'
          ? String(status)
          : 'unknown';
    return { valid: false, reason: `fetch failed: ${ec}` };
  }
}

export async function validateAllChannels(
  rest: Pick<REST, 'get'>,
  channels: ChannelConfig[],
  guildId: string,
): Promise<{
  valid: ChannelConfig[];
  rejected: { channel: ChannelConfig; reason: string }[];
}> {
  const valid: ChannelConfig[] = [];
  const rejected: { channel: ChannelConfig; reason: string }[] = [];
  const seen = new Map<string, ChannelConfig[]>();
  for (const ch of channels) {
    const arr = seen.get(ch.channelId);
    if (arr) arr.push(ch);
    else seen.set(ch.channelId, [ch]);
  }
  for (const [channelId, configs] of seen) {
    const result = await fetchAndValidateChannel(rest, channelId, guildId);
    if (result.valid) {
      for (const c of configs) valid.push(c);
    } else {
      for (const c of configs)
        rejected.push({ channel: c, reason: result.reason ?? 'unknown' });
    }
  }
  return { valid, rejected };
}

const ALLOWED_PREFIX = '/channels/';
const ALLOWED_SUFFIX = '/messages';

function routeIsAllowed(route: `/${string}`): boolean {
  return route.startsWith(ALLOWED_PREFIX) && route.endsWith(ALLOWED_SUFFIX);
}

export interface SendResult {
  planned: number;
  sent: number;
}

export async function sendPreviews(
  rest: {
    post(route: `/${string}`, options: { body: unknown }): Promise<unknown>;
  },
  channels: ChannelConfig[],
  inventory: PreviewEntry[],
  dryRun: boolean,
  log: (msg: string) => void = console.log,
  logErr: (msg: string) => void = console.error,
): Promise<SendResult> {
  const kinds = new Set(channels.map((c) => c.kind));
  const dedupe = new Set<string>();
  let planned = 0;
  let sent = 0;

  for (const entry of inventory) {
    if (!kinds.has(entry.kind)) {
      log(`  [SKIP] ${entry.kind}/${entry.label} — no channel configured`);
      continue;
    }
    if (entry.embeds.length === 0) continue;
    const target = channels.find((c) => c.kind === entry.kind);
    if (!target || dedupe.has(`${target.channelId}:${entry.label}`)) continue;
    dedupe.add(`${target.channelId}:${entry.label}`);
    planned++;

    if (dryRun) {
      log(
        `  [DRY] ${entry.kind}/${entry.label} → channel ${target.channelId} (${String(entry.embeds.length)} embed(s))`,
      );
      continue;
    }

    const route = Routes.channelMessages(target.channelId);
    if (!routeIsAllowed(route)) {
      logErr(
        `  [REJECT] ${entry.kind}/${entry.label} → disallowed route: ${route}`,
      );
      continue;
    }

    try {
      await rest.post(route, { body: { embeds: entry.embeds } });
      log(`  [OK]  ${entry.kind}/${entry.label} → channel ${target.channelId}`);
      sent++;
    } catch (error: unknown) {
      const code = (error as { code?: unknown }).code;
      const status = (error as { status?: unknown }).status;
      const ec =
        typeof code === 'string' || typeof code === 'number'
          ? String(code)
          : typeof status === 'string' || typeof status === 'number'
            ? String(status)
            : 'unknown';
      logErr(
        `  [FAIL] ${entry.kind}/${entry.label} → channel ${target.channelId} (code=${ec})`,
      );
    }
  }
  return { planned, sent };
}

export function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/(?:discord[\s_-]?token|token)\s*[:=]\s*\S+/gi, '[REDACTED]')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[REDACTED]')
    .replace(
      /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g,
      '[REDACTED-JWT]',
    )
    .slice(0, 500);
}

export interface ParsedArgs {
  confirm: boolean;
  dryRun: boolean;
  help: boolean;
}

export function parseArgs(
  raw: readonly string[] = process.argv.slice(2),
): ParsedArgs {
  return {
    confirm: raw.includes('--confirm') || raw.includes('--yes'),
    dryRun: raw.includes('--dry-run'),
    help: raw.includes('--help') || raw.includes('-h'),
  };
}

export interface RuntimeDeps {
  loadConfig(): AppConfig;
  createPrisma?(): Pick<PrismaClient, 'guildSettings' | '$disconnect'>;
  createRest(token: string): {
    get: REST['get'];
    post(route: `/${string}`, options: { body: unknown }): Promise<unknown>;
  };
  log?: (msg: string) => void;
  logErr?: (msg: string) => void;
}

export async function main(
  deps: RuntimeDeps,
  args: ParsedArgs = parseArgs(),
): Promise<number> {
  if (args.help) {
    (
      deps.log ?? console.log
    )(`Usage: tsx scripts/log-preview.ts --confirm [--dry-run]

  Sends dummy embed previews of every log type to the configured
  log channels in the DEV_GUILD_ID guild.

Options:
  --confirm    Required.  Explicitly authorise sending messages.
  --dry-run    Print what would be sent without actually sending.
  --help, -h   Show this message.

Safety guarantees:
  - Only sends to channels configured in GuildSettings for DEV_GUILD_ID.
  - Every channel is validated via Discord API before any POST.
  - Cross-guild, stale, missing-type, and non-text channels are rejected.
  - Every embed is clearly labeled "Pathtex UI Preview".
  - All data is dummy; no real Discord objects are referenced.
  - No database writes, no moderation actions, no DMs, no state mutation.
  - Only POST /channels/{id}/messages routes are used.
`);
    return 0;
  }
  if (!args.confirm) {
    (deps.logErr ?? console.error)(
      'Error: --confirm flag is required.  Run with --help for usage.',
    );
    return 1;
  }

  const defaultLog = (m: string): void => {
    console.log(m);
  };
  const defaultLogErr = (m: string): void => {
    console.error(m);
  };
  const log = deps.log ?? defaultLog;
  const logErr = deps.logErr ?? defaultLogErr;

  let config: AppConfig;
  try {
    config = deps.loadConfig();
  } catch (error: unknown) {
    (deps.logErr ?? console.error)(
      `Fatal: ${sanitizeErrorMessage(error instanceof Error ? error.message : String(error))}`,
    );
    return 1;
  }
  if (!config.DEV_GUILD_ID) {
    logErr('Error: DEV_GUILD_ID is not set.');
    return 1;
  }

  log(`Pathtex Log UI Preview — guild ${config.DEV_GUILD_ID}`);
  log(`Mode: ${args.dryRun ? 'dry-run (no messages sent)' : 'LIVE'}`);
  log('');

  let rawChannels: ChannelConfig[] = [];
  if (deps.createPrisma) {
    const prisma = deps.createPrisma() as PrismaClient;
    try {
      rawChannels = await readConfiguredChannels(prisma, config.DEV_GUILD_ID);
    } finally {
      await prisma.$disconnect();
    }
  }
  if (rawChannels.length === 0) {
    log('No log channels configured (or no DB access).');
    return 0;
  }

  const rest = deps.createRest(config.DISCORD_TOKEN);
  const { valid, rejected } = await validateAllChannels(
    rest,
    rawChannels,
    config.DEV_GUILD_ID,
  );
  for (const r of rejected) {
    log(
      `  [REJECT] ${r.channel.kind} channel ${r.channel.channelId}: ${r.reason}`,
    );
  }
  if (valid.length === 0) {
    logErr('Error: no valid channels.  Aborting.');
    return 1;
  }

  const kindNames: Record<string, string> = {
    message: 'Message log',
    moderation: 'Moderation log',
    server: 'Server log',
    voice: 'Voice log',
  };
  log('Validated channels:');
  for (const ch of valid) {
    log(`  ${kindNames[ch.kind] ?? ch.kind}: ${ch.channelId}`);
  }
  log('');

  const inventory = await buildPreviewInventory();
  log(`Preview inventory: ${String(inventory.length)} entry groups`);
  log('');

  const { planned, sent } = await sendPreviews(
    rest,
    valid,
    inventory,
    args.dryRun,
    log,
    logErr,
  );

  log('');
  if (args.dryRun) {
    log(
      `Planned: ${String(planned)}, Sent: ${String(sent)} (dry-run, zero POSTs)`,
    );
  } else {
    log(`Sent: ${String(sent)}, Planned: ${String(planned)}`);
  }
  log('Done.  All previews are labeled "Pathtex UI Preview".');
  if (!args.dryRun) {
    log('Check the configured log channels in Discord to review the output.');
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const deps: RuntimeDeps = {
    loadConfig,
    createPrisma: () => new PrismaClient(),
    createRest: (token) => new REST({ version: '10' }).setToken(token),
  };
  void main(deps)
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Fatal: ${sanitizeErrorMessage(msg)}`);
      process.exitCode = 1;
    });
}
