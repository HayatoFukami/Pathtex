import { randomUUID } from 'node:crypto';
import type {
  Client,
  Interaction,
  ChatInputCommandInteraction,
  ButtonInteraction,
  MessageComponentInteraction,
  ModalSubmitInteraction,
} from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { Logger } from 'pino';
import type { CommandDefinition } from '../commands/contract.js';
import { InteractionDedupe } from './dedupe.js';
import type { PermissionPolicy } from './policy.js';
import { ConfigurationOverviewError } from '../features/configuration/service.js';
import { isUnauthorized } from '../features/logging/adapters.js';
import { t } from '../i18n/index.js';

export interface IntakeOptions {
  readonly ready: () => boolean;
  readonly dedupe?: InteractionDedupe;
  readonly logger?: Logger;
  readonly permissionPolicy: PermissionPolicy;
  readonly drainTimeoutMs?: number;
  readonly onFatal?: (error: Error) => void;
  readonly onComponent?: (
    interaction: MessageComponentInteraction,
  ) => Promise<boolean>;
  readonly onConfigurationComponent?: (
    interaction: MessageComponentInteraction,
  ) => Promise<boolean>;
  readonly onConfigurationModal?: (
    interaction: ModalSubmitInteraction,
  ) => Promise<boolean>;
}

