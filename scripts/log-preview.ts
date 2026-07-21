import { REST, Routes, type APIEmbed } from 'discord.js';
import { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';
import type { AppConfig } from '../src/config/env.js';
import { loadConfig } from '../src/config/env.js';
import { SnowflakeSchema } from '../src/repositories/contracts.js';

// ---------------------------------------------------------------
// Embed builders — sourced from the actual production modules to
// guarantee preview fidelity.  We import the canonical functions,
// then wrap with a preview label and accent colour.
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
import { renderCaseTarget } from '../src/services/logging-services.js';
import type { CaseDto } from '../src/repositories/contracts.js';

// ---------------------------------------------------------------
// Preview metadata
// ---------------------------------------------------------------
const PREVIEW_LABEL = 'Pathtex UI Preview';
const PREVIEW_COLOR = 0xf39c12;
const PREVIEW_FOOTER = 'Pathtex UI Preview — dummy data, not a real event';
const DUMMY_ZONE = 'Asia/Tokyo';

const DUMMY = {
  guildId: '111111111111111111',
  channelId: '222222222222222222',
  channelId2: '222222222222222223',
  userId: '333333333333333333',
  userId2: '444444444444444444',
  messageId: '555555555555555555',
  roleId: '666666666666666666',
} as const;

// ---------------------------------------------------------------
// Preview embed factories
// ---------------------------------------------------------------
function toPreviewEmbed(embed: LogEmbed, category: string): APIEmbed {
  const base: APIEmbed = {
    title: `[${PREVIEW_LABEL} — ${category}] ${embed.title}`,
    color: PREVIEW_COLOR,
    fields: embed.fields.map((f) => ({
      name: f.name,
      value: f.value,
      inline: f.inline ?? false,
    })),
    footer: { text: PREVIEW_FOOTER },
  };
  if (embed.timestamp !== undefined) base.timestamp = embed.timestamp;
  return base;
}

/** Build a writeCase-style APIEmbed. Production writeCase has no Discord-level
 *  timestamp — only a "Timestamp" field.  We honour that exactly. */
function toWriteCasePreviewEmbed(
  embed: {
    title: string;
    description: string;
    fields: NonNullable<APIEmbed['fields']>;
  },
  category: string,
): APIEmbed {
  return {
    title: `[${PREVIEW_LABEL} — ${category}] ${embed.title}`,
    description: embed.description,
    color: PREVIEW_COLOR,
    fields: embed.fields,
    footer: { text: PREVIEW_FOOTER },
  };
}

// ---------------------------------------------------------------
// Moderation preview builders — three production layouts
// ---------------------------------------------------------------

/** writeCase: matches ModerationLogService.writeCase() exactly.
 *  DM values mirror String(dmDelivered): "true", "false", or "対象外". */
function writeCasePreview(args: {
  caseNumber: number;
  action: string;
  source: string;
  status: string;
  targetUserId: string;
  targetDisplay: string;
  reason: string;
  duration: string;
  moderatorUserId: string;
  date: Date;
  zone: string;
  /** Production values: "true", "false", "対象外" */
  dm: string;
  errorCode?: string;
}): {
  title: string;
  description: string;
  fields: NonNullable<APIEmbed['fields']>;
} {
  const localTime = DateTime.fromJSDate(args.date)
    .setZone(args.zone)
    .toFormat('yyyy-LL-dd HH:mm:ss ZZZZ');
  const fields: NonNullable<APIEmbed['fields']> = [
    { name: 'Action', value: args.action, inline: false },
    { name: 'Source', value: args.source, inline: false },
    { name: 'Status', value: args.status, inline: false },
    {
      name: 'Target',
      value: renderCaseTarget({
        action: args.action,
        targetUserId: args.targetUserId,
        targetDisplay: args.targetDisplay,
      } as unknown as CaseDto),
      inline: false,
    },
    { name: 'Reason', value: args.reason, inline: false },
    { name: 'Duration', value: args.duration, inline: false },
    { name: 'Moderator', value: args.moderatorUserId, inline: false },
    { name: 'Timestamp', value: localTime, inline: false },
    { name: 'DM', value: args.dm, inline: false },
  ];
  if (args.errorCode) {
    fields.push({ name: 'Error', value: args.errorCode, inline: false });
  }
  return {
    title: `ケース #${String(args.caseNumber)}: ${args.action}`,
    description: `発生時刻: ${localTime}`,
    fields,
  };
}

/** writeAction: compact embed from ModerationService.modlog.write() */
function writeActionPreview(args: {
  action: string;
  targetUserId: string;
  targetDisplay: string;
  reason: string;
}): LogEmbed {
  return {
    title: args.action,
    fields: [
      {
        name: 'Target',
        value: renderCaseTarget({
          action: args.action,
          targetUserId: args.targetUserId,
          targetDisplay: args.targetDisplay,
        } as unknown as CaseDto),
      },
      { name: 'Reason', value: args.reason },
    ],
  };
}

/** VoiceKick: matches index.ts voicePort.modlog */
function voiceKickPreview(args: {
  displayName: string;
  userId: string;
  ok: boolean;
  code?: string;
  caseNumber?: number;
  moderatorUserId: string;
}): APIEmbed {
  const result = args.ok ? '成功' : (args.code ?? '失敗');
  const caseLine =
    args.caseNumber === undefined ? '' : `\nCase #${String(args.caseNumber)}`;
  const embed: APIEmbed = {
    title: `[${PREVIEW_LABEL} — Moderation] VoiceKick`,
    description: `対象: ${args.displayName} (${args.userId})\n結果: ${result}${caseLine}`,
    color: PREVIEW_COLOR,
    fields: [{ name: '実行者', value: args.moderatorUserId, inline: false }],
    footer: { text: PREVIEW_FOOTER },
  };
  return embed;
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
      content: 'original content before edit',
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
      content: 'edited content after change',
      attachments: [],
      embeds: [],
      createdAt: now,
      url: `https://discord.com/channels/${DUMMY.guildId}/${DUMMY.channelId}/${DUMMY.messageId}`,
    },
    DUMMY_ZONE,
  );
  const del = messageDeleteEmbed(
    {
      guildId: DUMMY.guildId,
      channelId: DUMMY.channelId,
      messageId: DUMMY.messageId,
      author: 'deletedUser#5678',
      authorId: DUMMY.userId2,
      content: 'this message was deleted',
      createdAt: new Date(now.getTime() - 600_000),
      url: `https://discord.com/channels/${DUMMY.guildId}/${DUMMY.channelId}/${DUMMY.messageId}`,
    },
    now,
    DUMMY_ZONE,
    'Moderator#0001',
    'Spam removal',
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
        content: 'spam 1',
        createdAt: new Date(now.getTime() - 100_000),
      },
      {
        guildId: DUMMY.guildId,
        channelId: DUMMY.channelId,
        messageId: '555555555555555502',
        author: 'user2#2222',
        authorId: DUMMY.userId2,
        content: 'spam 2',
        createdAt: new Date(now.getTime() - 110_000),
      },
    ],
    now,
    DUMMY_ZONE,
    'Moderator#0001',
    'Spam cleanup',
  );
  return [
    { label: 'MessageEdit', embeds: edit ? [toPreviewEmbed(edit, C)] : [] },
    { label: 'MessageDelete', embeds: [toPreviewEmbed(del, C)] },
    { label: 'BulkDelete', embeds: [toPreviewEmbed(bulk, C)] },
  ];
}

