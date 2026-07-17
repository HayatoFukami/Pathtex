import type {
  ChatInputCommandInteraction,
  PermissionResolvable,
} from 'discord.js';
import type { CommandDefinition } from '../commands/contract.js';

export interface ModRoleSettingsPort {
  getModRoleId(guildId: string): Promise<string | null>;
  roleExists(guildId: string, roleId: string): Promise<boolean>;
  clearDeletedModRole(guildId: string, roleId: string): Promise<void>;
}
export interface PermissionPolicy {
  authorize(
    interaction: ChatInputCommandInteraction,
    command: CommandDefinition,
  ): Promise<boolean>;
  missingBotPermissions(
    interaction: ChatInputCommandInteraction,
    required: readonly PermissionResolvable[],
  ): string[];
}
const names = (permissions: readonly PermissionResolvable[]): string[] =>
  permissions.map((permission) => String(permission));

export function createPermissionPolicy(
  settings: ModRoleSettingsPort,
): PermissionPolicy {
  return {
    async authorize(interaction, command) {
      if (command.authorizationPolicy === 'PUBLIC') return true;
      const member = interaction.member;
      if (member === null || typeof member === 'string') return false;
      const permissions = interaction.memberPermissions;
      if (permissions?.has('Administrator')) return true;
      if (
        command.actorNativePermissions.some((permission) =>
          permissions?.has(permission),
        )
      )
        return true;
      if (command.authorizationPolicy === 'MANAGE_GUILD') return false;
      const guildId = interaction.guildId;
      if (guildId === null) return false;
      const roleId = await settings.getModRoleId(guildId);
      if (roleId === null) return false;
      if (!(await settings.roleExists(guildId, roleId))) {
        await settings.clearDeletedModRole(guildId, roleId);
        return false;
      }
      const roleSet = Array.isArray(member.roles)
        ? member.roles
        : [...member.roles.cache.keys()];
      if (!roleSet.includes(roleId)) return false;
      return true;
    },
    missingBotPermissions(interaction, required) {
      const guild = interaction.guild;
      const me = guild?.members.me;
      if (me === null || me === undefined) return names(required);
      const channel = interaction.channel;
      if (channel === null || !('permissionsFor' in channel))
        return names(required);
      const channels: Array<{
        permissionsFor(
          member: unknown,
        ): { has(permission: PermissionResolvable): boolean } | null;
      }> = [channel];
      if (
        'isThread' in channel &&
        channel.isThread() &&
        channel.parent !== null &&
        'permissionsFor' in channel.parent
      )
        channels.push(channel.parent);
      if (interaction.commandName === 'voicemove') {
        const target = interaction.options.getChannel('channel');
        if (target && 'permissionsFor' in target) channels.push(target);
      }
      return required
        .filter((permission) =>
          channels.some((item) => !item.permissionsFor(me)?.has(permission)),
        )
        .map((permission) => String(permission));
    },
  };
}
