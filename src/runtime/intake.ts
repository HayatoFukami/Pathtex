import { randomUUID } from 'node:crypto';
import type {
  Client,
  Interaction,
  ChatInputCommandInteraction,
  ButtonInteraction,
} from 'discord.js';
import type { Logger } from 'pino';
import type { CommandDefinition } from '../commands/contract.js';
import { InteractionDedupe } from './dedupe.js';
import type { PermissionPolicy } from './policy.js';

export interface IntakeOptions {
  readonly ready: () => boolean;
  readonly dedupe?: InteractionDedupe;
  readonly logger?: Logger;
  readonly permissionPolicy: PermissionPolicy;
  readonly drainTimeoutMs?: number;
  readonly onFatal?: (error: Error) => void;
  readonly onComponent?: (interaction: ButtonInteraction) => Promise<boolean>;
}

const tokenFailure = (error: unknown): boolean => {
  const code = (error as { code?: number }).code;
  return code === 10062 || code === 10015;
};
const httpAuthFailure = (error: unknown): boolean =>
  (error as { status?: number; code?: number }).status === 401 ||
  (error as { code?: number }).code === 401;
const replyError = async (
  interaction: ChatInputCommandInteraction,
  correlationId: string,
): Promise<void> => {
  if (interaction.deferred)
    await interaction.editReply({
      content: `処理中にエラーが発生しました。\n参照ID: ${correlationId}`,
    });
  else if (interaction.replied)
    await interaction.followUp({
      content: `処理中にエラーが発生しました。\n参照ID: ${correlationId}`,
      ephemeral: true,
    });
  else
    await interaction.reply({
      content: `処理中にエラーが発生しました。\n参照ID: ${correlationId}`,
      ephemeral: true,
    });
};

export type IntakeStop = (() => void) & {
  drain(): Promise<void>;
  stopAccepting(): void;
};
export function installInteractionIntake(
  client: Client,
  commands: readonly CommandDefinition[],
  options: IntakeOptions,
): IntakeStop {
  const byName = new Map(commands.map((command) => [command.name, command]));
  const dedupe = options.dedupe ?? new InteractionDedupe();
  let accepting = true;
  const active = new Set<Promise<void>>();
  const handleAutocomplete = (raw: Interaction): void => {
    if (!accepting || !options.ready() || !raw.isAutocomplete()) return;
    const command = byName.get(raw.commandName);
    if (!command?.autocomplete) return;
    const task = command.autocomplete(raw).catch((error: unknown) => {
      options.logger?.error(
        {
          event: 'interaction.autocomplete',
          errorName: error instanceof Error ? error.name : 'unknown',
        },
        'Autocomplete failed',
      );
    });
    active.add(task);
    void task.finally(() => active.delete(task)).catch(() => undefined);
  };
  const handleComponent = (interaction: ButtonInteraction): void => {
    if (!accepting || !options.ready() || !interaction.inGuild()) return;
    const parts = interaction.customId.split(':');
    if (
      parts[0] !== 'audit' ||
      (parts[1] !== 'next' && parts[1] !== 'previous') ||
      parts.length !== 4 ||
      parts[3] !== interaction.user.id
    )
      return;
    const task = (async () => {
      if (Date.now() - interaction.message.createdTimestamp > 15 * 60 * 1000) {
        await interaction.reply({
          content: 'このページは期限切れです。',
          ephemeral: true,
        });
        return;
      }
      if (!options.onComponent || !(await options.onComponent(interaction)))
        await interaction.reply({
          content: 'この操作は利用できません。',
          ephemeral: true,
        });
    })().catch((error: unknown) => {
      options.logger?.error(
        {
          event: 'interaction.component',
          errorName: error instanceof Error ? error.name : 'unknown',
        },
        'Component failed',
      );
    });
    active.add(task);
    void task.finally(() => active.delete(task)).catch(() => undefined);
  };
  const handler = (raw: Interaction): void => {
    const autocomplete = Reflect.get(raw, 'isAutocomplete');
    if (typeof autocomplete === 'function' && autocomplete.call(raw)) {
      handleAutocomplete(raw);
      return;
    }
    const button = Reflect.get(raw, 'isButton');
    if (typeof button === 'function' && button.call(raw)) {
      handleComponent(raw as ButtonInteraction);
      return;
    }
    if (
      !accepting ||
      !options.ready() ||
      (!raw.isChatInputCommand() && !raw.isButton() && !raw.isAutocomplete()) ||
      !dedupe.accept(raw.id)
    )
      return;
    const interaction = raw;
    if (!interaction.isChatInputCommand()) return;
    const receivedAt = Date.now();
    const command = byName.get(interaction.commandName);
    const correlationId = randomUUID();
    const metadata = {
      event: 'interaction.execute',
      correlationId,
      interactionId: interaction.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      command: interaction.commandName,
    };
    const run = async (): Promise<void> => {
      if (!interaction.inGuild()) {
        await interaction.reply({
          content: `このコマンドはギルド内でのみ使用できます。\n参照ID: ${correlationId}`,
          ephemeral: true,
        });
        return;
      }
      if (command === undefined) {
        await interaction.reply({
          content: `このコマンドを実行する権限がありません。\n参照ID: ${correlationId}`,
          ephemeral: true,
        });
        return;
      }
      const policy = command.permissionPolicy ?? options.permissionPolicy;
      if (!(await policy.authorize(interaction, command))) {
        await interaction.reply({
          content: `このコマンドを実行する権限がありません。\n参照ID: ${correlationId}`,
          ephemeral: true,
        });
        return;
      }
      const missing = policy.missingBotPermissions(
        interaction,
        command.requiredBotPermissions,
      );
      if (missing.length > 0) {
        await interaction.reply({
          content: `Botに必要な権限がありません: ${missing.join(', ')}\n参照ID: ${correlationId}`,
          ephemeral: true,
        });
        return;
      }
      if (command.deferMode !== 'NONE')
        await interaction.deferReply({
          ephemeral: command.deferMode === 'EPHEMERAL',
        });
      await command.execute({ interaction, receivedAt });
    };
    const task = run().catch(async (error: unknown) => {
      options.logger?.error(
        {
          ...metadata,
          errorName: tokenFailure(error)
            ? 'expired_interaction_token'
            : error instanceof Error
              ? error.name
              : 'unknown',
        },
        'Interaction failed',
      );
      if (tokenFailure(error)) return;
      if (httpAuthFailure(error)) {
        options.onFatal?.(
          error instanceof Error ? error : new Error('Discord HTTP 401'),
        );
        return;
      }
      try {
        await replyError(interaction, correlationId);
      } catch (responseError: unknown) {
        options.logger?.error(
          {
            ...metadata,
            errorName: tokenFailure(responseError)
              ? 'expired_interaction_token'
              : 'response_failed',
          },
          'Interaction response failed',
        );
        if (httpAuthFailure(responseError))
          options.onFatal?.(
            responseError instanceof Error
              ? responseError
              : new Error('Discord HTTP 401'),
          );
      }
    });
    active.add(task);
    void task.finally(() => active.delete(task)).catch(() => undefined);
  };
  client.on('interactionCreate', handler);
  const stop = (() => {
    accepting = false;
    client.off('interactionCreate', handler);
  }) as IntakeStop;
  stop.stopAccepting = () => {
    accepting = false;
    client.off('interactionCreate', handler);
  };
  stop.drain = async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled(active),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, options.drainTimeoutMs ?? 15_000);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  return stop;
}
