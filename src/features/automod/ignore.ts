import {
  SnowflakeSchema,
  type IgnoreRepository,
} from '../../repositories/contracts.js';
import { err, ok, type Result } from '../../domain/result.js';
import { t } from '../../i18n/index.js';

const permissions = new Set([
  'Administrator',
  'BanMembers',
  'ManageMessages',
  'KickMembers',
  'ManageGuild',
]);
export class IgnoreService {
  public constructor(private readonly repository: IgnoreRepository) {}
  public addRole(guildId: string, roleId: string, actor: string) {
    return this.valid(guildId, roleId)
      ? this.repository
          .setRole(guildId, roleId, actor)
          .then(() => ok(undefined))
      : Promise.resolve(err('INVALID_INPUT', 'Invalid role ID'));
  }
  public addChannel(guildId: string, channelId: string, actor: string) {
    return this.valid(guildId, channelId)
      ? this.repository
          .setChannel(guildId, channelId, actor)
          .then(() => ok(undefined))
      : Promise.resolve(err('INVALID_INPUT', 'Invalid channel ID'));
  }
  public removeRole(
    guildId: string,
    roleId: string,
    automatic = false,
  ): Promise<Result<undefined>> {
    return automatic
      ? Promise.resolve(
          err('INVALID_INPUT', t('automod:errors.autoIgnoreCannotBeRemoved')),
        )
      : this.repository.removeRole(guildId, roleId).then(() => ok(undefined));
  }
  public removeChannel(guildId: string, channelId: string) {
    return this.repository
      .removeChannel(guildId, channelId)
      .then(() => ok(undefined));
  }
  public automaticRole(
    roles: readonly {
      id: string;
      position: number;
      permissions?: readonly string[];
    }[],
    botPosition: number,
  ) {
    return roles
      .filter(
        (r) =>
          r.position >= botPosition ||
          (r.permissions ?? []).some((p) => permissions.has(p)),
      )
      .map((r) => r.id);
  }
  private valid(a: string, b: string) {
    return (
      SnowflakeSchema.safeParse(a).success &&
      SnowflakeSchema.safeParse(b).success
    );
  }
}
