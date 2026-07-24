import { discordTimestamp, truncate, type LogEmbed } from './service.js';
import { t } from '../../i18n/index.js';

export function isConfiguredLogChannel(
  channelId: string,
  settings: Readonly<{
    messageLogChannelId?: string | null | undefined;
    modlogChannelId?: string | null | undefined;
    serverLogChannelId?: string | null | undefined;
    voiceLogChannelId?: string | null | undefined;
  }>,
): boolean {
  return [
    settings.messageLogChannelId,
    settings.modlogChannelId,
    settings.serverLogChannelId,
    settings.voiceLogChannelId,
  ].includes(channelId);
}

export function isBotAuthoredMessage(
  authorIsBot: boolean | null | undefined,
  snapshotAuthorId: string | null | undefined,
  botUserId: string | null | undefined,
): boolean {
  return (
    authorIsBot === true ||
    (authorIsBot == null &&
      botUserId !== undefined &&
      botUserId !== null &&
      snapshotAuthorId === botUserId)
  );
}

export interface MessageView {
  guildId: string;
  channelId: string;
  messageId: string;
  author: string;
  authorId: string;
  content: string;
  attachments?: readonly (string | Record<string, unknown>)[];
  embeds?: readonly (string | Record<string, unknown>)[];
  flags?: number | readonly string[] | null;
  mentions?: readonly { id: string; bot?: boolean }[];
  roleMentions?: readonly string[];
  everyoneMentioned?: boolean;
  topic?: string | null;
  parentTopic?: string | null;
  parentChannelId?: string | null;
  isEdit?: boolean;
  authorIsBot?: boolean;
  webhook?: boolean;
  system?: boolean;
  createdAt: Date;
  url?: string;
  avatarUrl?: string;
}
function stableStringify(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}
export function messageChanged(
  before: MessageView,
  after: MessageView,
): boolean {
  return (
    before.content !== after.content ||
    stableStringify(before.attachments ?? []) !==
      stableStringify(after.attachments ?? []) ||
    stableStringify(before.embeds ?? []) !== stableStringify(after.embeds ?? [])
  );
}
export function messageEditEmbed(
  before: MessageView | null,
  after: MessageView,
  occurredAt: Date,
): LogEmbed | null {
  if (before && !messageChanged(before, after)) return null;
  return {
    title: t('logging:messageEdit.title'),
    timestamp: discordTimestamp(occurredAt),
    color: 0xf1c40f,
    author: {
      name: `${after.author} (${after.authorId})`,
      ...(after.avatarUrl ? { icon_url: after.avatarUrl } : {}),
    },
    fields: [
      {
        name: t('logging:embedFields.author'),
        value: `${after.author} (${after.authorId})`,
        inline: true,
      },
      {
        name: t('logging:embedFields.channel'),
        value: `<#${after.channelId}> (${after.channelId})`,
        inline: true,
      },
      {
        name: t('logging:embedFields.before'),
        value: before
          ? truncate(before.content) || t('logging:common.empty')
          : t('logging:common.unavailableUnknown'),
        inline: false,
      },
      {
        name: t('logging:embedFields.after'),
        value: truncate(after.content) || t('logging:common.empty'),
        inline: false,
      },
      {
        name: t('logging:embedFields.attachments'),
        value:
          (before
            ? attachmentDelta(before.attachments ?? [], after.attachments ?? [])
            : '') || t('logging:common.none'),
        inline: false,
      },
      {
        name: t('logging:embedFields.message'),
        value: after.url ?? after.messageId,
        inline: true,
      },
    ],
  };
}
function attachmentDelta(
  before: readonly (string | Record<string, unknown>)[],
  after: readonly (string | Record<string, unknown>)[],
): string {
  const oldSet = new Set(before.map((value) => stableStringify(value)));
  const newSet = new Set(after.map((value) => stableStringify(value)));
  return [
    ...after
      .filter((item) => !oldSet.has(stableStringify(item)))
      .map((item) =>
        t('logging:messageEdit.attachmentAdded', { value: renderValue(item) }),
      ),
    ...before
      .filter((item) => !newSet.has(stableStringify(item)))
      .map((item) =>
        t('logging:messageEdit.attachmentRemoved', {
          value: renderValue(item),
        }),
      ),
  ].join('\n');
}
function renderValue(value: string | Record<string, unknown>): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
export function messageDeleteEmbed(
  message: MessageView | null,
  executor = t('logging:common.unknown'),
  reason = t('logging:common.unknown'),
  occurredAt: Date,
): LogEmbed {
  return {
    title: t('logging:messageDelete.title'),
    timestamp: discordTimestamp(occurredAt),
    color: 0xe74c3c,
    author: message
      ? {
          name: `${message.author} (${message.authorId})`,
          ...(message.avatarUrl ? { icon_url: message.avatarUrl } : {}),
        }
      : undefined,
    fields: [
      {
        name: t('logging:embedFields.author'),
        value: message
          ? `${message.author} (${message.authorId})`
          : t('logging:common.unknown'),
        inline: true,
      },
      {
        name: t('logging:embedFields.channel'),
        value: message
          ? `<#${message.channelId}> (${message.channelId})`
          : t('logging:common.unknown'),
        inline: true,
      },
      {
        name: t('logging:embedFields.messageId'),
        value: message?.messageId ?? t('logging:common.unknown'),
        inline: true,
      },
      {
        name: t('logging:embedFields.deleteExecutor'),
        value: executor,
        inline: true,
      },
      {
        name: t('logging:modlog.fieldReason'),
        value: reason,
        inline: false,
      },
      {
        name: t('logging:embedFields.body'),
        value: message
          ? truncate(message.content) || t('logging:common.empty')
          : t('logging:common.unavailableCacheless'),
        inline: false,
      },
      {
        name: t('logging:embedFields.attachments'),
        value:
          message?.attachments && message.attachments.length > 0
            ? truncate(
                message.attachments.map((a) => renderValue(a)).join('\n'),
                1024,
              ) || t('logging:common.none')
            : t('logging:common.none'),
        inline: false,
      },
    ],
  };
}
export function bulkDeleteEmbed(
  channelId: string,
  count: number,
  cached: readonly MessageView[],
  executor = t('logging:common.unknown'),
  occurredAt: Date,
  reason?: string,
): LogEmbed {
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: t('logging:embedFields.deleteCount'), value: String(count), inline: true },
    {
      name: t('logging:embedFields.channel'),
      value: `<#${channelId}> (${channelId})`,
      inline: true,
    },
    { name: t('logging:embedFields.deleteExecutor'), value: executor, inline: true },
  ];
  if (reason)
    fields.push({
      name: t('logging:modlog.fieldReason'),
      value: reason,
      inline: false,
    });
  fields.push({
    name: t('logging:embedFields.cacheCaptured'),
    value: String(cached.length),
    inline: true,
  });
  const authorCounts = new Map<string, number>();
  for (const m of cached) {
    const label = `${m.author} (${m.authorId})`;
    authorCounts.set(label, (authorCounts.get(label) ?? 0) + 1);
  }
  const sorted = [...authorCounts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const top = sorted.slice(0, 10);
  const others = sorted.length - top.length;
  const authorLine =
    top
      .map(([label, n]) =>
        `${label}: ${t('logging:common.countUnit', { count: String(n) })}`,
      )
      .join('\n') +
    (others > 0
      ? `\n${t('logging:common.othersCount', { count: String(others) })}`
      : '');
  fields.push({
    name: t('logging:embedFields.authorBreakdown'),
    value: authorLine || t('logging:common.none'),
    inline: false,
  });
  fields.push({
    name: t('logging:embedFields.preview'),
    value:
      cached
        .slice(0, 10)
        .map((m) => truncate(m.content, 100))
        .join('\n') || t('logging:common.none'),
    inline: false,
  });
  return {
    title: t('logging:bulkDelete.title'),
    timestamp: discordTimestamp(occurredAt),
    color: 0xe74c3c,
    fields,
  };
}
export function voiceEmbed(
  user: string,
  userId: string,
  kind: 'Join' | 'Leave' | 'Move',
  oldChannel: string | null,
  newChannel: string | null,
  occurredAt: Date,
): LogEmbed {
  const title =
    kind === 'Join'
      ? t('logging:voice.join')
      : kind === 'Leave'
        ? t('logging:voice.leave')
        : t('logging:voice.move');
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    {
      name: t('logging:embedFields.user'),
      value: `${user} (${userId})`,
      inline: true,
    },
  ];
  if (kind === 'Join')
    fields.push({
      name: t('logging:embedFields.channel'),
      value: newChannel ?? t('logging:common.unknown'),
      inline: true,
    });
  else if (kind === 'Leave')
    fields.push({
      name: t('logging:embedFields.channel'),
      value: oldChannel ?? t('logging:common.unknown'),
      inline: true,
    });
  else {
    fields.push(
      {
        name: t('logging:embedFields.moveFrom'),
        value: oldChannel ?? t('logging:common.unknown'),
        inline: true,
      },
      {
        name: t('logging:embedFields.moveTo'),
        value: newChannel ?? t('logging:common.unknown'),
        inline: true,
      },
    );
  }
  return {
    title,
    timestamp: discordTimestamp(occurredAt),
    color: 0x3498db,
    fields,
  };
}

