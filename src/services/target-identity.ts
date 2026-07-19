import { z } from 'zod';
import { SnowflakeSchema } from '../repositories/contracts.js';

export const TargetDisplaySchema = z.string().transform((value, ctx) => {
  const normalized = normalizeTargetDisplay(value);
  if (normalized === null) {
    ctx.addIssue({ code: 'custom', message: 'Invalid target display name' });
    return z.NEVER;
  }
  return normalized;
});
export const TargetIdentitySchema = z
  .object({ userId: SnowflakeSchema, displayName: TargetDisplaySchema })
  .strict();
export type TargetIdentity = z.infer<typeof TargetIdentitySchema>;

const idOnly = /^\d{17,20}$/u;
const mention = /^<@!?\d{17,20}>$/u;
const decorated = /^.*\(\d{17,20}\)$/u;

/** Normalizes a raw Discord name; IDs and already-rendered identities are not names. */
export function normalizeTargetDisplay(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || Array.from(normalized).length > 128) return null;
  if (
    idOnly.test(normalized) ||
    mention.test(normalized) ||
    decorated.test(normalized)
  )
    return null;
  return normalized;
}

export function formatTargetIdentity(identity: TargetIdentity): string {
  const parsed = TargetIdentitySchema.parse(identity);
  return `${parsed.displayName} (${parsed.userId})`;
}

export function fallbackTargetIdentity(userId: string): TargetIdentity {
  return {
    userId: SnowflakeSchema.parse(userId),
    displayName: '不明なユーザー',
  };
}

export interface TargetIdentityLookupPort {
  getMember?(
    guildId: string,
    userId: string,
  ): Promise<{ displayName?: unknown } | null>;
  getUser?(
    userId: string,
  ): Promise<{ globalName?: unknown; username?: unknown } | null>;
  getSnapshot?(
    guildId: string,
    userId: string,
  ): Promise<{
    nickname?: unknown;
    globalName?: unknown;
    username?: unknown;
  } | null>;
}

export interface TargetIdentityContext {
  member?: { displayName?: unknown } | null;
}

export const UserTargetActions = [
  'KICK',
  'BAN',
  'SOFTBAN',
  'SILENTBAN',
  'UNBAN',
  'MUTE',
  'UNMUTE',
  'STRIKE',
  'PARDON',
  'VOICEKICK',
  'AUTO_PUNISHMENT',
] as const;
export function isUserTargetAction(action: string): boolean {
  return (UserTargetActions as readonly string[]).includes(action);
}

export class TargetIdentityResolver {
  public constructor(private readonly lookup: TargetIdentityLookupPort) {}

  public async resolve(
    guildId: string,
    userId: string,
    context: TargetIdentityContext = {},
  ): Promise<TargetIdentity> {
    SnowflakeSchema.parse(guildId);
    SnowflakeSchema.parse(userId);
    const accept = (candidate: unknown): TargetIdentity | null => {
      const displayName = normalizeTargetDisplay(candidate);
      return displayName ? { userId, displayName } : null;
    };
    const eventIdentity = accept(context.member?.displayName);
    if (eventIdentity) return eventIdentity;
    if (this.lookup.getMember) {
      const memberIdentity = accept(
        (await this.lookup.getMember(guildId, userId))?.displayName,
      );
      if (memberIdentity) return memberIdentity;
    }
    if (this.lookup.getUser) {
      const user = await this.lookup.getUser(userId);
      const globalIdentity = accept(user?.globalName);
      if (globalIdentity) return globalIdentity;
      const usernameIdentity = accept(user?.username);
      if (usernameIdentity) return usernameIdentity;
    }
    if (this.lookup.getSnapshot) {
      const snapshot = await this.lookup.getSnapshot(guildId, userId);
      for (const candidate of [
        snapshot?.nickname,
        snapshot?.globalName,
        snapshot?.username,
      ]) {
        const identity = accept(candidate);
        if (identity) return identity;
      }
    }
    return fallbackTargetIdentity(userId);
  }
}
