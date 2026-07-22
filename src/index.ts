import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  ChannelType,
  type APIEmbed,
  type ButtonInteraction,
  type Client,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
  type Message,
  type PartialMessage,
  type VoiceState,
  AuditLogEvent,
} from 'discord.js';
import { loadConfig, type AppConfig } from './config/env.js';
import { createLogger, type AppLogContext } from './logging/logger.js';
import { createRuntimeLifecycle } from './runtime/bootstrap.js';
import { createDiscordClient } from './runtime/client.js';
import { installInteractionIntake } from './runtime/intake.js';
import { commandManifest, registerCommands } from './runtime/commands.js';
import { createCommandManifest } from './commands/index.js';
import type { CommandDefinition } from './commands/contract.js';
import {
  DiscordClientAdapter,
  DiscordRestAdapter,
  PrismaRuntimeAdapter,
} from './adapters/index.js';
import { PrismaSchedulerRepository } from './repositories/prisma-repositories.js';
import { PrismaGeneralRepository } from './repositories/prisma-repositories.js';
import { createJobScheduler } from './runtime/scheduler.js';
import { createPermissionPolicy } from './runtime/policy.js';
import {
  PrismaGuildSettingsRepository,
  PrismaAutomodRepository,
  PrismaPunishmentRepository,
  PrismaIgnoreRepository,
} from './repositories/prisma-repositories.js';
import {
  PrismaCaseRepository,
  PrismaActiveMuteRepository,
  PrismaStrikeRepository,
} from './repositories/prisma-repositories.js';
import { CaseService } from './services/case-service.js';
import { createCanonicalUserCase } from './services/case-service.js';
import { SchedulerService } from './services/scheduler-service.js';
import { SettingsService } from './services/settings-service.js';
import { CorrelationCache } from './services/correlation-cache.js';
import { RoleCorrelationCache } from './services/role-correlation-cache.js';
import { RoleBatchResolver } from './services/role-audit-resolver.js';
import { MemberRoleChangeService } from './services/member-role-change-service.js';
import { SnapshotService } from './services/snapshot-service.js';
import { TargetIdentityResolver } from './services/target-identity.js';
import {
  ExternalAuditEntrySchema,
  ExternalAuditPolicy,
  ExternalEventService,
  type ExternalAuditEntry,
  type ExternalEvent,
  type ExternalEventResult,
} from './services/external-event-service.js';
import { ResourceLoader } from './services/resource-loader.js';
import {
  AutomodConfigurationService,
  PunishmentConfigurationService,
  IgnoreConfigurationService,
} from './services/configuration-services.js';
import {
  ConfigurationService,
  createConfigurationComponentHandler,
  createConfigurationModalHandler,
  type ConfigurationInteraction,
  type ConfigurationRoleResolutionPort,
} from './features/configuration/index.js';
import {
  isUnauthorized,
  LoggingEventAdapter,
  LoggingEventPipeline,
  LogDeliveryService,
  SettingsLogConfiguration,
} from './features/logging/index.js';
import { ModerationLogService } from './services/modlog-service.js';
import {
  PrismaSnapshotRepository,
  PrismaDepartureRepository,
  PrismaRaidRepository,
} from './repositories/prisma-repositories.js';
import {
  isBotAuthoredMessage,
  isConfiguredLogChannel,
  type MessageView,
} from './features/logging/events.js';
import { MessageLaneQueue } from './features/logging/message-queue.js';
import {
  ModerationService,
  DiscordModerationAdapter,
} from './features/moderation/index.js';
import {
  createModerationCommandManifest,
  createModerationUtilityCommands,
} from './commands/moderation/index.js';
import { StrikeService } from './features/strikes/index.js';
import { RaidService } from './features/raid/index.js';
import { AutomodService } from './features/automod/index.js';
import {
  DiscordToolsAdapter,
  ToolsService,
  handleToolsComponent,
} from './features/tools/index.js';
import { DiscordVoiceAdapter, VoiceService } from './features/voice/index.js';
import { runMigrations } from './migrations.js';
import {
  DiscordGeneralAdapter,
  GeneralService,
  createGeneralManifest,
} from './features/general/index.js';

const context = (instanceId: string): AppLogContext => ({
  event: 'bootstrap',
  correlationId: instanceId,
  interactionId: null,
  guildId: null,
  channelId: null,
  userId: null,
  caseId: null,
  durationMs: null,
  errorName: null,
  discordCode: null,
});

const safeConfigurationFailureMessage = (
  error: unknown,
): string | undefined => {
  if (!(error instanceof Error)) return undefined;
  return error.message
    .replace(
      /(?:discord[_ -]?token|database_url|password|secret|authorization|bearer)\s*[:=]\s*\S+/giu,
      '[REDACTED]',
    )
    .replace(/postgres(?:ql)?:\/\/\S+/giu, '[REDACTED]')
    .slice(0, 500);
};