function moderationPreviews(): PreviewPayload[] {
  const C = 'Moderation';

  const wc = (overrides: {
    caseNumber: number;
    action: string;
    source?: string;
    status?: string;
    reason?: string;
    duration?: string;
    dm?: string;
    errorCode?: string;
  }) => {
    const args: Parameters<typeof writeCasePreview>[0] = {
      caseNumber: overrides.caseNumber,
      action: overrides.action,
      source: overrides.source ?? 'COMMAND',
      status: overrides.status ?? 'COMPLETED',
      targetUserId: DUMMY.userId,
      targetDisplay: 'TargetUser',
      reason: overrides.reason ?? 'Preview reason — dummy data',
      duration: overrides.duration ?? 'Permanent',
      moderatorUserId: DUMMY.userId2,
      date: now,
      zone: DUMMY_ZONE,
      dm: overrides.dm ?? 'true',
    };
    if (overrides.errorCode !== undefined) args.errorCode = overrides.errorCode;
    return toWriteCasePreviewEmbed(writeCasePreview(args), C);
  };

  const wa = (overrides: { action: string; reason?: string }) =>
    toPreviewEmbed(
      writeActionPreview({
        action: overrides.action,
        targetUserId: DUMMY.userId,
        targetDisplay: 'TargetUser',
        reason: overrides.reason ?? 'Preview reason — dummy data',
      }),
      C,
    );

  const vk = (overrides: { ok: boolean; code?: string; caseNumber?: number }) =>
    voiceKickPreview({
      displayName: 'VoiceUser',
      userId: DUMMY.userId,
      moderatorUserId: DUMMY.userId2,
      ...overrides,
    });

  return [
    // writeCase
    {
      label: 'Case-KICK-writeCase',
      embeds: [wc({ caseNumber: 1, action: 'KICK' })],
    },
    {
      label: 'Case-BAN-writeCase',
      embeds: [
        wc({
          caseNumber: 2,
          action: 'BAN',
          duration: '604800秒',
          reason: 'Rule violation',
        }),
      ],
    },
    {
      label: 'Case-MUTE-writeCase',
      embeds: [
        wc({
          caseNumber: 3,
          action: 'MUTE',
          duration: '3600秒',
          reason: 'Spam in chat',
        }),
      ],
    },
    {
      label: 'Case-UNBAN-writeCase',
      embeds: [wc({ caseNumber: 4, action: 'UNBAN', dm: '対象外' })],
    },
    {
      label: 'Case-SOFTBAN-writeCase',
      embeds: [wc({ caseNumber: 5, action: 'SOFTBAN' })],
    },
    {
      label: 'Case-UNMUTE-writeCase',
      embeds: [wc({ caseNumber: 6, action: 'UNMUTE', dm: '対象外' })],
    },
    {
      label: 'Case-EXTERNAL-BAN-writeCase',
      embeds: [
        wc({
          caseNumber: 100,
          action: 'BAN',
          source: 'EXTERNAL',
          reason: '外部操作',
          dm: '対象外',
        }),
      ],
    },
    {
      label: 'Case-EXTERNAL-KICK-writeCase',
      embeds: [
        wc({
          caseNumber: 101,
          action: 'KICK',
          source: 'EXTERNAL',
          reason: '外部操作',
          dm: '対象外',
        }),
      ],
    },
    {
      label: 'Case-FAILED-writeCase',
      embeds: [
        wc({
          caseNumber: 200,
          action: 'BAN',
          status: 'FAILED',
          errorCode: 'DISCORD_API_ERROR',
          dm: 'false',
        }),
      ],
    },
    // writeAction
    { label: 'Action-KICK', embeds: [wa({ action: 'KICK' })] },
    {
      label: 'Action-BAN',
      embeds: [wa({ action: 'BAN', reason: 'Rule violation' })],
    },
    // VoiceKick
    { label: 'VoiceKick-Success', embeds: [vk({ ok: true, caseNumber: 10 })] },
    {
      label: 'VoiceKick-Failure',
      embeds: [vk({ ok: false, code: 'MEMBER_NOT_FOUND' })],
    },
  ];
}

