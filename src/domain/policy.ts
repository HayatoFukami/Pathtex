import { z } from 'zod';
import { err, ok } from './result.js';
import type { Result } from './result.js';

export const permissionSchema = z.enum([
  'Administrator',
  'ManageGuild',
  'KickMembers',
  'BanMembers',
  'ManageRoles',
  'ManageMessages',
  'ManageChannels',
  'MoveMembers',
  'ViewAuditLog',
  'ManageNicknames',
  'MentionEveryone',
]);
export type Permission = z.infer<typeof permissionSchema>;
export type PermissionSet = ReadonlySet<Permission>;
const snowflake = z.string().regex(/^\d{17,20}$/u);
const actionSchema = z.enum(['MODERATION', 'STRIKE', 'PARDON']);
export function isModerator(
  input: unknown,
  required: Permission | readonly Permission[],
  owner = false,
  modRole = false,
): Result<boolean> {
  const parsed = z
    .object({
      permissions: z.array(permissionSchema),
      owner: z.boolean().optional(),
      modRole: z.boolean().optional(),
    })
    .safeParse(input);
  if (!parsed.success) return err('INVALID_INPUT', 'Invalid permission input');
  const requested = Array.isArray(required) ? required : [required];
  const needed = requested.filter(
    (permission): permission is Permission =>
      permissionSchema.safeParse(permission).success,
  );
  if (needed.length !== requested.length)
    return err('INVALID_INPUT', 'Invalid required permission');
  return ok(
    owner ||
      modRole ||
      parsed.data.owner === true ||
      parsed.data.modRole === true ||
      parsed.data.permissions.includes('Administrator') ||
      needed.some((p) => parsed.data.permissions.includes(p)),
  );
}
export function canManageMember(input: unknown): Result<boolean> {
  const schema = z.object({
    actorId: snowflake,
    targetId: snowflake,
    botId: snowflake,
    botTopRole: z.number().int(),
    targetTopRole: z.number().int(),
    actorTopRole: z.number().int(),
    botTopRoleId: snowflake,
    targetTopRoleId: snowflake,
    actorTopRoleId: snowflake,
    owner: z.boolean(),
    targetOwner: z.boolean(),
    targetBot: z.boolean().optional(),
    action: actionSchema.default('MODERATION'),
  });
  const parsed = schema.safeParse(input);
  if (!parsed.success) return err('INVALID_INPUT', 'Invalid hierarchy input');
  const v = parsed.data;
  if (v.targetOwner && v.action !== 'STRIKE' && v.action !== 'PARDON')
    return ok(false);
  if (v.targetBot === true && v.targetId === v.botId) return ok(false);
  if (v.actorId === v.targetId) return ok(false);
  const compareRole = (
    position: number,
    id: string,
    otherPosition: number,
    otherId: string,
  ) => (position === otherPosition ? id > otherId : position > otherPosition);
  const botAboveTarget = compareRole(
    v.botTopRole,
    v.botTopRoleId,
    v.targetTopRole,
    v.targetTopRoleId,
  );
  const actorAboveTarget = compareRole(
    v.actorTopRole,
    v.actorTopRoleId,
    v.targetTopRole,
    v.targetTopRoleId,
  );
  return ok(
    botAboveTarget &&
      (v.owner ||
        actorAboveTarget ||
        v.action === 'STRIKE' ||
        v.action === 'PARDON'),
  );
}