export function createBootstrapDependencies(
  config: AppConfig,
  logger: ReturnType<typeof createLogger>,
) {
  const prisma = new PrismaRuntimeAdapter(new PrismaClient());
  const settings = new PrismaGuildSettingsRepository(prisma.prisma);
  const ignoreRepository = new PrismaIgnoreRepository(prisma.prisma);
  const automodService = new AutomodConfigurationService(
    new PrismaAutomodRepository(prisma.prisma),
  );
  const punishmentService = new PunishmentConfigurationService(
    new PrismaPunishmentRepository(prisma.prisma),
  );
  const ignoreService = new IgnoreConfigurationService(ignoreRepository);
  // Configuration owns the one SettingsService used by every slice.  Keeping
  // this identity stable is important: its cache is part of the runtime state.
  const configuration = new ConfigurationService({
    settings,
    automod: automodService,
    punishments: punishmentService,
    ignores: ignoreService,
    setup: {
      findMutedRole: async (guildId, roleId) => {
        const guild = await client?.client.guilds.fetch(guildId);
        if (!guild) return null;
        if (roleId) {
          const role = await guild.roles.fetch(roleId).catch(() => null);
          if (role) return role.id;
        }
        return (
          guild.roles.cache.find((role) => role.name === 'Muted')?.id ?? null
        );
      },
      createMutedRole: async (guildId) => {
        const guild = await client?.client.guilds.fetch(guildId);
        if (!guild) throw new Error('Guild is unavailable');
        return (
          await guild.roles.create({
            name: 'Muted',
            reason: 'Pathtex setup',
          })
        ).id;
      },
      listChannels: async (guildId) => {
        const guild = await client?.client.guilds.fetch(guildId);
        if (!guild) return [];
        return [...guild.channels.cache.values()]
          .filter((channel) => channel.isTextBased() || channel.isVoiceBased())
          .map((channel) => ({
            id: channel.id,
            kind:
              (channel.type as ChannelType) === ChannelType.GuildForum
                ? ('forum' as const)
                : channel.type === ChannelType.GuildVoice
                  ? ('voice' as const)
                  : channel.type === ChannelType.GuildStageVoice
                    ? ('stage' as const)
                    : ('text' as const),
          }));
      },
      denyMutedRole: async (guildId, channelId, kind) => {
        if (!['text', 'forum', 'voice', 'stage'].includes(kind)) return;
        const guild = await client?.client.guilds.fetch(guildId);
        const channel = await guild?.channels.fetch(channelId);
        const role = guild?.roles.cache.find((item) => item.name === 'Muted');
        if (!channel || !role || !('permissionOverwrites' in channel)) return;
        const voice = kind === 'voice' || kind === 'stage';
        await channel.permissionOverwrites.edit(
          role,
          voice
            ? { Speak: false }
            : {
                SendMessages: false,
                AddReactions: false,
                CreatePublicThreads: false,
                CreatePrivateThreads: false,
                SendMessagesInThreads: false,
                SendVoiceMessages: false,
              },
        );
      },
      checkChannelPermissions: async (guildId, channelId) => {
        const guild = await client?.client.guilds.fetch(guildId);
        const channel = await guild?.channels.fetch(channelId);
        if (!channel || !('permissionsFor' in channel) || !client?.client.user)
          return ['ViewChannel'];
        const permissions = channel.permissionsFor(client.client.user);
        return permissions?.has([
          'ViewChannel',
          'SendMessages',
          'EmbedLinks',
          'ReadMessageHistory',
        ])
          ? []
          : ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory'];
      },
      ensureAutomodSettings: async (guildId) => {
        await automodService.getOrCreate(guildId);
      },
      getAutomaticIgnoredRoles: async (guildId) => {
        const guild = await client?.client.guilds.fetch(guildId);
        if (!guild) return [];
        const botRolePosition = guild.members.me?.roles.highest.position ?? -1;
        const automaticallyIgnoredPermissions = [
          'Administrator',
          'BanMembers',
          'ManageMessages',
          'KickMembers',
          'ManageGuild',
        ] as const;
        return [...guild.roles.cache.values()]
          .filter(
            (role) =>
              role.position >= botRolePosition ||
              role.permissions.has(automaticallyIgnoredPermissions),
          )
          .map((role) => role.id);
      },
      getBotWarnings: async (guildId) => {
        const guild = await client?.client.guilds.fetch(guildId);
        const member = guild?.members.me;
        if (!member) return ['Botのメンバー情報を取得できません'];
        const required = [
          'ViewChannel',
          'SendMessages',
          'EmbedLinks',
          'ReadMessageHistory',
          'ManageRoles',
          'ManageChannels',
        ] as const;
        const missing = member.permissions.missing(required);
        return missing.length > 0
          ? [`Botに必要な権限がありません: ${missing.join(', ')}`]
          : [];
      },
    },
  });
  const settingsService = configuration.settings;
  const jobRepository = new PrismaSchedulerRepository(prisma.prisma);
  const caseService = new CaseService(new PrismaCaseRepository(prisma.prisma));
  const schedulerService = new SchedulerService(jobRepository, {
    workerId: config.INSTANCE_ID,
  });
  const activeMuteRepository = new PrismaActiveMuteRepository(prisma.prisma);
  const lifecycleRepository = new PrismaDepartureRepository(prisma.prisma);
  const correlation = new CorrelationCache();
  const roleCorrelation = new RoleCorrelationCache();
  const moderationDiscord = new DiscordModerationAdapter(
    () => client?.client ?? undefined,
  );
  const snapshot = new SnapshotService(
    new PrismaSnapshotRepository(prisma.prisma),
  );
  const targetIdentityResolver = new TargetIdentityResolver({
    getMember: async (guildId, userId) =>
      moderationDiscord.getMember(guildId, userId),
    getUser: async (userId) => {
      const user = await moderationDiscord.getUser('', userId);
      return user
        ? {
            globalName: user.globalName,
            username: user.username ?? user.display,
          }
        : null;
    },
    getSnapshot: async (guildId, userId) => {
      const result = await snapshot.getMember(guildId, userId);
      return result.ok ? result.value : null;
    },
  });
  const logSender = {
    send: async (channelId: string, event: unknown): Promise<void> => {
      const channel = await client?.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) return;
      const payload = event as { embed?: APIEmbed };
      await channel.send({ embeds: [payload.embed ?? (event as APIEmbed)] });
    },
  };
  const logSettings = new SettingsLogConfiguration(configuration);
  const moderationLog = new ModerationLogService(
    logSender,
    logSettings,
    caseService,
  );
  const moderation = new ModerationService({
    discord: moderationDiscord,
    cases: caseService,
    scheduler: schedulerService,
    activeMutes: activeMuteRepository,
    settings: settingsService,
    targetIdentityResolver,
    fatal: (error) => {
      logger.fatal({ error }, 'Fatal moderation operation failure');
      void stopLifecycle?.();
    },
    modlog: moderationLog,
    correlation: {
      put: (kind, key, value) => correlation.put(kind, key, value),
      putSlowmode: (key, value) => correlation.put('slowmode', key, value),
      add: (key, value) =>
        correlation.put('moderation', key, value as { caseId: string }),
    },
    roleMutationLock: (guildId, userId, operation) =>
      moderationDiscord.withRoleMutationLock(guildId, userId, operation),
    addRoleUnlocked: (guildId, userId, roleId, reason) =>
      moderationDiscord.addRoleUnlocked(guildId, userId, roleId, reason),
    removeRoleUnlocked: (guildId, userId, roleId, reason) =>
      moderationDiscord.removeRoleUnlocked(guildId, userId, roleId, reason),
    hasRoleUnlocked: (guildId, userId, roleId) =>
      moderationDiscord.hasRole(guildId, userId, roleId),
    roleCorrelation,
  });
  const strikeDiscord = Object.assign(moderationDiscord, {
    getGuildName: async (guildId: string) =>
      (await client?.client.guilds.fetch(guildId))?.name ?? guildId,
    getBanExpiresAt: async (guildId: string, userId: string) =>
      (await jobRepository.findPending(guildId, userId, null, 'UNBAN'))
        ?.executeAt ?? null,
    hasMutedRole: async (guildId: string, userId: string, roleId: string) => {
      const member = await client?.client.guilds
        .fetch(guildId)
        .then((guild) => guild.members.fetch(userId));
      return member?.roles.cache.has(roleId) ?? false;
    },
  });
  const strikeService = new StrikeService({
    strikes: new PrismaStrikeRepository(prisma.prisma),
    cases: caseService,
    punishments: punishmentService,
    moderation,
    discord: strikeDiscord,
    settings: settingsService,
    targetIdentityResolver,
    activeMutes: activeMuteRepository,
    modlog: moderationLog,
  });
  const automod = new AutomodService({
    settings: new PrismaAutomodRepository(prisma.prisma),
    ignores: ignoreRepository,
    punishments: punishmentService,
    strikes: strikeService,
    resourceLoader: new ResourceLoader(),
    correlation: {
      add: (key, value) => {
        correlation.put('message-delete', key, value);
      },
    },
    metrics: {
      increment: (name, value = 1) => {
        logger.info({ event: 'metric', metric: name, value }, 'AutoMod metric');
      },
    },
    messageLog: {
      deleted: (message, reason) => {
        logger.info(
          {
            event: 'automod.deleted',
            guildId: message.guildId,
            channelId: message.channelId,
            userId: message.authorId,
            reason,
          },
          'AutoMod message deleted',
        );
        return Promise.resolve();
      },
      warning: (message, warning) => {
        logger.warn(
          {
            event: 'automod.warning',
            guildId: message.guildId,
            channelId: message.channelId,
            userId: message.authorId,
            warning,
          },
          'AutoMod warning',
        );
        return Promise.resolve();
      },
      strike: (message, details) => {
        logger.info(
          {
            event: 'automod.strike',
            guildId: message.guildId,
            channelId: message.channelId,
            userId: message.authorId,
            amount: details.amount,
            warningCount: details.warnings.length,
          },
          'AutoMod strike recorded',
        );
        return Promise.resolve();
      },
    },
    warning: (guildId, warning) => {
      logger.warn(
        { event: 'automod.warning', guildId, warning },
        'AutoMod warning',
      );
    },
    discord: {
      deleteMessage: async (channelId, messageId) => {
        const channel = await client?.client.channels.fetch(channelId);
        if (channel && 'messages' in channel)
          await channel.messages.delete(messageId);
      },
      deleteMessages: async (channelId, messageIds) => {
        const channel = await client?.client.channels.fetch(channelId);
        if (channel && 'bulkDelete' in channel && messageIds.length > 0)
          await channel.bulkDelete(messageIds);
      },
      getChannelTopic: async (channelId) => {
        const channel = await client?.client.channels.fetch(channelId);
        return channel && 'topic' in channel ? (channel.topic ?? null) : null;
      },
      getParentTopic: async (channelId) => {
        const channel = await client?.client.channels.fetch(channelId);
        const parentId =
          channel && 'parentId' in channel ? channel.parentId : null;
        if (!parentId) return null;
        const parent = await client?.client.channels.fetch(parentId);
        return parent && 'topic' in parent ? (parent.topic ?? null) : null;
      },
      getParentChannelId: async (channelId) => {
        const channel = await client?.client.channels.fetch(channelId);
        return channel && 'parentId' in channel
          ? (channel.parentId ?? null)
          : null;
      },
      getChannelCategoryId: async (channelId) => {
        const channel = await client?.client.channels.fetch(channelId);
        if (!channel || !('parentId' in channel) || !channel.parentId)
          return null;
        const parent = await client?.client.channels.fetch(channel.parentId);
        return parent?.type === ChannelType.GuildCategory ? parent.id : null;
      },
      getEffectiveMemberPermissions: async (guildId, channelId, userId) => {
        const guild = await client?.client.guilds.fetch(guildId);
        const channel = await client?.client.channels.fetch(channelId);
        const member = await guild?.members.fetch(userId).catch(() => null);
        if (!channel || !member || !('permissionsFor' in channel)) return [];
        return channel.permissionsFor(member).toArray();
      },
      listCategoryChildren: async (guildId, categoryId) => {
        const guild = await client?.client.guilds.fetch(guildId);
        return guild
          ? [...guild.channels.cache.values()]
              .filter((channel) => channel.parentId === categoryId)
              .map((channel) => channel.id)
          : [];
      },
      getRole: async (guildId, roleId) => {
        const guild = await client?.client.guilds.fetch(guildId);
        const role = await guild?.roles.fetch(roleId);
        return role ? { name: role.name, mentionable: role.mentionable } : null;
      },
      listRoles: async (guildId) => {
        const guild = await client?.client.guilds.fetch(guildId);
        return guild
          ? [...guild.roles.cache.values()].map((role) => ({
              id: role.id,
              position: role.position,
              permissions: [...role.permissions.toArray()],
            }))
          : [];
      },
      getBotRolePosition: async (guildId) =>
        (await client?.client.guilds.fetch(guildId))?.members.me?.roles.highest
          .position ?? -1,
      dehoist: async (guildId, userId, character) => {
        const guild = await client?.client.guilds.fetch(guildId);
        const member = await guild?.members.fetch(userId);
        if (member)
          await member.setNickname(
            `${character}${member.displayName}`,
            'AutoDehoist',
          );
      },
      getMember: async (guildId, userId) => {
        const member = await (
          await client?.client.guilds.fetch(guildId)
        )?.members
          .fetch(userId)
          .catch(() => null);
        return member
          ? {
              isOwner: member.id === member.guild.ownerId,
              displayName: member.displayName,
              roleIds: [...member.roles.cache.keys()],
              highestRolePosition: member.roles.highest.position,
              ...(member.guild.members.me
                ? {
                    botRolePosition:
                      member.guild.members.me.roles.highest.position,
                  }
                : {}),
              permissions: [...member.permissions.toArray()],
              canManageMessages: member.permissions.has('ManageMessages'),
              canMentionEveryone: member.permissions.has('MentionEveryone'),
            }
          : null;
      },
      getInvite: async (code) => {
        try {
          const invite = await client?.client.fetchInvite(code);
          return invite?.guild?.id ? { guildId: invite.guild.id } : null;
        } catch {
          return null;
        }
      },
      getBotUserId: (guildId) => moderationDiscord.getBotUserId(guildId),
    },
  });
  configuration.setAutomodWarningsProvider(() => automod.resourceWarnings());
  const raidRepository = new PrismaRaidRepository(prisma.prisma);
  const raid = new RaidService({
    repository: raidRepository,
    settings: settingsService,
    automod: automodService,
    scheduler: schedulerService,
    moderation,
    cases: caseService,
    discord: {
      getVerificationLevel: async (guildId) =>
        (await client?.client.guilds.fetch(guildId))?.verificationLevel ?? 0,
      setVerificationLevel: async (guildId, level, reason) => {
        await (
          await client?.client.guilds.fetch(guildId)
        )?.setVerificationLevel(level, reason);
      },
      getBotUserId: (guildId) => moderationDiscord.getBotUserId(guildId),
      sendDm: (userId, content) => moderationDiscord.sendDm(userId, content),
      getGuildName: async (guildId) =>
        (await client?.client.guilds.fetch(guildId))?.name ?? 'このサーバー',
    },
    modlog: moderationLog,
    targetIdentityResolver,
  });
  const schedulerDispatcher = {
    available: true,
    supportedTypes: [
      'UNBAN',
      'UNMUTE',
      'RESTORE_SLOWMODE',
      'DISABLE_RAIDMODE',
    ] as const,
    supports: (job: import('./repositories/contracts.js').JobDto) =>
      ['UNBAN', 'UNMUTE', 'RESTORE_SLOWMODE', 'DISABLE_RAIDMODE'].includes(
        job.type,
      ),
    dispatch: async (job: import('./repositories/contracts.js').JobDto) => {
      const payload = job.payload as {
        guildId?: string;
        userId?: string;
        channelId?: string;
        interval?: number;
      };
      if (job.type === 'DISABLE_RAIDMODE') {
        const actorId = await moderationDiscord.getBotUserId(job.guildId);
        const result = await raid.off(job.guildId, actorId, 'AutoRaid自動解除');
        if (!result.ok) throw new Error(result.error.message);
      } else if (job.type === 'RESTORE_SLOWMODE') {
        if (!payload.channelId || payload.interval === undefined)
          throw new Error('Invalid slowmode job payload');
        await moderationDiscord.setSlowmode(
          payload.channelId,
          payload.interval,
          `scheduled:${job.id}`,
        );
      } else {
        if (!payload.userId || !payload.guildId)
          throw new Error('Invalid moderation job payload');
        const guildId = payload.guildId;
        const userId = payload.userId;
        if (job.type === 'UNMUTE') {
          await moderationDiscord.withRoleMutationLock(
            guildId,
            userId,
            async () => {
              const settingsResult = await configuration.get(guildId);
              const roleId = settingsResult.ok
                ? settingsResult.value.mutedRoleId
                : null;
              if (!roleId) throw new Error('Muted role is not configured');
              const ownsJob = await activeMuteRepository.claimScheduledUnmute(
                guildId,
                userId,
                job.id,
                config.INSTANCE_ID,
              );
              if (!ownsJob)
                throw Object.assign(new Error('Mute is no longer active'), {
                  code: 'NOT_APPLIED',
                });
              try {
                if (
                  !(await activeMuteRepository.verifyScheduledUnmute(
                    guildId,
                    userId,
                    job.id,
                    config.INSTANCE_ID,
                  ))
                )
                  throw Object.assign(
                    new Error('Scheduled unmute was superseded'),
                    { code: 'NOT_APPLIED' },
                  );
                // Check actual role presence; no-op if already removed.
                const actuallyHas = await moderationDiscord.hasRole(
                  guildId,
                  userId,
                  roleId,
                );
                if (!actuallyHas) {
                  await activeMuteRepository.completeScheduledUnmute(
                    guildId,
                    userId,
                    job.id,
                    config.INSTANCE_ID,
                  );
                  return;
                }
                roleCorrelation.put(guildId, userId, roleId, 'REMOVE');
                try {
                  await moderationDiscord.removeRoleUnlocked(
                    guildId,
                    userId,
                    roleId,
                    `scheduled:${job.id}`,
                  );
                } catch (error) {
                  roleCorrelation.remove(guildId, userId, roleId, 'REMOVE');
                  throw error;
                }
                const completed =
                  await activeMuteRepository.completeScheduledUnmute(
                    guildId,
                    userId,
                    job.id,
                    config.INSTANCE_ID,
                  );
                if (!completed)
                  throw new Error('Scheduled unmute ownership was lost');
              } catch (error: unknown) {
                await activeMuteRepository.restoreScheduledUnmute(
                  guildId,
                  userId,
                  job.id,
                  config.INSTANCE_ID,
                );
                throw error;
              }
            },
          );
        } else {
          const actorId = await moderationDiscord.getBotUserId(payload.guildId);
          const result = await moderation.execute(
            {
              guildId: payload.guildId,
              actorId,
              targets: [{ id: payload.userId }],
              reason: '期限到達',
              execution: { source: 'COMMAND', sendDm: false, waitForDm: false },
            },
            job.type,
            { source: 'COMMAND', sendDm: false, waitForDm: false },
          );
          if (
            !result.ok ||
            result.value.outcomes.some((outcome) => !outcome.ok)
          )
            throw Object.assign(
              new Error(`Scheduled ${job.type} was not applied`),
              { code: 'NOT_APPLIED' },
            );
        }
      }
      logger.info(
        {
          event: 'scheduler.action_dispatched',
          jobId: job.id,
          action: job.type,
        },
        'Scheduled action dispatched',
      );
    },
  };
  const scheduler = createJobScheduler(
    jobRepository,
    schedulerDispatcher,
    config.INSTANCE_ID,
    5_000,
    logger,
  );
  let client: DiscordClientAdapter | undefined;
  let removeIntake: ReturnType<typeof installInteractionIntake> | undefined;
  let stopLifecycle: (() => Promise<void>) | undefined;
  let voiceExpiryTimer: NodeJS.Timeout | undefined;
  const rawClient = createDiscordClient((error) => {
    logger.fatal(
      { event: 'gateway.fatal', discordCode: 4014, errorName: error.name },
      'Gateway intent failure',
    );
    process.exitCode = 1;
    void stopLifecycle?.();
  });
  const toolsAdapter = new DiscordToolsAdapter(rawClient);
  const tools = new ToolsService(toolsAdapter, toolsAdapter, toolsAdapter);
  const voiceAdapter = new DiscordVoiceAdapter(rawClient);
  const voicePort = Object.assign(voiceAdapter, {
    dm: (userId: string, content: string): Promise<void> =>
      voiceAdapter.dm(userId, content).catch((error: unknown) => {
        logger.warn(
          {
            event: 'voice.dm_failed',
            userId,
            errorName: error instanceof Error ? error.name : 'unknown',
          },
          'VoiceMove result DM failed',
        );
        throw error;
      }),
    log: (guildId: string, event: unknown): Promise<void> => {
      logger.info(
        { event: 'voice.action', guildId, details: event },
        'Voice action',
      );
      return Promise.resolve();
    },
    writeCase: async (guildId: string, caseId: string): Promise<void> => {
      await moderationLog.writeCase(guildId, caseId);
    },
  });
  const voice = new VoiceService(
    voicePort,
    {
      create: async (input) => {
        const result = await caseService.createCanonical(
          createCanonicalUserCase({
            guildId: input.guildId,
            action: input.action,
            identity: input.identity ?? {
              userId: input.targetUserId,
              displayName: '不明なユーザー',
            },
            moderatorUserId: input.moderatorUserId,
            reason: null,
            source: 'COMMAND',
            status: input.status ?? 'COMPLETED',
            metadata: input.errorCode ? { errorCode: input.errorCode } : {},
          }),
        );
        if (!result.ok) {
          logger.error(
            {
              event: 'voice.case_failed',
              guildId: input.guildId,
              errorName: result.error.name,
            },
            'Voice case creation failed',
          );
          return null;
        }
        return { caseId: result.value.id, caseNumber: result.value.caseNumber };
      },
    },
    undefined,
    targetIdentityResolver,
  );
  const permissionPolicy = createPermissionPolicy({
    getModRoleId: async (guildId) =>
      (await settings.get(guildId))?.modRoleId ?? null,
    roleExists: async (guildId, roleId) => {
      try {
        const guild = await client?.client.guilds.fetch(guildId);
        if (guild === undefined) return false;
        const role = await guild.roles.fetch(roleId);
        return role !== null;
      } catch (error: unknown) {
        if ((error as { code?: number }).code === 10011) return false;
        throw error;
      }
    },
    clearDeletedModRole: async (guildId, roleId) => {
      await prisma.prisma.guildSettings.updateMany({
        where: { guildId, modRoleId: roleId },
        data: { modRoleId: null },
      });
    },
  });
  const configurationRoles: ConfigurationRoleResolutionPort = {
    resolveRole: async (guildId, roleId) => {
      try {
        const guild = await client?.client.guilds.fetch(guildId);
        if (!guild) return null;
        const role = await guild.roles.fetch(roleId).catch(() => null);
        if (!role) return null;
        const tags = role.tags;
        return {
          id: role.id,
          managed: role.managed,
          everyone: role.id === guild.id,
          botIntegration:
            tags !== null && ('botId' in tags || 'integrationId' in tags),
        };
      } catch {
        return null;
      }
    },
  };
  const configurationAuthorization = {
    authorize: async (interaction: ConfigurationInteraction) => {
      if (interaction.guild?.ownerId === interaction.user.id) return true;
      return permissionPolicy.authorize(
        interaction as unknown as ChatInputCommandInteraction,
        {
          authorizationPolicy: 'MANAGE_GUILD',
          actorNativePermissions: ['ManageGuild'],
        } as unknown as CommandDefinition,
      );
    },
  };
  const setupPermissionPreflight = (
    interaction: MessageComponentInteraction,
  ): Promise<readonly string[]> =>
    Promise.resolve(
      permissionPolicy.missingBotPermissions(
        interaction as unknown as ChatInputCommandInteraction,
        ['ManageRoles', 'ManageChannels', 'ViewChannel'],
      ),
    );
  const configurationHandlerOptions = {
    service: configuration,
    authorization: configurationAuthorization,
    roles: configurationRoles,
    reportFailure: (error: unknown) => {
      const errorMessage = safeConfigurationFailureMessage(error);
      logger.error(
        {
          event: 'interaction.configuration_action_failed',
          errorName: error instanceof Error ? error.name : 'unknown',
          ...(errorMessage === undefined ? {} : { errorMessage }),
        },
        'Configuration dashboard action failed',
      );
    },
    setupPermissionPreflight,
  };
  const configurationComponentHandler = createConfigurationComponentHandler(
    configurationHandlerOptions,
  );
  const configurationModalHandler = createConfigurationModalHandler(
    configurationHandlerOptions,
  );
  const database = {
    health: () => prisma.health(),
    gatewayPing: () => client?.client.ws.ping ?? -1,
  };
  const generalDatabase = new PrismaGeneralRepository(prisma.prisma);
  const generalAdapter = new DiscordGeneralAdapter(rawClient, {
    version: config.BOT_VERSION,
    clientId: config.DISCORD_CLIENT_ID,
    ...(config.INVITE_PERMISSIONS === undefined
      ? {}
      : { invitePermissions: config.INVITE_PERMISSIONS }),
    database: generalDatabase,
  });
  const general = createGeneralManifest(
    new GeneralService({
      runtime: generalAdapter.runtime(),
      database: generalDatabase,
    }),
    generalAdapter,
  );
  const commands = addVoiceStopAuthorization(
    createCommandManifest(
      database,
      [
        ...createModerationCommandManifest(moderation),
        ...createModerationUtilityCommands(moderation),
      ],
      configuration,
      strikeService,
      raid,
      automod,
      tools,
      voice,
      general.commands,
    ),
    voice,
    permissionPolicy,
  );
  const logging = new LoggingEventPipeline({
    snapshots: snapshot,
    automod,
    logger,
    events: new LoggingEventAdapter(
      {
        findMessageDelete: async (
          guildId,
          channelId,
          messageIds,
          authorId,
          occurredAt,
        ) => {
          const guild = await client?.client.guilds.fetch(guildId);
          if (!guild) return null;
          const logs = await guild.fetchAuditLogs({ limit: 50 });
          return matchMessageDeleteAudit(
            [
              ...logs.entries.values(),
            ] as unknown as readonly MessageDeleteAuditEntry[],
            channelId,
            messageIds,
            authorId,
            occurredAt,
          );
        },
      },
      undefined,
      {
        peek: (guildId, messageId) => {
          const value = correlation.peek(
            'message-delete',
            `${guildId}:${messageId}`,
          );
          return value && 'reason' in value
            ? { executor: '不明', reason: value.reason }
            : null;
        },
        consume: (guildId, messageId) => {
          const value = correlation.consume(
            'message-delete',
            `${guildId}:${messageId}`,
          );
          return value && 'reason' in value
            ? { executor: '不明', reason: value.reason }
            : null;
        },
      },
    ),
    delivery: new LogDeliveryService(logSender, logSettings, caseService),
    timezone: async (guildId) => {
      const result = await configuration.getWithTimezoneRepair(guildId);
      return result.ok ? result.value.timezone : 'UTC';
    },
  });
  const externalAuditReader = {
    list: async (
      guildId: string,
      query: import('./services/external-event-service.js').AuditQuery,
    ): Promise<readonly ExternalAuditEntry[]> => {
      try {
        const guild = await rawClient.guilds.fetch(guildId);
        const logs = await guild.fetchAuditLogs({
          limit: query.limit,
          type: auditLogEventType(query.type),
        });
        const entries: ExternalAuditEntry[] = [];
        for (const entry of logs.entries.values()) {
          const createdAt = new Date(entry.createdTimestamp);
          if (createdAt < query.after || createdAt > query.before) continue;
          const targetUserId = (entry.target as { id?: unknown } | null)?.id;
          const executorUserId = entry.executorId;
          if (
            typeof targetUserId !== 'string' ||
            typeof executorUserId !== 'string'
          )
            continue;
          const action =
            entry.action === AuditLogEvent.MemberKick
              ? 'MEMBER_KICK'
              : entry.action === AuditLogEvent.MemberBanAdd
                ? 'MEMBER_BAN_ADD'
                : entry.action === AuditLogEvent.MemberBanRemove
                  ? 'MEMBER_BAN_REMOVE'
                  : entry.action === AuditLogEvent.MemberRoleUpdate
                    ? 'MEMBER_ROLE_UPDATE'
                    : null;
          if (!action) continue;
          const base = {
            id: entry.id,
            action,
            targetUserId,
            executorUserId,
            createdAt,
          };
          if (action !== 'MEMBER_ROLE_UPDATE') {
            const parsed = ExternalAuditEntrySchema.safeParse(base);
            if (parsed.success) entries.push(parsed.data);
            continue;
          }
          const changes = (
            (Array.isArray(entry.changes) ? entry.changes : []) as readonly {
              key?: unknown;
              new?: unknown;
              old?: unknown;
            }[]
          ).filter(
            (change) => change.key === '$add' || change.key === '$remove',
          );
          for (const change of changes) {
            const roleChange = change.key === '$add' ? 'ADD' : 'REMOVE';
            const roleValues: readonly unknown[] = Array.isArray(
              change.new ?? change.old,
            )
              ? ((change.new ?? change.old) as readonly unknown[])
              : [];
            for (const role of roleValues) {
              const roleId =
                typeof role === 'object' && role !== null && 'id' in role
                  ? role.id
                  : undefined;
              const parsed = ExternalAuditEntrySchema.safeParse({
                ...base,
                roleId,
                roleChange,
              });
              if (parsed.success) entries.push(parsed.data);
            }
          }
        }
        return entries;
      } catch (error: unknown) {
        const status =
          typeof error === 'object' && error !== null && 'status' in error
            ? (error as { status?: unknown }).status
            : undefined;
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? (error as { code?: unknown }).code
            : undefined;
        if (status === 401 || code === 401) {
          logger.fatal(
            { event: 'gateway.audit_auth_failed', discordCode: 401 },
            'Discord audit-log authentication failed',
          );
          process.exitCode = 1;
          void stopLifecycle?.();
        }
        throw error;
      }
    },
    listRoleUpdates: async (
      guildId: string,
      query: import('./services/external-event-service.js').AuditQuery,
    ): Promise<
      readonly import('./services/role-audit-resolver.js').RoleAuditEntry[]
    > => {
      try {
        const guild = await rawClient.guilds.fetch(guildId);
        const logs = await guild.fetchAuditLogs({
          limit: query.limit,
          type: auditLogEventType(query.type),
        });
        const entries: import('./services/role-audit-resolver.js').RoleAuditEntry[] =
          [];
        for (const entry of logs.entries.values()) {
          const createdAt = new Date(entry.createdTimestamp);
          if (createdAt < query.after || createdAt > query.before) continue;
          const targetUserId = (entry.target as { id?: unknown } | null)?.id;
          const executorUserId = entry.executorId;
          if (
            typeof targetUserId !== 'string' ||
            typeof executorUserId !== 'string'
          )
            continue;
          const changes = (
            (Array.isArray(entry.changes) ? entry.changes : []) as readonly {
              key?: unknown;
              new?: unknown;
              old?: unknown;
            }[]
          ).filter(
            (change) => change.key === '$add' || change.key === '$remove',
          );
          const transitions: import('./services/role-audit-resolver.js').RoleTransition[] =
            [];
          for (const change of changes) {
            const direction = change.key === '$add' ? 'ADD' : 'REMOVE';
            const roleValues: readonly unknown[] = Array.isArray(
              change.new ?? change.old,
            )
              ? ((change.new ?? change.old) as readonly unknown[])
              : [];
            for (const role of roleValues) {
              const roleId =
                typeof role === 'object' && role !== null && 'id' in role
                  ? role.id
                  : undefined;
              if (typeof roleId === 'string')
                transitions.push({ roleId, direction });
            }
          }
          if (transitions.length > 0)
            entries.push({
              id: entry.id,
              targetUserId,
              executorUserId,
              createdAt,
              transitions,
            });
        }
        return entries;
      } catch (error: unknown) {
        const status =
          typeof error === 'object' && error !== null && 'status' in error
            ? (error as { status?: unknown }).status
            : undefined;
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? (error as { code?: unknown }).code
            : undefined;
        if (status === 401 || code === 401) {
          logger.fatal(
            { event: 'gateway.audit_auth_failed', discordCode: 401 },
            'Discord audit-log authentication failed',
          );
          process.exitCode = 1;
          void stopLifecycle?.();
        }
        throw error;
      }
    },
  };
  const externalEvents = new ExternalEventService({
    cases: caseService,
    audit: new ExternalAuditPolicy(externalAuditReader),
    correlation,
    identity: targetIdentityResolver,
    snapshots: snapshot,
    cancelUnban: (guildId, userId) =>
      schedulerService
        .cancel({
          guildId,
          targetUserId: userId,
          channelId: null,
          type: 'UNBAN',
        })
        .then(() => undefined),
    onOperationalError: (error) => {
      logger.error(
        {
          event: 'external_event.operational_failure',
          errorName: error instanceof Error ? error.name : 'unknown',
        },
        'External event post-case operation failed',
      );
    },
    serverLog: async (event: ExternalEvent, result: ExternalEventResult) => {
      const labels: Record<string, string> = {
        MEMBER_REMOVE: 'メンバー退出',
        BAN_ADD: 'BAN追加',
        BAN_REMOVE: 'BAN解除',
      };
      if (event.kind === 'MUTED_ROLE_UPDATE') return;
      const snapshot = event.snapshot;
      const displayName =
        event.memberDisplayName?.trim() ||
        snapshot?.nickname ||
        snapshot?.globalName ||
        snapshot?.username ||
        '不明なユーザー';
      const label = labels[event.kind];
      if (!label) return;
      await logging.server(
        event.guildId,
        label,
        [
          {
            name: 'ユーザー',
            value: `${displayName} (${event.targetUserId})`,
          },
          ...(event.kind === 'MEMBER_REMOVE'
            ? []
            : [
                {
                  name: '判定',
                  value: result.correlated
                    ? '内部操作（Bot起因）'
                    : result.auditEntryId
                      ? 'Audit Log照合済み'
                      : 'Audit Log照合不可',
                },
              ]),
        ],
        event.occurredAt,
        event.kind === 'MEMBER_REMOVE'
          ? 0x95a5a6
          : event.kind === 'BAN_ADD'
            ? 0xe74c3c
            : 0x2ecc71,
      );
    },
  });
  const memberRoleChange = new MemberRoleChangeService({
    delivery: new LogDeliveryService(logSender, logSettings, caseService),
    timezone: async (guildId) => {
      const result = await configuration.getWithTimezoneRepair(guildId);
      return result.ok ? result.value.timezone : 'UTC';
    },
    resolver: new RoleBatchResolver(externalAuditReader),
    roleCorrelation,
    botUserId: () => rawClient.user?.id ?? null,
    onOperationalError: (error) => {
      logger.error(
        {
          event: 'role_change.audit_resolver_failed',
          errorName: error instanceof Error ? error.name : 'unknown',
        },
        'Role change audit resolution failed',
      );
    },
    fatal: (error) => {
      logger.fatal(
        { error, event: 'role_change.fatal_401' },
        'Fatal 401 in role change processing',
      );
      process.exitCode = 1;
      void stopLifecycle?.();
    },
    resolveExecutorDisplay: async (guildId, userId) => {
      const identity = await targetIdentityResolver.resolve(guildId, userId);
      // Fallback display must be bare userId, not TargetIdentity's fallback string.
      return identity.displayName === '不明なユーザー'
        ? null
        : identity.displayName;
    },
    logger,
  });
  return {
    commandDefinitions: commands,
    database: () => prisma.connect(),
    migrations: () => runMigrations(process.cwd()),
    resources: async () => {
      await automod.initialize();
      return { commands: commandManifest(commands) };
    },
    registerCommands: (manifest: ReturnType<typeof commandManifest>) =>
      registerCommands(
        config,
        DiscordRestAdapter.withToken(config.DISCORD_TOKEN),
        manifest,
      ),
    recoverStaleJobs: async () => {
      await scheduler.recover();
    },
    schedulerDispatcher,
    scheduler: () => scheduler.start(),
    stopScheduler: () => scheduler.stop(),
    intake: () => {
      if (client === undefined)
        throw new Error('Discord client is not created');
      removeIntake = installInteractionIntake(client.client, commands, {
        ready: () => client?.client.isReady() ?? false,
        logger,
        permissionPolicy,
        onComponent: (interaction) =>
          handleToolsComponent(interaction as ButtonInteraction, tools),
        onConfigurationComponent: configurationComponentHandler,
        onConfigurationModal: configurationModalHandler,
        onFatal: (error) => {
          logger.fatal(
            {
              event: 'discord.http_auth_failed',
              errorName: error.name,
              discordCode: 401,
            },
            'Discord authentication failed',
          );
          void stopLifecycle?.();
        },
      });
      return Promise.resolve();
    },
    stopIntake: () => {
      removeIntake?.stopAccepting();
      return Promise.resolve();
    },
    drainIntake: () => removeIntake?.drain() ?? Promise.resolve(),
    createClient: () => {
      client = new DiscordClientAdapter(rawClient);
      voiceExpiryTimer = setInterval(() => {
        void voice.expire().catch(() => undefined);
      }, 60_000);
      installGatewayListeners(
        client.client,
        logging,
        settingsService,
        snapshot,
        activeMuteRepository,
        moderationDiscord,
        schedulerService,
        lifecycleRepository,
        configuration,
        ignoreService,
        correlation,
        roleCorrelation,
        caseService,
        moderationLog,
        externalEvents,
        memberRoleChange,
        raid,
        automod,
        logger,
        (error) => {
          logger.fatal(
            { error, event: 'gateway.role_401' },
            'Fatal 401 in role change lanes',
          );
          process.exitCode = 1;
          void stopLifecycle?.();
        },
        targetIdentityResolver,
      );
      rawClient.on('voiceStateUpdate', (oldState, newState) => {
        if (newState.id !== rawClient.user?.id) return;
        void voice
          .onVoiceState(
            newState.guild.id,
            newState.id,
            rawClient.user.id,
            oldState.channelId,
            newState.channelId,
          )
          .catch((error: unknown) => {
            logger.error(
              {
                event: 'gateway.voice_move_failed',
                errorName: error instanceof Error ? error.name : 'unknown',
                guildId: newState.guild.id,
                userId: newState.id,
              },
              'VoiceMove gateway handling failed',
            );
          });
      });
      return Promise.resolve(client);
    },
    stopVoice: async () => {
      if (voiceExpiryTimer !== undefined) clearInterval(voiceExpiryTimer);
      voiceExpiryTimer = undefined;
      await voice.shutdown();
      await voiceAdapter.disconnectAll();
    },
    disconnectDatabase: () => prisma.disconnect(),
    setLifecycleStop: (stop: () => Promise<void>) => {
      stopLifecycle = stop;
    },
  };
}