export function moderationEmbed(input: {
  caseNumber: number;
  action: string;
  target: string;
  moderator: string;
  reason?: string;
  status: string;
  source: string;
  duration?: string;
  dm?: string;
  date: Date;
  zone: string;
}): LogEmbed {
  return {
    title: t('logging:modlog.caseTitle', {
      caseNumber: input.caseNumber,
      actionLabel: input.action,
    }),
    timestamp: discordTimestamp(input.date),
    fields: [
      { name: t('logging:modlog.fieldTarget'), value: input.target, inline: true },
      {
        name: t('logging:modlog.fieldModerator'),
        value: input.moderator,
        inline: true,
      },
      {
        name: t('logging:modlog.fieldReason'),
        value: input.reason ?? t('logging:defaultReason'),
        inline: false,
      },
      {
        name: t('logging:modlog.fieldDuration'),
        value: input.duration ?? t('logging:duration.permanent'),
        inline: true,
      },
      { name: t('logging:modlog.fieldSource'), value: input.source, inline: true },
      { name: t('logging:modlog.fieldStatus'), value: input.status, inline: true },
      {
        name: t('logging:modlog.fieldDm'),
        value: input.dm ?? t('logging:modlog.fieldDmNotApplicable'),
        inline: true,
      },
    ],
  };
}
export function serverEmbed(
  title: string,
  fields: ReadonlyArray<{ name: string; value: string; inline?: boolean }>,
  occurredAt: Date,
  color?: number,
): LogEmbed {
  const fullWidthLabels = new Set([
    t('logging:modlog.fieldReason'),
    t('logging:embedFields.before'),
    t('logging:embedFields.after'),
    t('logging:embedFields.body'),
    t('logging:embedFields.attachments'),
    t('logging:embedFields.warning'),
    t('logging:embedFields.leaveRole'),
    t('logging:embedFields.leaveReason'),
    t('logging:embedFields.preview'),
    t('logging:embedFields.authorBreakdown'),
  ]);
  return {
    title,
    timestamp: discordTimestamp(occurredAt),
    ...(color !== undefined ? { color } : {}),
    fields: fields.slice(0, 25).map((field) => ({
      name: field.name,
      value: field.value,
      inline: field.inline ?? (fullWidthLabels.has(field.name) ? false : true),
    })),
  };
}
