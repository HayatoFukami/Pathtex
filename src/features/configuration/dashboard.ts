import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ContainerBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  RoleSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  type MessageComponentInteraction,
  type MessageEditOptions,
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { ConfigurationService, LogKind } from './service.js';

const DASHBOARD_TTL_MS = 15 * 60 * 1000;
const LOG_KINDS: readonly LogKind[] = [
  'message',
  'moderation',
  'server',
  'voice',
];
const LOG_LABELS: Record<LogKind, string> = {
  message: 'メッセージ',
  moderation: 'モデレーション',
  server: 'サーバー',
  voice: 'ボイス',
};
const isComponent = (
  interaction: ConfigurationInteraction,
): interaction is MessageComponentInteraction =>
  interaction.isMessageComponent();

export type ConfigurationPage = 'home' | 'logs' | 'access';
export type ConfigurationAction =
  | 'refresh'
  | 'setup'
  | 'nav-home'
  | 'nav-logs'
  | 'nav-access'
  | 'role-clear'
  | 'timezone-open'
  | 'timezone-submit'
  | `channel-${LogKind}`
  | 'role-select';
export type ConfigurationInteraction =
  MessageComponentInteraction | ModalSubmitInteraction;

export interface ConfigurationComponentAuthorization {
  authorize(interaction: ConfigurationInteraction): Promise<boolean>;
}

/** Runtime resolves the selected role from the guild cache/API and returns slash-command metadata. */
export interface ConfigurationRoleMetadata {
  readonly id: string;
  readonly managed: boolean;
  readonly everyone: boolean;
  readonly botIntegration: boolean;
}
export interface ConfigurationRoleResolutionPort {
  resolveRole(
    guildId: string,
    roleId: string,
  ): Promise<ConfigurationRoleMetadata | null>;
}

