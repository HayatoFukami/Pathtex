import type { Result } from '../../domain/result.js';
import type { TargetIdentity } from '../../services/target-identity.js';

export interface VoiceIdentityResolver {
  resolve(
    guildId: string,
    userId: string,
    context?: {
      member?: { displayName?: unknown } | null;
    },
  ): Promise<TargetIdentity>;
}

export interface VoiceMember {
  readonly id: string;
  readonly bot: boolean;
  readonly channelId: string | null;
  readonly displayName?: string;
  readonly categoryId?: string | null;
}
export interface VoicePort {
  connect(guildId: string, channelId: string): Promise<void>;
  disconnect(guildId: string): Promise<void>;
  move(guildId: string, userId: string, channelId: string): Promise<void>;
  createTemporaryChannel(
    guildId: string,
    categoryId: string | null,
  ): Promise<string>;
  deleteChannel(channelId: string): Promise<void>;
  members(channelId: string): Promise<readonly VoiceMember[]>;
  member(guildId: string, userId: string): Promise<VoiceMember | null>;
  actorChannel?(
    guildId: string,
    userId: string,
  ): Promise<{ id: string } | null>;
  canViewChannel?(
    guildId: string,
    channelId: string,
    actorId: string,
  ): Promise<boolean>;
  canMoveToChannel?(
    guildId: string,
    channelId: string,
    actorId: string,
  ): Promise<boolean>;
  canKickFromChannel?(
    guildId: string,
    channelId: string,
    actorId: string,
  ): Promise<boolean>;
  canCreateTemporaryChannel?(
    guildId: string,
    categoryId: string | null,
    actorId: string,
  ): Promise<boolean>;
  validateTargetChannel?(guildId: string, channelId: string): Promise<boolean>;
  isModerator?(guildId: string, userId: string): Promise<boolean>;
  dm(userId: string, content: string): Promise<void>;
  log?(guildId: string, event: unknown): Promise<void>;
  modlog?(guildId: string, event: unknown, caseId?: string): Promise<void>;
}
export interface VoiceCasePort {
  create(input: {
    guildId: string;
    action: 'VOICEKICK';
    targetUserId: string;
    readonly identity?: TargetIdentity;
    moderatorUserId: string;
    readonly status?: 'COMPLETED' | 'PARTIAL' | 'FAILED';
    readonly errorCode?: string;
  }): Promise<{
    readonly caseId?: string;
    readonly caseNumber?: number;
  } | null>;
}
export interface VoiceOutcome {
  readonly userId: string;
  readonly identity?: TargetIdentity;
  readonly ok: boolean;
  readonly code?: string;
  readonly caseId?: string;
  readonly caseNumber?: number;
}
export interface VoiceSession {
  readonly controllerUserId: string;
  readonly botCurrentChannelId: string;
  readonly startedAt: Date;
  readonly expiresAt: Date;
}
export type VoiceResult<T> = Result<T>;
