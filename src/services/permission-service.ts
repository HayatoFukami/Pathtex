import { z } from 'zod';
import { err, ok, type Result } from '../domain/result.js';
import type { Permission } from '../domain/policy.js';

export type AuthorizationPolicy = 'MODERATOR' | 'MANAGE_GUILD';
export interface PermissionVerifier {
  verify(actorId: string, guildId: string): Promise<ReadonlySet<Permission>>;
  isOwner(actorId: string, guildId: string): Promise<boolean>;
  hasModRole(actorId: string, guildId: string): Promise<boolean>;
}
const snowflake = z.string().regex(/^\d{17,20}$/u);

/** The only public authorization entry point. Grants are obtained from the verifier. */
export class PermissionService {
  public async authorize(
    verifier: PermissionVerifier,
    actorId: string,
    guildId: string,
    policy: AuthorizationPolicy,
    requiredModeratorPermission?: Permission | readonly Permission[],
  ): Promise<Result<boolean>> {
    if (
      !snowflake.safeParse(actorId).success ||
      !snowflake.safeParse(guildId).success
    )
      return err('INVALID_INPUT', 'Invalid authorization identity');
    const permissions = await verifier.verify(actorId, guildId);
    const owner = await verifier.isOwner(actorId, guildId);
    if (policy === 'MANAGE_GUILD')
      return ok(
        owner ||
          permissions.has('Administrator') ||
          permissions.has('ManageGuild'),
      );
    const required: readonly Permission[] =
      requiredModeratorPermission === undefined
        ? []
        : Array.isArray(requiredModeratorPermission)
          ? requiredModeratorPermission
          : [requiredModeratorPermission];
    return ok(
      owner ||
        permissions.has('Administrator') ||
        required.some((permission) => permissions.has(permission)) ||
        (await verifier.hasModRole(actorId, guildId)),
    );
  }
}
