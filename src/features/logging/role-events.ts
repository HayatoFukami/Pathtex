import { discordTimestamp, timestamp, type LogEmbed } from './service.js';

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
    fields: [
      { name: '日時', value: timestamp(input.date, input.zone) },
      {
        name: 'User',
        value: `${input.targetDisplay} (${input.targetUserId})`,
      },
      { name: 'Role', value: `${input.roleName} (${input.roleId})` },
      { name: 'Executor', value: input.executor },
    ],
  };
}
