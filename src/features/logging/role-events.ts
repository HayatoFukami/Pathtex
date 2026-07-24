import { discordTimestamp, type LogEmbed } from './service.js';
import { t } from '../../i18n/index.js';

export interface RoleChangeEmbedInput {
  targetDisplay: string;
  targetUserId: string;
  roleName: string;
  roleId: string;
  /** Rendered i18n label (`logging:roleChange.add`/`.remove`); typed as
   * `string` rather than a literal union so callers can pass the `t()`
   * result directly. */
  operation: string;
  executor: string;
  date: Date;
  zone: string;
}

/** Typed renderer for a single generic role-change server log record. */
export function roleChangeEmbed(input: RoleChangeEmbedInput): LogEmbed {
  const isAdd = input.operation === t('logging:roleChange.add');
  return {
    title: isAdd
      ? t('logging:roleChange.grantTitle')
      : t('logging:roleChange.revokeTitle'),
    timestamp: discordTimestamp(input.date),
    color: isAdd ? 0x2ecc71 : 0x95a5a6,
    fields: [
      {
        name: t('logging:embedFields.user'),
        value: `${input.targetDisplay} (${input.targetUserId})`,
        inline: true,
      },
      {
        name: t('logging:embedFields.role'),
        value: `${input.roleName} (${input.roleId})`,
        inline: true,
      },
      { name: t('logging:embedFields.executor'), value: input.executor, inline: true },
    ],
  };
}
