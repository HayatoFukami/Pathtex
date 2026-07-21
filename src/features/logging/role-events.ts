import { discordTimestamp, type LogEmbed } from './service.js';

export interface RoleChangeEmbedInput {
  targetDisplay: string;
  targetUserId: string;
  roleName: string;
  roleId: string;
  operation: '追加' | '削除';
  executor: string;
  date: Date;
  zone: string;
}

/** Typed renderer for a single generic role-change server log record. */
export function roleChangeEmbed(input: RoleChangeEmbedInput): LogEmbed {
  return {
    title: input.operation === '追加' ? 'ロール付与' : 'ロール除去',
    timestamp: discordTimestamp(input.date),
    color: input.operation === '追加' ? 0x2ecc71 : 0x95a5a6,
    fields: [
      {
        name: 'ユーザー',
        value: `${input.targetDisplay} (${input.targetUserId})`,
        inline: true,
      },
      {
        name: 'ロール',
        value: `${input.roleName} (${input.roleId})`,
        inline: true,
      },
      { name: '実行者', value: input.executor, inline: true },
    ],
  };
}