function addVoiceStopAuthorization(
  commands: readonly CommandDefinition[],
  voice: VoiceService,
  fallback: ReturnType<typeof createPermissionPolicy>,
): readonly CommandDefinition[] {
  return commands.map((command) => {
    if (command.name !== 'voicemove') return command;
    return {
      ...command,
      permissionPolicy: {
        authorize: async (interaction, definition) => {
          let subcommand: string | null | undefined;
          try {
            subcommand = interaction.options.getSubcommand(false);
          } catch {
            subcommand = undefined;
          }
          if (subcommand === 'stop' && interaction.guildId) {
            const session = voice.status(interaction.guildId);
            if (
              session.ok &&
              session.value?.controllerUserId === interaction.user.id
            )
              return true;
          }
          return fallback.authorize(interaction, definition);
        },
        missingBotPermissions: (interaction, required) =>
          fallback.missingBotPermissions(interaction, required),
      },
    };
  });
}

/**
 * Minimal testable coordinator seam: extracts plain DTOs from discord.js
 * GuildMember pair so the handler stays Discord-I/O-only.
 */
export function buildRoleChangeInput(
  before: {
    guild: { id: string };
    id: string;
    displayName: string;
    roles: { cache: Map<string, { name: string }> };
  },
  after: {
    guild: { id: string };
    id: string;
    displayName: string;
    roles: { cache: Map<string, { name: string }> };
  },
  roleNames: ReadonlyMap<string, string>,
  mutedRoleId: string | null,
  occurredAt: Date,
): import('./services/member-role-change-service.js').RoleChangeInput {
  return {
    guildId: after.guild.id,
    targetUserId: after.id,
    targetDisplay: after.displayName,
    beforeRoleIds: [...before.roles.cache.keys()],
    afterRoleIds: [...after.roles.cache.keys()],
    roleNames,
    mutedRoleId,
    occurredAt,
  };
}