export interface ConfigurationComponentHandlerOptions {
  readonly service: ConfigurationService;
  readonly authorization: ConfigurationComponentAuthorization;
  /** Required for MOD-role selection; omitted wiring disables that action safely. */
  readonly roles?: ConfigurationRoleResolutionPort;
  /** Preserve original Result failures for structured logging; never display them. */
  readonly reportFailure?: (error: unknown) => void;
  /** Return missing Discord permissions before setup is acknowledged. */
  readonly setupPermissionPreflight?: (
    interaction: MessageComponentInteraction,
  ) => Promise<readonly string[]>;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

export interface ConfigurationDashboardContext {
  readonly guildId: string;
  readonly actorId: string;
  readonly now?: number;
  readonly ttlMs?: number;
  readonly page?: ConfigurationPage;
  readonly status?: string;
}

const base36 = (value: string): string => BigInt(value).toString(36);
const fromBase36 = (value: string): string | null => {
  if (!/^[0-9a-z]+$/.test(value)) return null;
  try {
    let result = 0n;
    for (const character of value) {
      const digit = Number.parseInt(character, 36);
      if (!Number.isInteger(digit)) return null;
      result = result * 36n + BigInt(digit);
    }
    return result.toString();
  } catch {
    return null;
  }
};

export function createConfigurationCustomId(
  action: ConfigurationAction,
  guildId: string,
  actorId: string,
  now = Date.now(),
  ttlMs = DASHBOARD_TTL_MS,
): string {
  const expiry = Math.floor((now + ttlMs) / 1000);
  return `cfg1.${action}.${base36(guildId)}.${base36(actorId)}.${expiry.toString(36)}`;
}

export function parseConfigurationCustomId(value: string): {
  action: ConfigurationAction;
  guildId: string;
  actorId: string;
  expiresAt: number;
} | null {
  const parts = value.split('.');
  if (parts.length !== 5 || parts[0] !== 'cfg1') return null;
  const action = parts[1];
  if (
    action !== 'refresh' &&
    action !== 'setup' &&
    !/^(?:nav-(?:home|logs|access)|role-clear|timezone-open|timezone-submit|channel-(?:message|moderation|server|voice)|role-select)$/.test(
      action ?? '',
    )
  )
    return null;
  const guildId = fromBase36(parts[2] ?? '');
  const actorId = fromBase36(parts[3] ?? '');
  if (
    !guildId ||
    !actorId ||
    !/^\d{17,20}$/.test(guildId) ||
    !/^\d{17,20}$/.test(actorId) ||
    !/^[0-9a-z]+$/.test(parts[4] ?? '')
  )
    return null;
  const expiresAt = Number.parseInt(parts[4] ?? '', 36) * 1000;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return null;
  return { action: action as ConfigurationAction, guildId, actorId, expiresAt };
}

const text = (content: string): TextDisplayBuilder =>
  new TextDisplayBuilder().setContent(content);
const actionId = (
  action: ConfigurationAction,
  context: ConfigurationDashboardContext,
): string =>
  createConfigurationCustomId(
    action,
    context.guildId,
    context.actorId,
    context.now,
    context.ttlMs,
  );
const button = (
  action: ConfigurationAction,
  label: string,
  context: ConfigurationDashboardContext,
  style = ButtonStyle.Secondary,
): ButtonBuilder =>
  new ButtonBuilder()
    .setCustomId(actionId(action, context))
    .setLabel(label)
    .setStyle(style);

/** Keeps complete entries intact while leaving room for a clear omission marker. */
function boundedEntries(entries: readonly string[], limit = 3600): string {
  const shown: string[] = [];
  let omitted = 0;
  for (const entry of entries) {
    const candidate = [...shown, entry].join('\n');
    if (candidate.length <= limit) shown.push(entry);
    else omitted++;
  }
  if (omitted === 0) return shown.join('\n');
  while (
    shown.length > 0 &&
    [...shown, `…他${String(omitted)}件`].join('\n').length > limit
  ) {
    shown.pop();
    omitted++;
  }
  return [...shown, `…他${String(omitted)}件`].join('\n');
}

function boundedSection(
  heading: string,
  entries: readonly string[],
  count: number,
  limit = 3600,
): string {
  return `${heading}（${String(count)}件）\n${boundedEntries(entries, limit)}`;
}

function channelSelector(
  kind: LogKind,
  context: ConfigurationDashboardContext,
  configuredChannelId: unknown,
): ChannelSelectMenuBuilder {
  const selector = new ChannelSelectMenuBuilder()
    .setCustomId(actionId(`channel-${kind}`, context))
    .setPlaceholder(`${LOG_LABELS[kind]}ログのチャンネルを選択`)
    .setMinValues(1)
    .setMaxValues(1)
    .setChannelTypes([0, 5]);
  if (
    typeof configuredChannelId === 'string' &&
    /^\d{17,20}$/.test(configuredChannelId)
  )
    selector.setDefaultChannels(configuredChannelId);
  return selector;
}

function details(overview: Record<string, unknown>): TextDisplayBuilder[] {
  const settings = (overview.settings ?? {}) as Record<string, unknown>;
  const mention = (key: string, prefix: string): string =>
    typeof settings[key] === 'string' ? `${prefix}${settings[key]}>` : '未設定';
  const list = (key: string): string[] =>
    Array.isArray(overview[key])
      ? overview[key].filter((item): item is string => typeof item === 'string')
      : [];
  const recordList = (key: string): Array<Record<string, unknown>> =>
    Array.isArray(overview[key])
      ? overview[key].filter(
          (item): item is Record<string, unknown> =>
            typeof item === 'object' && item !== null,
        )
      : [];
  const identity = (kind: 'role' | 'channel', id: unknown): string => {
    if (typeof id !== 'string') return '不明';
    return kind === 'role' ? `<@&${id}>` : `<#${id}>`;
  };
  const automod = overview.automod as Record<string, unknown> | null;
  const numberOrDash = (key: string): string => {
    const value = automod?.[key];
    return typeof value === 'number' ? String(value) : '—';
  };
  const automodStatus = automod
    ? `Invite ${numberOrDash('antiInviteStrikes')} / Referral ${numberOrDash('antiReferralStrikes')} / Everyone ${numberOrDash('antiEveryoneStrikes')} / Copypasta ${numberOrDash('antiCopypastaStrikes')}\nMention ${numberOrDash('maxUserMentions')} users・${numberOrDash('maxRoleMentions')} roles / Lines ${numberOrDash('maxLines')}\nDuplicate ${automod.duplicateEnabled === true ? `ON（削除 ${numberOrDash('duplicateDeleteThreshold')}・警告 ${numberOrDash('duplicateStrikeThreshold')}・加算 ${numberOrDash('duplicateStrikes')}）` : 'OFF'} / Dehoist ${typeof automod.autodehoistCharacter === 'string' ? automod.autodehoistCharacter : 'OFF'}`
    : '未初期化';
  const autoRaid =
    automod?.autoRaidEnabled === true
      ? `有効（${numberOrDash('autoRaidJoinCount')}人 / ${numberOrDash('autoRaidWindowSeconds')}秒）`
      : '無効';
  const settingsRaid =
    settings.raidModeEnabled === true
      ? `有効（${typeof settings.raidModeSource === 'string' ? settings.raidModeSource : '手動'}）`
      : '無効';
  const punishments = recordList('punishments');
  const explicitRoles = recordList('ignoredRoles');
  const explicitChannels = recordList('ignoredChannels');
  const automaticIgnore = list('automaticIgnoredRoles');
  const warnings = [...list('botWarnings'), ...list('resourceWarnings')];
  const punishmentEntries = punishments.map((item) => {
    const threshold =
      typeof item.threshold === 'number' || typeof item.threshold === 'string'
        ? String(item.threshold)
        : '?';
    const action = typeof item.action === 'string' ? item.action : '?';
    const duration =
      typeof item.durationSeconds === 'number'
        ? `（${String(item.durationSeconds)}秒）`
        : '';
    return `${threshold}→${action}${duration}`;
  });
  const explicitIgnoreText = [
    ...explicitRoles.map((item) => identity('role', item.roleId)),
    ...explicitChannels.map((item) => identity('channel', item.channelId)),
  ];
  return [
    text(
      `### ログの状態\nメッセージ：${mention('messageLogChannelId', '<#')}\nモデレーション：${mention('modlogChannelId', '<#')}\nサーバー：${mention('serverLogChannelId', '<#')}\nボイス：${mention('voiceLogChannelId', '<#')}`,
    ),
    text(
      `### 基本設定\nMODロール：${mention('modRoleId', '<@&')}\nMutedロール：${mention('mutedRoleId', '<@&')}\nタイムゾーン：${typeof settings.timezone === 'string' ? settings.timezone : 'UTC'}`,
    ),
    text(
      `### 自動化と制裁\nRaidMode：${settingsRaid}\nAutoRaid：${autoRaid}\nAutoMod：${automodStatus}\n${boundedSection('Punishment', punishmentEntries, punishments.length)}`,
    ),
    text(
      `### Ignore\n${boundedSection('明示', explicitIgnoreText, explicitIgnoreText.length, 1700)}\n${boundedSection(
        '自動',
        automaticIgnore.map((id) => identity('role', id)),
        automaticIgnore.length,
        1700,
      )}`,
    ),
    ...(warnings.length > 0
      ? [text(`⚠️ ### 確認が必要\n${boundedEntries(warnings)}`)]
      : []),
    text(
      '高度なAutoMod・Punishment・Ignore設定は、既存のスラッシュコマンドから変更できます。',
    ),
  ];
}

export function configurationDashboard(
  overview: Record<string, unknown>,
  context: ConfigurationDashboardContext,
): MessageEditOptions {
  const page = context.page ?? 'home';
  const settings = (overview.settings ?? {}) as Record<string, unknown>;
  const components: TextDisplayBuilder[] = [
    text(
      page === 'home'
        ? '## サーバー設定'
        : page === 'logs'
          ? '## ログチャンネル'
          : '## 権限と表示',
    ),
    ...(page === 'home' ? details(overview) : []),
  ];
  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  if (page === 'home') {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button('nav-logs', 'ログを設定', context, ButtonStyle.Primary),
        button('nav-access', 'ロール・時刻', context),
        button('refresh', '再読み込み', context),
        button('setup', '初期設定', context),
      ),
    );
  } else if (page === 'logs') {
    const logChannelSetting: Record<LogKind, string> = {
      message: 'messageLogChannelId',
      moderation: 'modlogChannelId',
      server: 'serverLogChannelId',
      voice: 'voiceLogChannelId',
    };
    for (const kind of LOG_KINDS)
      rows.push(
        new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
          channelSelector(kind, context, settings[logChannelSetting[kind]]),
        ),
      );
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button('nav-home', '設定概要へ', context),
        button('refresh', '再読み込み', context),
      ),
    );
  } else {
    rows.push(
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId(actionId('role-select', context))
          .setPlaceholder('MODロールを選択')
          .setMinValues(1)
          .setMaxValues(1),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button('role-clear', 'MODロールを解除', context),
        button(
          'timezone-open',
          'タイムゾーンを変更',
          context,
          ButtonStyle.Primary,
        ),
        button('nav-home', '設定概要へ', context),
      ),
    );
  }
  const container = new ContainerBuilder()
    .setAccentColor(0x8b5cf6)
    .addTextDisplayComponents(...components)
    .addActionRowComponents(...rows);
  return { flags: MessageFlags.IsComponentsV2, components: [container] };
}