function serverPreviews(): PreviewPayload[] {
  const C = 'Server';
  const s = (
    title: string,
    fields: ReadonlyArray<{ name: string; value: string }>,
  ) => serverEmbed(title, fields, now, DUMMY_ZONE);

  return [
    {
      label: 'MemberJoin',
      embeds: [
        toPreviewEmbed(
          s('メンバー参加', [
            { name: 'User', value: `NewUser#9999 (${DUMMY.userId})` },
          ]),
          C,
        ),
      ],
    },
    {
      label: 'MemberLeave',
      embeds: [
        toPreviewEmbed(
          s('メンバー退出', [
            { name: 'User', value: `LeavingUser (${DUMMY.userId})` },
          ]),
          C,
        ),
      ],
    },
    {
      label: 'MemberNameUpdate',
      embeds: [
        toPreviewEmbed(
          s('メンバー更新', [
            { name: 'User', value: `ChangedUser#7777 (${DUMMY.userId})` },
            { name: 'Before', value: 'OldNickname' },
            { name: 'After', value: 'NewNickname' },
          ]),
          C,
        ),
      ],
    },
    {
      label: 'UserUpdate',
      embeds: [
        toPreviewEmbed(
          s('ユーザー更新', [
            { name: 'User', value: `UpdatedGlobal#8888 (${DUMMY.userId})` },
          ]),
          C,
        ),
      ],
    },
    {
      label: 'ChannelCreate',
      embeds: [
        toPreviewEmbed(
          s('チャンネル作成', [
            { name: 'Channel', value: `new-channel (${DUMMY.channelId})` },
          ]),
          C,
        ),
      ],
    },
    {
      label: 'ChannelUpdate',
      embeds: [
        toPreviewEmbed(
          s('チャンネル更新', [{ name: 'Channel', value: DUMMY.channelId }]),
          C,
        ),
      ],
    },
    {
      label: 'RoleAdd',
      embeds: [
        toPreviewEmbed(
          roleChangeEmbed({
            targetDisplay: 'TargetUser',
            targetUserId: DUMMY.userId,
            roleName: 'Moderator',
            roleId: DUMMY.roleId,
            operation: '追加',
            executor: `AdminUser (${DUMMY.userId2})`,
            date: now,
            zone: DUMMY_ZONE,
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
            targetDisplay: 'TargetUser',
            targetUserId: DUMMY.userId,
            roleName: 'Moderator',
            roleId: DUMMY.roleId,
            operation: '削除',
            executor: `AdminUser (${DUMMY.userId2})`,
            date: now,
            zone: DUMMY_ZONE,
          }),
          C,
        ),
      ],
    },
    {
      label: 'BanEvent',
      embeds: [
        toPreviewEmbed(
          s('BANイベント', [
            { name: 'User', value: `BannedUser (${DUMMY.userId})` },
            { name: '判定', value: 'Audit Log照合済み' },
          ]),
          C,
        ),
      ],
    },
    {
      label: 'UnbanEvent',
      embeds: [
        toPreviewEmbed(
          s('UNBANイベント', [
            { name: 'User', value: `UnbannedUser (${DUMMY.userId})` },
            { name: '判定', value: '内部操作（Bot起因）' },
          ]),
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
  ) =>
    voiceEmbed(
      'VoiceUser#0000',
      DUMMY.userId,
      kind,
      oldCh,
      newCh,
      now,
      DUMMY_ZONE,
    );
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

export function buildPreviewInventory(): PreviewEntry[] {
  return [
    ...messagePreviews().map((p): PreviewEntry => ({ kind: 'message', ...p })),
    ...moderationPreviews().map((p): PreviewEntry => ({
      kind: 'moderation',
      ...p,
    })),
    ...serverPreviews().map((p): PreviewEntry => ({ kind: 'server', ...p })),
    ...voicePreviews().map((p): PreviewEntry => ({ kind: 'voice', ...p })),
  ];
}

// ---------------------------------------------------------------
// Channel validation — fail-closed.
// Type MUST be explicit 0 (GuildText) or 5 (GuildAnnouncement).
// Missing / unknown type → REJECTED.
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

// ---------------------------------------------------------------
// Channel config
// ---------------------------------------------------------------
export type LogKind = 'message' | 'moderation' | 'server' | 'voice';

export interface ChannelConfig {
  kind: LogKind;
  channelId: string;
}

function isValidSnowflake(value: unknown): value is string {
  return typeof value === 'string' && SnowflakeSchema.safeParse(value).success;
}

/** Read configured channel IDs from DB, validated with canonical Snowflake
 *  schema.  Malformed IDs are silently dropped (they cannot route). */
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

// ---------------------------------------------------------------
// Channel fetching & validation
// ---------------------------------------------------------------
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

// ---------------------------------------------------------------
// Sender — only POST /channels/{id}/messages
// ---------------------------------------------------------------
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

// ---------------------------------------------------------------
// Error sanitisation
// ---------------------------------------------------------------
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

// ---------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------
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

// ---------------------------------------------------------------
// Dependency-injectable runtime boundary
// ---------------------------------------------------------------
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

// ---------------------------------------------------------------
// Main — injectable deps enable full behavioral testing.
// ---------------------------------------------------------------
export async function main(
  deps: RuntimeDeps,
  args: ParsedArgs = parseArgs(),
): Promise<number> {
  if (args.help) {
    (deps.log ?? console.log)(
      `Usage: tsx scripts/log-preview.ts --confirm [--dry-run]

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
`,
    );
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

  // Guard: --confirm is required before any expensive init.
  // No prisma, no REST, no token resolution before this point.

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

  // Read configured channels (read-only DB, Snowflake-validated).
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

  // Validate channels via Discord API.
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

  const inventory = buildPreviewInventory();
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

// ---------------------------------------------------------------
// CLI entrypoint — only runs when executed directly.
// ---------------------------------------------------------------
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
