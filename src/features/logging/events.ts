import { discordTimestamp, truncate, type LogEmbed } from './service.js';

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
export function messageChanged(
  before: MessageView,
  after: MessageView,
): boolean {
  return (
    before.content !== after.content ||
    JSON.stringify(before.attachments ?? []) !==
      JSON.stringify(after.attachments ?? []) ||
    JSON.stringify(before.embeds ?? []) !==
      JSON.stringify(after.embeds ?? []) ||
    JSON.stringify(before.flags ?? null) !==
      JSON.stringify(after.flags ?? null) ||
    JSON.stringify(before.mentions ?? []) !==
      JSON.stringify(after.mentions ?? []) ||
    JSON.stringify(before.roleMentions ?? []) !==
      JSON.stringify(after.roleMentions ?? [])
  );
}
export function messageEditEmbed(
  before: MessageView | null,
  after: MessageView,
  occurredAt: Date,
): LogEmbed | null {
  if (before && !messageChanged(before, after)) return null;
  return {
    title: 'メッセージ編集',
    timestamp: discordTimestamp(occurredAt),
    color: 0xf1c40f,
    author: {
      name: `${after.author} (${after.authorId})`,
      ...(after.avatarUrl ? { icon_url: after.avatarUrl } : {}),
    },
    fields: [
      {
        name: '投稿者',
        value: `${after.author} (${after.authorId})`,
        inline: true,
      },
      {
        name: 'チャンネル',
        value: `<#${after.channelId}> (${after.channelId})`,
        inline: true,
      },
      {
        name: '変更前',
        value: before
          ? truncate(before.content) || '(空)'
          : '取得できないため不明',
        inline: false,
      },
      {
        name: '変更後',
        value: truncate(after.content) || '(空)',
        inline: false,
      },
      {
        name: '添付',
        value:
          (before
            ? attachmentDelta(before.attachments ?? [], after.attachments ?? [])
            : '') || 'なし',
        inline: false,
      },
      {
        name: 'メッセージ',
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
  const oldSet = new Set(before.map((value) => JSON.stringify(value)));
  const newSet = new Set(after.map((value) => JSON.stringify(value)));
  return [
    ...after
      .filter((item) => !oldSet.has(JSON.stringify(item)))
      .map((item) => `追加: ${renderValue(item)}`),
    ...before
      .filter((item) => !newSet.has(JSON.stringify(item)))
      .map((item) => `削除: ${renderValue(item)}`),
  ].join('\n');
}
function renderValue(value: string | Record<string, unknown>): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
export function messageDeleteEmbed(
  message: MessageView | null,
  executor = '不明',
  reason = '不明',
  occurredAt: Date,
): LogEmbed {
  return {
    title: 'メッセージ削除',
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
        name: '投稿者',
        value: message ? `${message.author} (${message.authorId})` : '不明',
        inline: true,
      },
      {
        name: 'チャンネル',
        value: message
          ? `<#${message.channelId}> (${message.channelId})`
          : '不明',
        inline: true,
      },
      {
        name: 'メッセージID',
        value: message?.messageId ?? '不明',
        inline: true,
      },
      {
        name: '削除実行者',
        value: executor,
        inline: true,
      },
      {
        name: '理由',
        value: reason,
        inline: false,
      },
      {
        name: '本文',
        value: message
          ? truncate(message.content)
          : 'キャッシュに存在しないため取得できません',
        inline: false,
      },
      {
        name: '添付',
        value:
          message?.attachments && message.attachments.length > 0
            ? message.attachments.map((a) => renderValue(a)).join('\n')
            : 'なし',
        inline: false,
      },
    ],
  };
}
export function bulkDeleteEmbed(
  channelId: string,
  count: number,
  cached: readonly MessageView[],
  executor = '不明',
  occurredAt: Date,
  reason?: string,
): LogEmbed {
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: '削除件数', value: String(count), inline: true },
    {
      name: 'チャンネル',
      value: `<#${channelId}> (${channelId})`,
      inline: true,
    },
    { name: '削除実行者', value: executor, inline: true },
  ];
  if (reason) fields.push({ name: '理由', value: reason, inline: false });
  fields.push({
    name: 'キャッシュ取得',
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
    top.map(([label, n]) => `${label}: ${String(n)}件`).join('\n') +
    (others > 0 ? `\n他${String(others)}名` : '');
  fields.push({
    name: '投稿者別',
    value: authorLine || 'なし',
    inline: false,
  });
  fields.push({
    name: 'プレビュー',
    value:
      cached
        .slice(0, 10)
        .map((m) => truncate(m.content, 100))
        .join('\n') || 'なし',
    inline: false,
  });
  return {
    title: 'メッセージ一括削除',
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
      ? 'ボイス参加'
      : kind === 'Leave'
        ? 'ボイス退出'
        : 'ボイス移動';
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: 'ユーザー', value: `${user} (${userId})`, inline: true },
  ];
  if (kind === 'Join')
    fields.push({
      name: 'チャンネル',
      value: newChannel ?? '不明',
      inline: true,
    });
  else if (kind === 'Leave')
    fields.push({
      name: 'チャンネル',
      value: oldChannel ?? '不明',
      inline: true,
    });
  else {
    fields.push(
      {
        name: '移動元',
        value: oldChannel ?? '不明',
        inline: true,
      },
      {
        name: '移動先',
        value: newChannel ?? '不明',
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
    title: `ケース #${String(input.caseNumber)} — ${input.action}`,
    timestamp: discordTimestamp(input.date),
    fields: [
      { name: '対象', value: input.target, inline: true },
      { name: '実行者', value: input.moderator, inline: true },
      {
        name: '理由',
        value: input.reason ?? '理由未指定',
        inline: false,
      },
      {
        name: '期間',
        value: input.duration ?? '永続',
        inline: true,
      },
      { name: '発生元', value: input.source, inline: true },
      { name: '状態', value: input.status, inline: true },
      { name: 'DM', value: input.dm ?? '対象外', inline: true },
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
    '理由',
    '変更前',
    '変更後',
    '本文',
    '添付',
    '警告',
    '退出時ロール',
    '退出理由',
    'プレビュー',
    '投稿者別',
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