export function configurationDashboardError(): MessageEditOptions {
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [
      new ContainerBuilder()
        .setAccentColor(0xef4444)
        .addTextDisplayComponents(
          text('## 設定を表示できません'),
          text(
            '設定情報を読み込めませんでした。設定画面を開き直してください。',
          ),
        ),
    ],
  };
}

function ephemeralError(message: string): {
  content: string;
  flags: MessageFlags.Ephemeral;
} {
  return {
    content: `設定の更新に失敗しました。${message}\nもう一度お試しください。`,
    flags: MessageFlags.Ephemeral,
  };
}

const safeOperationFailure = (): string =>
  '設定を更新できませんでした。入力と権限を確認して、もう一度お試しください。';

const safeResultFailure = (
  options: ConfigurationComponentHandlerOptions,
  error: unknown,
): string => {
  options.reportFailure?.(error);
  return safeOperationFailure();
};

export function createConfigurationComponentHandler(
  options: ConfigurationComponentHandlerOptions,
): (interaction: MessageComponentInteraction) => Promise<boolean> {
  const handler = createConfigurationInteractionHandler(options);
  return async (interaction) => handler(interaction);
}

export function createConfigurationModalHandler(
  options: ConfigurationComponentHandlerOptions,
): (interaction: ModalSubmitInteraction) => Promise<boolean> {
  const handler = createConfigurationInteractionHandler(options);
  return async (interaction) => handler(interaction);
}