function messageView(message: Message | PartialMessage): MessageView | null {
  const author = message.author;
  const content = message.content;
  // A usable view requires a guild message with a resolved author and string
  // content. This rejects partial payloads (e.g. author-present/content-null)
  // so they cannot serve as a sufficient fallback; nullable partial-only fields
  // (content, system) are required or normalized rather than passed as null.
  if (!message.guildId || !author || typeof content !== 'string') return null;
  return {
    guildId: message.guildId,
    channelId: message.channelId,
    messageId: message.id,
    author: author.tag,
    authorId: author.id,
    ...(typeof author.avatarURL === 'function'
      ? (() => {
          const url = author.avatarURL();
          return url ? { avatarUrl: url } : {};
        })()
      : {}),
    content,
    authorIsBot: author.bot,
    webhook: message.webhookId !== null,
    system: message.system === true,
    attachments: [...message.attachments.values()].map((item) => ({
      url: item.url,
      filename: item.name,
      contentType: item.contentType,
      size: item.size,
    })),
    embeds: message.embeds.map((embed) => ({
      title: embed.title,
      description: embed.description,
      url: embed.url,
      fields: embed.fields.map((field) => ({
        name: field.name,
        value: field.value,
      })),
    })),
    flags: message.flags.bitfield,
    mentions: [...message.mentions.users.values()].map((user) => ({
      id: user.id,
      bot: user.bot,
    })),
    roleMentions: [...message.mentions.roles.keys()],
    everyoneMentioned: message.mentions.everyone,
    ...('parentId' in message.channel
      ? { parentChannelId: message.channel.parentId }
      : {}),
    ...('topic' in message.channel
      ? { topic: message.channel.topic ?? null }
      : {}),
    createdAt: message.createdAt,
    url: message.url,
  };
}

