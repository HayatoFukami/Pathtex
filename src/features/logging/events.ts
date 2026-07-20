import {
  discordTimestamp,
  truncate,
  timestamp,
  type LogEmbed,
} from './service.js';

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
  zone: string,
): LogEmbed | null {
  if (before && !messageChanged(before, after)) return null;
  return {
    title: 'メッセージ編集',
    timestamp: discordTimestamp(after.createdAt),
    fields: [
      { name: '日時', value: timestamp(after.createdAt, zone) },
      { name: '投稿者', value: `${after.author} (${after.authorId})` },
      {
        name: 'チャンネル',
        value: `<#${after.channelId}> (${after.channelId})`,
      },
      {
        name: 'Before',
        value: before
          ? truncate(before.content) || '(empty)'
          : '取得できないため不明',
      },
      { name: 'After', value: truncate(after.content) || '(empty)' },
      {
        name: 'Attachments',
        value:
          (before
            ? attachmentDelta(before.attachments ?? [], after.attachments ?? [])
            : '') || 'なし',
      },
      {
        name: 'Embeds',
        value:
          (after.embeds ?? []).slice(0, 10).map(renderValue).join('\n') ||
          'なし',
      },
      { name: 'Message', value: after.url ?? after.messageId },
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
  deletedAt: Date,
  zone: string,
  executor = '不明',
  reason = '不明',
): LogEmbed {
  return {
    title: 'メッセージ削除',
    timestamp: discordTimestamp(deletedAt),
    fields: [
      { name: '日時', value: timestamp(deletedAt, zone) },
      {
        name: '投稿者',
        value: message ? `${message.author} (${message.authorId})` : '不明',
      },
      {
        name: 'チャンネル',
        value: message
          ? `<#${message.channelId}> (${message.channelId})`
          : '不明',
      },
      {
        name: '本文',
        value: message
          ? truncate(message.content)
          : 'キャッシュに存在しないため取得できません',
      },
      { name: 'Message ID', value: message?.messageId ?? '不明' },
      { name: '削除実行者', value: executor },
      { name: '削除理由', value: reason },
    ],
  };
}
export function bulkDeleteEmbed(
  channelId: string,
  count: number,
  cached: readonly MessageView[],
  deletedAt: Date,
  zone: string,
  executor = '不明',
  reason?: string,
): LogEmbed {
  const fields: Array<{ name: string; value: string }> = [
    { name: '削除件数', value: String(count) },
    { name: 'チャンネル', value: `<#${channelId}> (${channelId})` },
    { name: '実行者', value: executor },
  ];
  if (reason) fields.push({ name: '理由', value: reason });
  fields.push(
    { name: 'キャッシュ取得件数', value: String(cached.length) },
    {
      name: '本文プレビュー',
      value:
        cached
          .slice(0, 10)
          .map((m) => truncate(m.content, 200))
          .join('\n') || 'なし',
    },
  );
  return {
    title: 'メッセージ一括削除',
    timestamp: discordTimestamp(deletedAt),
    fields: [{ name: '日時', value: timestamp(deletedAt, zone) }, ...fields],
  };
}
export function voiceEmbed(
  user: string,
  userId: string,
  kind: 'Join' | 'Leave' | 'Move',
  oldChannel: string | null,
  newChannel: string | null,
  date: Date,
  zone: string,
): LogEmbed {
  const fields = [{ name: 'User', value: `${user} (${userId})` }];
  if (kind === 'Join')
    fields.push({ name: '参加先', value: newChannel ?? '不明' });
  else if (kind === 'Leave')
    fields.push({ name: '退出元', value: oldChannel ?? '不明' });
  else {
    fields.push(
      { name: '移動元', value: oldChannel ?? '不明' },
      { name: '移動先', value: newChannel ?? '不明' },
    );
  }
  return {
    title: `ボイス${kind}`,
    timestamp: discordTimestamp(date),
    fields: [{ name: '日時', value: timestamp(date, zone) }, ...fields],
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
    title: `Case #${String(input.caseNumber)} — ${input.action}`,
    timestamp: discordTimestamp(input.date),
    fields: [
      { name: '日時', value: timestamp(input.date, input.zone) },
      { name: 'Target', value: input.target },
      { name: 'Moderator', value: input.moderator },
      { name: 'Reason', value: input.reason ?? '理由未指定' },
      { name: 'Duration', value: input.duration ?? 'Permanent' },
      { name: 'Source', value: input.source },
      { name: 'Status', value: input.status },
      { name: 'DM', value: input.dm ?? '対象外' },
    ],
  };
}
export function serverEmbed(
  title: string,
  fields: ReadonlyArray<{ name: string; value: string }>,
  date: Date,
  zone: string,
): LogEmbed {
  return {
    title,
    timestamp: discordTimestamp(date),
    fields: [
      { name: '日時', value: timestamp(date, zone) },
      ...fields
        .slice(0, 24)
        .map((field) => ({ name: field.name, value: field.value })),
    ],
  };
}