export function createConfigurationInteractionHandler(
  options: ConfigurationComponentHandlerOptions,
): (interaction: ConfigurationInteraction) => Promise<boolean> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DASHBOARD_TTL_MS;
  return async (interaction) => {
    const parsed = parseConfigurationCustomId(interaction.customId);
    if (!parsed || !interaction.inGuild()) return false;
    const reject = async (message: string): Promise<true> => {
      await interaction.reply(ephemeralError(message));
      return true;
    };
    if (
      parsed.guildId !== interaction.guildId ||
      parsed.actorId !== interaction.user.id ||
      parsed.expiresAt <= now()
    )
      return reject('この設定画面は期限切れ、または別の利用者のものです。');
    if (!(await options.authorization.authorize(interaction)))
      return reject('現在の権限では設定を変更できません。');
    if (
      isComponent(interaction) &&
      parsed.action === 'setup' &&
      options.setupPermissionPreflight
    ) {
      const missing = await options.setupPermissionPreflight(interaction);
      if (missing.length > 0)
        return reject(`Botに必要な権限がありません：${missing.join('、')}`);
    }
    if (isComponent(interaction) && parsed.action === 'timezone-open') {
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(
            actionId('timezone-submit', parsedContext(parsed, now(), ttlMs)),
          )
          .setTitle('タイムゾーンを変更')
          .addLabelComponents(
            new LabelBuilder()
              .setLabel('IANAタイムゾーン（例：Asia/Tokyo）')
              .setTextInputComponent(
                new TextInputBuilder()
                  .setCustomId('zone')
                  .setStyle(TextInputStyle.Short)
                  .setRequired(true)
                  .setMaxLength(64),
              ),
          ),
      );
      return true;
    }
    try {
      if (isComponent(interaction)) await interaction.deferUpdate();
      else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      let page: ConfigurationPage = 'home';
      let successMessage: string | null = null;
      let failureMessage: string | null = null;
      if (parsed.action === 'setup') {
        const result = await options.service.setup(parsed.guildId);
        if (result.ok)
          successMessage = `初期設定を完了しました。成功 ${String(result.value.succeeded)} / 失敗 ${String(result.value.failed)}`;
        else failureMessage = safeResultFailure(options, result.error);
      } else if (
        parsed.action.startsWith('channel-') &&
        isComponent(interaction)
      ) {
        const kind = parsed.action.slice('channel-'.length) as LogKind;
        const selected = interaction.isAnySelectMenu()
          ? interaction.values[0]
          : undefined;
        const result = await options.service.setLogChannel(
          parsed.guildId,
          kind,
          selected ?? '',
        );
        if (result.ok)
          successMessage = `${LOG_LABELS[kind]}ログのチャンネルを更新しました。`;
        else failureMessage = safeResultFailure(options, result.error);
        page = 'logs';
      } else if (parsed.action === 'role-select' && isComponent(interaction)) {
        const selected = interaction.isAnySelectMenu()
          ? interaction.values[0]
          : undefined;
        const metadata =
          selected && options.roles
            ? await options.roles.resolveRole(parsed.guildId, selected)
            : null;
        if (
          !metadata ||
          metadata.managed ||
          metadata.everyone ||
          metadata.botIntegration
        ) {
          failureMessage = 'このロールはMODロールに設定できません。';
        } else {
          const result = await options.service.setModRole(
            parsed.guildId,
            metadata.id,
            metadata,
          );
          if (result.ok) successMessage = 'MODロールを更新しました。';
          else failureMessage = safeResultFailure(options, result.error);
        }
        page = 'access';
      } else if (parsed.action === 'role-clear') {
        const result = await options.service.setModRole(parsed.guildId, null);
        if (result.ok) successMessage = 'MODロールを解除しました。';
        else failureMessage = safeResultFailure(options, result.error);
        page = 'access';
      } else if (
        parsed.action === 'timezone-submit' &&
        !isComponent(interaction)
      ) {
        const result = await options.service.setTimezone(
          parsed.guildId,
          interaction.fields.getTextInputValue('zone'),
        );
        if (result.ok)
          successMessage = `タイムゾーンを${result.value.settings.timezone}に変更しました。`;
        else failureMessage = safeResultFailure(options, result.error);
        page = 'access';
      } else if (parsed.action === 'nav-logs') page = 'logs';
      else if (parsed.action === 'nav-access') page = 'access';
      else if (parsed.action === 'nav-home' || parsed.action === 'refresh')
        page = 'home';
      const overview = await options.service.overview(parsed.guildId);
      if (!overview.ok) {
        await interaction.editReply(configurationDashboardError());
        return true;
      }
      await interaction.editReply(
        configurationDashboard(overview.value, {
          ...parsedContext(parsed, now(), ttlMs),
          page,
        }),
      );
      if (successMessage !== null)
        await interaction.followUp({
          content: successMessage,
          flags: MessageFlags.Ephemeral,
        });
      else if (failureMessage !== null)
        await interaction.followUp(ephemeralError(failureMessage));
      return true;
    } catch (error: unknown) {
      try {
        await interaction.followUp(
          ephemeralError(
            '設定の更新中に問題が発生しました。設定画面を開き直してください。',
          ),
        );
      } catch {
        try {
          await interaction.editReply(configurationDashboardError());
        } catch {
          // The interaction token may have expired; the runtime logger handles this case.
        }
      }
      throw error;
    }
  };
}

function parsedContext(
  parsed: { guildId: string; actorId: string },
  now: number,
  ttlMs: number,
): ConfigurationDashboardContext {
  return { guildId: parsed.guildId, actorId: parsed.actorId, now, ttlMs };
}
