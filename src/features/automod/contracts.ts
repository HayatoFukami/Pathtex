import type {
  AutomodRepository,
  IgnoreRepository,
} from '../../repositories/contracts.js';
import type { StrikeService } from '../strikes/strike-service.js';
import type { SnapshotService } from '../../services/snapshot-service.js';
import type { CopypastaDefinition } from './domain.js';
import type { ResourceLoader } from '../../services/resource-loader.js';

export type AutomodRuleName =
  | 'ANTI_INVITE'
  | 'ANTI_REFERRAL'
  | 'ANTI_EVERYONE'
  | 'ANTI_COPYPASTA'
  | 'MAX_USER_MENTIONS'
  | 'MAX_ROLE_MENTIONS'
  | 'MAX_LINES'
  | 'ANTI_DUPLICATE';
export interface AutomodMessage {
  readonly id: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly authorId: string;
  readonly content: string;
  readonly authorIsBot?: boolean;
  readonly webhook?: boolean;
  readonly system?: boolean;
  readonly isEdit?: boolean;
  readonly userMentions?: readonly { id: string; bot?: boolean }[];
  readonly roleMentions?: readonly string[];
  readonly everyoneMentioned?: boolean;
  readonly authorRoles?: readonly {
    id: string;
    position: number;
    permissions?: readonly string[];
  }[];
  readonly authorIsOwner?: boolean;
  readonly canManageMessages?: boolean;
  readonly canMentionEveryone?: boolean;
  readonly topic?: string | null;
  readonly parentTopic?: string | null;
  readonly attachments?: readonly (string | Record<string, unknown>)[];
  readonly embeds?: readonly {
    title?: string | null;
    description?: string | null;
  }[];
  readonly flags?: number | readonly string[] | null;
  readonly isThread?: boolean;
  readonly parentChannelId?: string | null;
}
export interface AutomodResult {
  readonly deleted: boolean;
  readonly strikes: number;
  readonly reasons: readonly string[];
  readonly rules: readonly unknown[];
  readonly warnings: readonly string[];
}
export interface AutomodDiscordPort {
  deleteMessage(channelId: string, messageId: string): Promise<void>;
  deleteMessages?(
    channelId: string,
    messageIds: readonly string[],
  ): Promise<void>;
  getChannelTopic?(channelId: string): Promise<string | null>;
  getParentTopic?(channelId: string): Promise<string | null>;
  getParentChannelId?(channelId: string): Promise<string | null>;
  getChannelCategoryId?(channelId: string): Promise<string | null>;
  getEffectiveMemberPermissions?(
    guildId: string,
    channelId: string,
    userId: string,
  ): Promise<readonly string[]>;
  listCategoryChildren?(
    guildId: string,
    categoryId: string,
  ): Promise<readonly string[]>;
  getMember(
    guildId: string,
    userId: string,
  ): Promise<{
    isOwner?: boolean;
    roleIds: readonly string[];
    canManageMessages?: boolean;
    canMentionEveryone?: boolean;
    highestRolePosition?: number;
    botRolePosition?: number;
    permissions?: readonly string[];
  } | null>;
  getInvite?(code: string): Promise<{ guildId?: string } | null>;
  getRole?(
    guildId: string,
    roleId: string,
  ): Promise<{ name: string; mentionable: boolean } | null>;
  listRoles?(
    guildId: string,
  ): Promise<
    readonly { id: string; position: number; permissions: readonly string[] }[]
  >;
  getBotRolePosition?(guildId: string): Promise<number>;
  dehoist?(guildId: string, userId: string, character: string): Promise<void>;
  getBotUserId?(guildId: string): Promise<string>;
}
export interface AutomodDependencies {
  readonly settings: AutomodRepository;
  readonly ignores?: IgnoreRepository;
  readonly punishments: { list(guildId: string): Promise<readonly unknown[]> };
  readonly strikes: Pick<StrikeService, 'autoModStrike'>;
  readonly discord: AutomodDiscordPort;
  readonly snapshots?: Pick<SnapshotService, 'saveMessage'>;
  readonly messageLog?: {
    deleted(message: AutomodMessage, reason: string): Promise<void>;
    warning?(message: AutomodMessage, warning: string): Promise<void>;
    strike?(
      message: AutomodMessage,
      details: {
        amount: number;
        evidence: readonly unknown[];
        warnings: readonly string[];
      },
    ): Promise<void>;
  };
  readonly correlation?: { add(key: string, value: { reason: string }): void };
  readonly metrics?: { increment(name: string, value?: number): void };
  readonly copypastas?: readonly CopypastaDefinition[];
  readonly referralDomains?: readonly string[];
  readonly resourceLoader?: ResourceLoader;
  readonly warning?: (guildId: string, warning: string) => void;
  readonly clock?: () => number;
}
