import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  PermissionResolvable,
} from 'discord.js';
import type { PermissionPolicy } from '../runtime/policy.js';

export type AuthorizationPolicy = 'PUBLIC' | 'MODERATOR' | 'MANAGE_GUILD';
export type DeferMode = 'NONE' | 'EPHEMERAL' | 'PUBLIC';

export interface CommandContext {
  readonly interaction: ChatInputCommandInteraction;
  readonly receivedAt: number;
}

export interface CommandDefinition {
  readonly data: Record<string, unknown>;
  readonly name: string;
  readonly guildOnly: true;
  readonly requiredBotPermissions: readonly PermissionResolvable[];
  readonly actorNativePermissions: readonly PermissionResolvable[];
  readonly authorizationPolicy: AuthorizationPolicy;
  readonly deferMode: DeferMode;
  readonly permissionPolicy?: PermissionPolicy;
  execute(context: CommandContext): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction): Promise<void>;
}