export function auditLogEventType(
  action: ExternalAuditEntry['action'],
): AuditLogEvent {
  if (action === 'MEMBER_KICK') return AuditLogEvent.MemberKick;
  if (action === 'MEMBER_BAN_ADD') return AuditLogEvent.MemberBanAdd;
  if (action === 'MEMBER_BAN_REMOVE') return AuditLogEvent.MemberBanRemove;
  return AuditLogEvent.MemberRoleUpdate;
}
export interface MessageDeleteAuditEntry {
  action: unknown;
  createdTimestamp: number;
  target?: { id?: string } | null;
  extra?: { channel?: { id?: string }; count?: number } | null;
  executor?: { tag?: string } | null;
  executorId?: string;
  reason?: string | null;
}
export function matchMessageDeleteAudit(
  entries: readonly MessageDeleteAuditEntry[],
  channelId: string,
  messageIds: readonly string[],
  authorId: string | undefined,
  occurredAt: Date,
): { executor: string; reason: string } | null {
  const matches = entries.filter((entry) => {
    const target = entry.target ?? null;
    const extra = entry.extra ?? null;
    const count = typeof extra?.count === 'number' ? extra.count : 1;
    return (
      (String(entry.action) === '72' || String(entry.action) === '73') &&
      (messageIds.length === 1
        ? authorId !== undefined && target?.id === authorId
        : target?.id === channelId) &&
      count === messageIds.length &&
      Math.abs(occurredAt.getTime() - entry.createdTimestamp) <= 5_000 &&
      extra?.channel?.id === channelId
    );
  });
  const match = matches.length === 1 ? matches[0] : undefined;
  return match
    ? {
        executor: match.executor?.tag ?? match.executorId ?? '不明',
        reason: match.reason ?? '不明',
      }
    : null;
}
export function installMessageLoggingListeners(
  client: Client,
  logging: Pick<
    LoggingEventPipeline,
    'messageCreate' | 'messageUpdate' | 'messageDelete' | 'messageDeleteBulk'
  >,
  settings: SettingsService,
  snapshots: Pick<SnapshotService, 'getMessage' | 'deleteMessage'>,
  logger: ReturnType<typeof createLogger>,
  fatal: (error: unknown) => void,
): void {
  const report = (event: string, operation: Promise<void>): void => {
    void operation.catch((error: unknown) => {
      if (isUnauthorized(error)) {
        fatal(error);
        return;
      }
      logger.error(
        { event, errorName: error instanceof Error ? error.name : 'unknown' },
        'Gateway event failed',
      );
    });
  };
  const isBotLogMessage = async (
    message: Message | PartialMessage,
  ): Promise<boolean> => {
    if (!message.guildId) return false;
    const result = await settings.get(message.guildId);
    if (!result.ok || !isConfiguredLogChannel(message.channelId, result.value))
      return false;
    const botUserId = client.user?.id;
    // Complete payload: suppress only Pathtex's own log messages so that other
    // bots and webhooks in a configured log channel remain eligible for logging.
    if (message.author) return message.author.id === botUserId;
    // Partial payload (author uncached): identify Pathtex via the snapshot author.
    const snapshot = await snapshots.getMessage(message.id);
    return (
      snapshot.ok &&
      isBotAuthoredMessage(undefined, snapshot.value?.authorUserId, botUserId)
    );
  };
  const queue = new MessageLaneQueue();
  client.on('messageCreate', (message) => {
    report(
      'gateway.message_create_failed',
      queue.run(message.id, async () => {
        if (await isBotLogMessage(message)) {
          await snapshots.deleteMessage(message.id);
          return;
        }
        const view = messageView(message);
        if (view) await logging.messageCreate(view);
      }),
    );
  });
  client.on('messageUpdate', (before, after) => {
    const occurredAt = new Date();
    // discord.js types newMessage as a full Message but emits a PartialMessage
    // at runtime when the updated message is uncached; widen to handle both.
    const updated = after as Message | PartialMessage;
    report(
      'gateway.message_update_failed',
      queue.run(updated.id, async () => {
        if (await isBotLogMessage(updated)) {
          await snapshots.deleteMessage(updated.id);
          return;
        }
        const oldView = messageView(before);
        let newView: MessageView | null = null;
        if (updated.partial) {
          // Partial payload: complete it via REST.
          let fetched: Message | null = null;
          try {
            fetched = await updated.fetch();
          } catch (error) {
            // A 401 must reach the fatal handler even when the partial payload
            // is otherwise loggable; never mask an auth failure with a fallback.
            if (isUnauthorized(error)) throw error;
            // Other failures: fall back to the existing payload when it still
            // yields a sufficient view; otherwise surface the error as before.
            newView = messageView(after);
            if (!newView) throw error;
          }
          if (fetched) {
            // Re-apply the Pathtex-self recursion guard on the authoritative
            // payload: a partial's uncached author can mask Pathtex's own message.
            if (await isBotLogMessage(fetched)) {
              await snapshots.deleteMessage(updated.id);
              return;
            }
            newView = messageView(fetched);
          }
        } else {
          // Complete payload: use it directly without a REST fetch.
          newView = messageView(updated);
        }
        if (newView) await logging.messageUpdate(oldView, newView, occurredAt);
      }),
    );
  });
  client.on('messageDelete', (message) => {
    const occurredAt = new Date();
    report(
      'gateway.message_delete_failed',
      queue.run(message.id, async () => {
        if (!message.guildId) return;
        if (await isBotLogMessage(message)) {
          await snapshots.deleteMessage(message.id);
          return;
        }
        const view = messageView(message);
        await logging.messageDelete(
          view,
          message.guildId,
          message.id,
          occurredAt,
        );
      }),
    );
  });
  client.on('messageDeleteBulk', (messages) => {
    const occurredAt = new Date();
    const first = messages.first();
    if (!first?.guildId) return;
    report(
      'gateway.message_bulk_delete_failed',
      queue.runMany([...messages.keys()], async () => {
        const all = [...messages.values()];
        const settingsResult = await settings.get(first.guildId);
        const excluded = new Set<string>();
        if (
          settingsResult.ok &&
          isConfiguredLogChannel(first.channelId, settingsResult.value)
        ) {
          await Promise.all(
            all.map(async (message) => {
              if (await isBotLogMessage(message)) excluded.add(message.id);
            }),
          );
        }
        await Promise.all(
          [...excluded].map((id) => snapshots.deleteMessage(id)),
        );
        const ids = [...messages.keys()].filter((id) => !excluded.has(id));
        if (ids.length === 0) return;
        const cached = all
          .filter((message) => !excluded.has(message.id))
          .map((message) => messageView(message))
          .filter((value): value is MessageView => value !== null);
        await logging.messageDeleteBulk(
          first.guildId,
          first.channelId,
          ids,
          cached,
          occurredAt,
        );
      }),
    );
  });
}