const tokenFailure = (error: unknown): boolean => {
  const code = (error as { code?: number }).code;
  return code === 10062 || code === 10015;
};
const safeErrorMessage = (error: unknown): string | undefined => {
  if (!(error instanceof Error)) return undefined;
  return error.message
    .replace(
      /(?:discord[_ -]?token|database_url|password|secret|authorization|bearer)\s*[:=]\s*\S+/giu,
      '[REDACTED]',
    )
    .replace(/postgres(?:ql)?:\/\/\S+/giu, '[REDACTED]')
    .slice(0, 500);
};
const errorDiagnostics = (
  error: unknown,
): {
  errorMessage?: string;
  dependency?: string;
  causeName?: string;
  causeMessage?: string;
} => {
  const diagnostics: {
    errorMessage?: string;
    dependency?: string;
    causeName?: string;
    causeMessage?: string;
  } = {};
  const errorMessage = safeErrorMessage(error);
  if (errorMessage !== undefined) diagnostics.errorMessage = errorMessage;
  if (error instanceof ConfigurationOverviewError) {
    diagnostics.dependency = error.dependency;
    const cause = error.cause;
    if (cause instanceof Error) {
      diagnostics.causeName = cause.name;
      const causeMessage = safeErrorMessage(cause);
      if (causeMessage !== undefined) diagnostics.causeMessage = causeMessage;
    }
  }
  return diagnostics;
};
const replyError = async (
  interaction: ChatInputCommandInteraction,
  correlationId: string,
): Promise<void> => {
  if (interaction.deferred)
    await interaction.editReply({
      content: t('system:intake.processingError', { correlationId }),
    });
  else if (interaction.replied)
    await interaction.followUp({
      content: t('system:intake.processingError', { correlationId }),
      ephemeral: true,
    });
  else
    await interaction.reply({
      content: t('system:intake.processingError', { correlationId }),
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
  // Routes a direct or cause-wrapped Discord HTTP 401 to the fatal handler so an
  // authentication failure surfaced from any interaction path (command,
  // component, modal, autocomplete) shuts the runtime down instead of being
  // merely logged. Non-auth errors are left to the caller's logging.
  const routeFatal = (error: unknown): void => {
    if (isUnauthorized(error))
      options.onFatal?.(
        error instanceof Error ? error : new Error('Discord HTTP 401'),
      );
  };
  const handleAutocomplete = (raw: Interaction): void => {
    if (!accepting || !options.ready() || !raw.isAutocomplete()) return;
    const command = byName.get(raw.commandName);
    if (!command?.autocomplete) return;
    const task = command.autocomplete(raw).catch((error: unknown) => {
      options.logger?.error(
        {
          event: 'interaction.autocomplete',
          errorName: error instanceof Error ? error.name : 'unknown',
          ...errorDiagnostics(error),
        },
        'Autocomplete failed',
      );
      routeFatal(error);
    });
    active.add(task);
    void task.finally(() => active.delete(task)).catch(() => undefined);
  };
  const handleAuditComponent = (interaction: ButtonInteraction): void => {
    if (!accepting || !options.ready() || !interaction.inGuild()) return;
    const componentHandler = options.onComponent;
    const parts = interaction.customId.split(':');
    if (parts[0] !== 'audit') return;
    if (
      (parts[1] !== 'next' && parts[1] !== 'previous') ||
      parts.length !== 4 ||
      parts[3] !== interaction.user.id
    )
      return;
    // Dedupe a redelivered component interaction so pagination is not applied
    // twice for the same interaction ID.
    if (!dedupe.accept(interaction.id)) return;
    const task = (async () => {
      if (Date.now() - interaction.message.createdTimestamp > 15 * 60 * 1000) {
        await interaction.reply({
          content: t('system:intake.componentExpired'),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (!componentHandler || !(await componentHandler(interaction)))
        await interaction.reply({
          content: t('system:intake.componentUnavailable'),
          flags: MessageFlags.Ephemeral,
        });
    })().catch((error: unknown) => {
      options.logger?.error(
        {
          event: 'interaction.component',
          errorName: error instanceof Error ? error.name : 'unknown',
          ...errorDiagnostics(error),
        },
        'Component failed',
      );
      routeFatal(error);
    });
    active.add(task);
    void task.finally(() => active.delete(task)).catch(() => undefined);
  };
  const handleConfiguration = (
    interaction: MessageComponentInteraction | ModalSubmitInteraction,
  ): void => {
    if (!accepting || !options.ready() || !interaction.inGuild()) return;
    const configurationHandler = options.onConfigurationComponent;
    const modalHandler = options.onConfigurationModal;
    // Dedupe a redelivered configuration component/modal so a dashboard action
    // is never applied twice for the same interaction ID.
    if (!dedupe.accept(interaction.id)) return;
    const task = (async () => {
      const handled = interaction.isModalSubmit()
        ? modalHandler
          ? await modalHandler(interaction)
          : false
        : configurationHandler
          ? await configurationHandler(interaction)
          : false;
      if (!handled)
        await interaction.reply({
          content: t('system:intake.componentUnavailable'),
          flags: MessageFlags.Ephemeral,
        });
    })().catch((error: unknown) => {
      options.logger?.error(
        {
          event: 'interaction.component',
          errorName: error instanceof Error ? error.name : 'unknown',
          ...errorDiagnostics(error),
        },
        'Component failed',
      );
      routeFatal(error);
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
    const component = Reflect.get(raw, 'isMessageComponent');
    if (typeof component === 'function' && component.call(raw)) {
      const messageComponent = raw as MessageComponentInteraction;
      if (messageComponent.customId.startsWith('cfg1.')) {
        handleConfiguration(messageComponent);
        return;
      }
      if (messageComponent.isButton()) handleAuditComponent(messageComponent);
      return;
    }
    const modal = Reflect.get(raw, 'isModalSubmit');
    if (
      typeof modal === 'function' &&
      modal.call(raw) &&
      (raw as ModalSubmitInteraction).customId.startsWith('cfg1.')
    ) {
      handleConfiguration(raw as ModalSubmitInteraction);
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
          content: t('system:intake.guildOnly', { correlationId }),
          ephemeral: true,
        });
        return;
      }
      if (command === undefined) {
        await interaction.reply({
          content: t('system:intake.commandUnauthorized', { correlationId }),
          ephemeral: true,
        });
        return;
      }
      const policy = command.permissionPolicy ?? options.permissionPolicy;
      if (!(await policy.authorize(interaction, command))) {
        await interaction.reply({
          content: t('system:intake.commandUnauthorized', { correlationId }),
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
          content: t('system:intake.missingBotPermissions', {
            missing: missing.join(', '),
            correlationId,
          }),
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
          ...errorDiagnostics(error),
        },
        'Interaction failed',
      );
      if (tokenFailure(error)) return;
      if (isUnauthorized(error)) {
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
            ...errorDiagnostics(responseError),
          },
          'Interaction response failed',
        );
        if (isUnauthorized(responseError))
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