export function installGatewayListeners(
  client: Client,
  logging: LoggingEventPipeline,
  settings: SettingsService,
  snapshots: SnapshotService,
  activeMutes: PrismaActiveMuteRepository,
  moderationDiscord: DiscordModerationAdapter,
  scheduler: SchedulerService,
  lifecycle: PrismaDepartureRepository,
  configuration: ConfigurationService,
  ignores: IgnoreConfigurationService,
  correlations: CorrelationCache,
  roleCorrelation: RoleCorrelationCache,
  cases: CaseService,
  moderationLog: ModerationLogService,
  externalEvents: ExternalEventService,
  memberRoleChange: MemberRoleChangeService,
  raid: RaidService,
  automod: AutomodService,
  logger: ReturnType<typeof createLogger>,
  fatal: (error: unknown) => void,
  targetIdentityResolver: TargetIdentityResolver,
): void {
  const report = (event: string, operation: Promise<void>): void => {
    void operation.catch((error: unknown) => {
      if (isUnauthorized(error)) {
        fatal(error);
        return;
      }
      logger.error(
        { event, errorName: error instanceof Error ? error.name : 'unknown' },
        'Gateway event failed',
      );
    });
  };
  const deliverExternalCase = async (
    guildId: string,
    result: ExternalEventResult,
  ): Promise<void> => {
    if (result.created && result.case) {
      const delivery = await moderationLog.writeCase(guildId, result.case.id);
      if (delivery.status === 'failed')
        throw new Error(
          `External case log failed: ${delivery.errorCode ?? 'UNKNOWN'}`,
        );
    }
  };
  installMessageLoggingListeners(
    client,
    logging,
    settings,
    snapshots,
    logger,
    fatal,
  );
  client.on(
    'voiceStateUpdate',
    (oldState: VoiceState, newState: VoiceState) => {
      if (!newState.member) return;
      const voiceOccurredAt = new Date();
      report(
        'gateway.voice_update_failed',
        logging.voice(
          newState.guild.id,
          newState.member.displayName,
          newState.id,
          oldState.channelId,
          newState.channelId,
          voiceOccurredAt,
        ),
      );
    },
  );
  client.on('guildMemberAdd', (member) => {
    const joinOccurredAt = new Date();
    report(
      'gateway.member_add_failed',
      (async () => {
        await snapshots.saveMember({
          guildId: member.guild.id,
          userId: member.id,
          username: member.user.username,
          globalName: member.user.globalName,
          nickname: member.nickname,
          joinedAt: member.joinedAt,
        });
        await logging.server(
          member.guild.id,
          'メンバー参加',
          [{ name: 'ユーザー', value: `${member.user.tag} (${member.id})` }],
          joinOccurredAt,
          0x3498db,
        );
        await raid.memberAdd({
          guildId: member.guild.id,
          userId: member.id,
          isBot: member.user.bot,
          displayName: member.displayName,
        });
        await moderationDiscord.withRoleMutationLock(
          member.guild.id,
          member.id,
          async () => {
            const mute = await activeMutes.getActive(
              member.guild.id,
              member.id,
            );
            const guildSettings = await settings.get(member.guild.id);
            if (mute && mute.expiresAt && mute.expiresAt <= new Date()) {
              await activeMutes.releaseWithSchedule(
                member.guild.id,
                member.id,
                'EXPIRED',
              );
            } else if (
              mute &&
              guildSettings.ok &&
              guildSettings.value.mutedRoleId
            ) {
              const mutedRoleId = guildSettings.value.mutedRoleId;
              // Check actual role presence; no-op if already present.
              if (
                await moderationDiscord.hasRole(
                  member.guild.id,
                  member.id,
                  mutedRoleId,
                )
              )
                return;
              roleCorrelation.put(
                member.guild.id,
                member.id,
                mutedRoleId,
                'ADD',
              );
              try {
                await moderationDiscord.addRoleUnlocked(
                  member.guild.id,
                  member.id,
                  mutedRoleId,
                  'mute restore',
                );
              } catch (error) {
                roleCorrelation.remove(
                  member.guild.id,
                  member.id,
                  mutedRoleId,
                  'ADD',
                );
                throw error;
              }
            }
          },
        );
        if (!member.user.bot)
          await automod.autoDehoist(
            member.guild.id,
            member.id,
            member.displayName,
          );
      })(),
    );
  });
  client.on('guildMemberRemove', (member) => {
    report(
      'gateway.member_remove_failed',
      (async () => {
        const result = await externalEvents.process({
          guildId: member.guild.id,
          targetUserId: member.id,
          kind: 'MEMBER_REMOVE',
          occurredAt: new Date(),
          memberDisplayName: member.displayName,
          snapshot: {
            guildId: member.guild.id,
            userId: member.id,
            username: member.user.username,
            globalName: member.user.globalName,
            nickname: member.nickname,
            joinedAt: member.joinedAt,
          },
        });
        await deliverExternalCase(member.guild.id, result);
      })(),
    );
  });
  client.on('guildMemberUpdate', (before, after) => {
    if (!after.user.bot)
      report(
        'gateway.member_dehoist_failed',
        automod
          .autoDehoist(after.guild.id, after.id, after.displayName)
          .then(() => undefined),
      );
    // — Synchronous capture of ALL gateway role state before any await —
    const occurredAt = new Date();
    const targetDisplay = after.displayName;
    const beforeRoleIds: string[] = [...before.roles.cache.keys()];
    const afterRoleIds: string[] = [...after.roles.cache.keys()];
    const roleNames = new Map<string, string>();
    for (const [id, role] of before.roles.cache) roleNames.set(id, role.name);
    for (const [id, role] of after.roles.cache) roleNames.set(id, role.name);
    // — Single coordinator: serial lanes with shared settings & audit results —
    report(
      'gateway.member_update_role_coordinator_failed',
      (async () => {
        const configured = await settings.get(after.guild.id);
        const mutedRoleId =
          (configured.ok ? configured.value.mutedRoleId : null) ?? null;
        // Construct input from pre-await captured values; never re-read live caches.
        const input = {
          guildId: after.guild.id,
          targetUserId: after.id,
          targetDisplay,
          beforeRoleIds,
          afterRoleIds,
          roleNames,
          mutedRoleId,
          occurredAt,
        } satisfies import('./services/member-role-change-service.js').RoleChangeInput;
        // Lane 1: generic per-role server logging (includes Muted).
        let shared:
          Awaited<ReturnType<typeof memberRoleChange.process>> | undefined;
        try {
          shared = await memberRoleChange.process(input);
        } catch (error: unknown) {
          const status =
            typeof error === 'object' && error !== null && 'status' in error
              ? (error as { status?: unknown }).status
              : undefined;
          const code =
            typeof error === 'object' && error !== null && 'code' in error
              ? (error as { code?: unknown }).code
              : undefined;
          if (status === 401 || code === 401) throw error;
          logger.error(
            {
              event: 'role_change.generic_lane_failed',
              guildId: after.guild.id,
              errorName: error instanceof Error ? error.name : 'unknown',
            },
            'Generic role-change lane failed',
          );
        }
        // Lane 2: Muted external case/dedupe/modlog (failure-isolated from generic).
        if (!mutedRoleId) return;
        const mutedAdded =
          !beforeRoleIds.includes(mutedRoleId) &&
          afterRoleIds.includes(mutedRoleId);
        const mutedRemoved =
          beforeRoleIds.includes(mutedRoleId) &&
          !afterRoleIds.includes(mutedRoleId);
        if (!mutedAdded && !mutedRemoved) return;
        const mutedDirection = mutedAdded ? 'ADD' : 'REMOVE';
        const mutedKey = `${mutedRoleId}:${mutedDirection}`;
        try {
          // Dedupe: Bot-initiated via roleCorrelation → already covered by generic log.
          if (shared?.correlatedKeys.has(mutedKey)) return;
          // Resolve executor from shared audit results.
          const resolution = shared?.auditResults.get(mutedKey);
          const executorUserId =
            resolution?.status === 'matched' &&
            resolution.executorUserId !== null
              ? resolution.executorUserId
              : null;
          const auditEntryId =
            resolution?.status === 'matched' ? resolution.auditEntryId : null;
          if (!executorUserId || !auditEntryId) return;
          // Self-Bot → skip external case (generic log already Bot-attributed).
          const botUserId = await moderationDiscord.getBotUserId(
            after.guild.id,
          );
          if (executorUserId === botUserId) return;
          // Resolve target identity through canonical resolver for proper
          // display fallback/normalization before creating external case.
          const identity = await targetIdentityResolver.resolve(
            after.guild.id,
            after.id,
            { member: { displayName: targetDisplay } },
          );
          // Create external case + deliver modlog (only if actually created).
          const caseAction: 'MUTE' | 'UNMUTE' =
            mutedDirection === 'ADD' ? 'MUTE' : 'UNMUTE';
          const created = await cases.createExternalCaseResult({
            guildId: after.guild.id,
            action: caseAction,
            targetUserId: identity.userId,
            targetDisplay: identity.displayName,
            moderatorUserId: executorUserId,
            source: 'EXTERNAL',
            status: 'COMPLETED',
            reason: '外部操作',
            discordAuditLogEntryId: auditEntryId,
          });
          if (created.ok && created.value.created) {
            await moderationLog.writeCase(
              after.guild.id,
              created.value.case.id,
            );
          }
        } catch (error: unknown) {
          const status =
            typeof error === 'object' && error !== null && 'status' in error
              ? (error as { status?: unknown }).status
              : undefined;
          const code =
            typeof error === 'object' && error !== null && 'code' in error
              ? (error as { code?: unknown }).code
              : undefined;
          if (status === 401 || code === 401) throw error;
          logger.error(
            {
              event: 'role_change.muted_lane_failed',
              guildId: after.guild.id,
              errorName: error instanceof Error ? error.name : 'unknown',
            },
            'Muted external-case lane failed',
          );
        }
      })(),
    );
    if (before.displayName === after.displayName) return;
    report(
      'gateway.member_update_failed',
      logging.server(
        after.guild.id,
        'メンバー更新',
        [
          { name: 'ユーザー', value: `${after.user.tag} (${after.id})` },
          { name: '変更前', value: before.displayName },
          { name: '変更後', value: after.displayName },
        ],
        occurredAt,
        0x3498db,
      ),
    );
  });
  client.on('userUpdate', (before, after) => {
    if (
      before.username === after.username &&
      before.globalName === after.globalName
    )
      return;
    const userUpdateOccurredAt = new Date();
    report(
      'gateway.user_update_failed',
      logging.userUpdate(
        after.id,
        after.username,
        after.globalName,
        userUpdateOccurredAt,
      ),
    );
  });
  client.on('guildBanAdd', (ban) => {
    report(
      'gateway.ban_add_failed',
      (async () => {
        const result = await externalEvents.process({
          guildId: ban.guild.id,
          targetUserId: ban.user.id,
          kind: 'BAN_ADD',
          occurredAt: new Date(),
        });
        await deliverExternalCase(ban.guild.id, result);
      })(),
    );
  });
  client.on('guildBanRemove', (ban) => {
    report(
      'gateway.ban_remove_failed',
      (async () => {
        const result = await externalEvents.process({
          guildId: ban.guild.id,
          targetUserId: ban.user.id,
          kind: 'BAN_REMOVE',
          occurredAt: new Date(),
        });
        await deliverExternalCase(ban.guild.id, result);
      })(),
    );
  });
  client.on('channelCreate', (channel) => {
    void (async () => {
      const guild = channel.guild;
      const role = guild.roles.cache.find((item) => item.name === 'Muted');
      if (role && 'permissionOverwrites' in channel)
        await channel.permissionOverwrites.edit(role, {
          ...(channel.isVoiceBased()
            ? { Speak: false }
            : {
                SendMessages: false,
                AddReactions: false,
                CreatePublicThreads: false,
                CreatePrivateThreads: false,
                SendMessagesInThreads: false,
                SendVoiceMessages: false,
              }),
        });
    })().catch((error: unknown) => {
      logger.error(
        {
          event: 'gateway.channel_muted_overwrite_failed',
          errorName: error instanceof Error ? error.name : 'unknown',
        },
        'Muted role overwrite failed',
      );
    });
  });
  client.on('channelUpdate', (_before, after) => {
    const guildChannel = after as unknown as {
      guild: { id: string };
      id: string;
    };
    const internalSlowmode = correlations.consume(
      'slowmode',
      `${guildChannel.guild.id}:${guildChannel.id}`,
    );
    if (!internalSlowmode)
      void scheduler.cancel({
        guildId: guildChannel.guild.id,
        targetUserId: null,
        channelId: guildChannel.id,
        type: 'RESTORE_SLOWMODE',
      });
  });
  client.on('channelDelete', (channel) => {
    if ('guildId' in channel && channel.guildId) {
      const guildId = channel.guildId;
      const channelId = channel.id;
      report(
        'gateway.channel_delete_failed',
        (async () => {
          try {
            await ignores.clearChannel(guildId, channelId);
          } finally {
            settings.invalidate(guildId);
          }
        })(),
      );
    }
  });
  client.on('roleDelete', (role) => {
    settings.invalidate(role.guild.id);
  });
  client.on('guildDelete', (guild) => {
    settings.invalidate(guild.id);
    report(
      'gateway.guild_delete_failed',
      lifecycle
        .markLeft({ guildId: guild.id, departedAt: new Date() })
        .then(() => undefined),
    );
  });
  client.on('guildCreate', (guild) => {
    report(
      'gateway.guild_create_failed',
      lifecycle.markActive(guild.id).then(() => undefined),
    );
  });
  client.on('error', (error) => {
    logger.error(
      { event: 'gateway.client_error', errorName: error.name },
      'Discord client error',
    );
  });
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config, context(config.INSTANCE_ID));
  const dependencies = createBootstrapDependencies(config, logger);
  const lifecycle = createRuntimeLifecycle(
    logger,
    {
      validateDatabase: dependencies.database,
      applyMigrations: dependencies.migrations,
      loadResources: dependencies.resources,
      registerCommands: dependencies.registerCommands,
      createClient: dependencies.createClient,
      recoverStaleJobs: dependencies.recoverStaleJobs,
      schedulerDispatcher: dependencies.schedulerDispatcher,
      startScheduler: dependencies.scheduler,
      stopScheduler: dependencies.stopScheduler,
      startIntake: dependencies.intake,
      stopIntake: dependencies.stopIntake,
      drainIntake: dependencies.drainIntake,
      stopVoice: dependencies.stopVoice,
      disconnectDatabase: dependencies.disconnectDatabase,
    },
    config,
  );
  dependencies.setLifecycleStop(() => lifecycle.stop());
  const shutdownState = { value: false };
  const requestShutdown = (): void => {
    shutdownState.value = true;
    process.exitCode = 0;
    void lifecycle.stop();
  };
  process.once('SIGTERM', requestShutdown);
  process.once('SIGINT', requestShutdown);
  try {
    await lifecycle.start();
  } catch (error: unknown) {
    if (!shutdownState.value) throw error;
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  try {
    await main();
  } catch {
    process.stderr.write(
      'Bootstrap failed; see sanitized startup diagnostics.\n',
    );
    process.exitCode = 1;
  }
}
