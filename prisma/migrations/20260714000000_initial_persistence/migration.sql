-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "RaidModeSource" AS ENUM ('MANUAL', 'AUTO');

-- CreateEnum
CREATE TYPE "PunishmentAction" AS ENUM ('MUTE', 'KICK', 'SOFTBAN', 'BAN');

-- CreateEnum
CREATE TYPE "StrikeSource" AS ENUM ('MANUAL_STRIKE', 'PARDON', 'AUTOMOD');

-- CreateEnum
CREATE TYPE "CaseAction" AS ENUM ('KICK', 'BAN', 'SOFTBAN', 'SILENTBAN', 'UNBAN', 'MUTE', 'UNMUTE', 'STRIKE', 'PARDON', 'RAIDMODE_ON', 'RAIDMODE_OFF', 'VOICEKICK', 'SLOWMODE', 'AUTO_PUNISHMENT');

-- CreateEnum
CREATE TYPE "CaseSource" AS ENUM ('COMMAND', 'AUTOMOD', 'PUNISHMENT', 'RAIDMODE', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "ScheduledActionType" AS ENUM ('UNBAN', 'UNMUTE', 'RESTORE_SLOWMODE', 'DISABLE_RAIDMODE');

-- CreateEnum
CREATE TYPE "ScheduledActionStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ActiveMuteStatus" AS ENUM ('ACTIVE', 'RELEASED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "GuildLifecycleStatus" AS ENUM ('ACTIVE', 'LEFT');

-- CreateTable
CREATE TABLE "guild_settings" (
    "guild_id" VARCHAR(20) NOT NULL,
    "modlog_channel_id" VARCHAR(20),
    "message_log_channel_id" VARCHAR(20),
    "server_log_channel_id" VARCHAR(20),
    "voice_log_channel_id" VARCHAR(20),
    "mod_role_id" VARCHAR(20),
    "muted_role_id" VARCHAR(20),
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "raid_mode_enabled" BOOLEAN NOT NULL DEFAULT false,
    "raid_mode_source" "RaidModeSource",
    "raid_mode_reason" VARCHAR(1000),
    "raid_started_at" TIMESTAMPTZ(6),
    "verification_level_before_raid" SMALLINT,
    "raid_verification_changed" BOOLEAN NOT NULL DEFAULT false,
    "next_case_number" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "guild_settings_pkey" PRIMARY KEY ("guild_id")
);

-- CreateTable
CREATE TABLE "automod_settings" (
    "guild_id" VARCHAR(20) NOT NULL,
    "anti_invite_strikes" SMALLINT NOT NULL DEFAULT 0,
    "anti_referral_strikes" SMALLINT NOT NULL DEFAULT 0,
    "anti_everyone_strikes" SMALLINT NOT NULL DEFAULT 0,
    "anti_copypasta_strikes" SMALLINT NOT NULL DEFAULT 0,
    "max_user_mentions" SMALLINT,
    "max_role_mentions" SMALLINT,
    "max_lines" SMALLINT,
    "duplicate_enabled" BOOLEAN NOT NULL DEFAULT false,
    "duplicate_delete_threshold" SMALLINT,
    "duplicate_strike_threshold" SMALLINT,
    "duplicate_strikes" SMALLINT NOT NULL DEFAULT 1,
    "autodehoist_character" VARCHAR(8),
    "auto_raid_enabled" BOOLEAN NOT NULL DEFAULT false,
    "auto_raid_join_count" SMALLINT NOT NULL DEFAULT 10,
    "auto_raid_window_seconds" SMALLINT NOT NULL DEFAULT 10,
    "auto_raid_idle_seconds" SMALLINT NOT NULL DEFAULT 120,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "automod_settings_pkey" PRIMARY KEY ("guild_id")
);

-- CreateTable
CREATE TABLE "punishments" (
    "id" UUID NOT NULL,
    "guild_id" VARCHAR(20) NOT NULL,
    "threshold" INTEGER NOT NULL,
    "action" "PunishmentAction" NOT NULL,
    "duration_seconds" INTEGER,
    "created_by" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "punishments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_strikes" (
    "guild_id" VARCHAR(20) NOT NULL,
    "user_id" VARCHAR(20) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_strikes_pkey" PRIMARY KEY ("guild_id","user_id")
);

-- CreateTable
CREATE TABLE "strike_transactions" (
    "id" UUID NOT NULL,
    "guild_id" VARCHAR(20) NOT NULL,
    "user_id" VARCHAR(20) NOT NULL,
    "delta" INTEGER NOT NULL,
    "requested_delta" INTEGER NOT NULL,
    "before_count" INTEGER NOT NULL,
    "after_count" INTEGER NOT NULL,
    "source" "StrikeSource" NOT NULL,
    "actor_user_id" VARCHAR(20) NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "mod_case_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strike_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation_cases" (
    "id" UUID NOT NULL,
    "guild_id" VARCHAR(20) NOT NULL,
    "case_number" INTEGER NOT NULL,
    "action" "CaseAction" NOT NULL,
    "target_user_id" VARCHAR(20),
    "target_display" VARCHAR(128) NOT NULL,
    "moderator_user_id" VARCHAR(20) NOT NULL,
    "reason" VARCHAR(1000),
    "duration_seconds" INTEGER,
    "source" "CaseSource" NOT NULL,
    "status" "CaseStatus" NOT NULL,
    "error_code" VARCHAR(64),
    "log_message_id" VARCHAR(20),
    "log_channel_id" VARCHAR(20),
    "discord_audit_log_entry_id" VARCHAR(20),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "moderation_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_actions" (
    "id" UUID NOT NULL,
    "guild_id" VARCHAR(20) NOT NULL,
    "target_user_id" VARCHAR(20),
    "channel_id" VARCHAR(20),
    "type" "ScheduledActionType" NOT NULL,
    "execute_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "ScheduledActionStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "locked_at" TIMESTAMPTZ(6),
    "locked_by" VARCHAR(64),
    "last_error" TEXT,
    "created_by_case_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "scheduled_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "active_mutes" (
    "guild_id" VARCHAR(20) NOT NULL,
    "user_id" VARCHAR(20) NOT NULL,
    "case_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "status" "ActiveMuteStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "active_mutes_pkey" PRIMARY KEY ("guild_id","user_id")
);

-- CreateTable
CREATE TABLE "guild_lifecycle_markers" (
    "guild_id" VARCHAR(20) NOT NULL,
    "status" "GuildLifecycleStatus" NOT NULL,
    "departed_at" TIMESTAMPTZ(6),
    "rejoined_at" TIMESTAMPTZ(6),
    "cleanup_eligible_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "guild_lifecycle_markers_pkey" PRIMARY KEY ("guild_id")
);

-- CreateTable
CREATE TABLE "ignored_roles" (
    "guild_id" VARCHAR(20) NOT NULL,
    "role_id" VARCHAR(20) NOT NULL,
    "created_by" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ignored_roles_pkey" PRIMARY KEY ("guild_id","role_id")
);

-- CreateTable
CREATE TABLE "ignored_channels" (
    "guild_id" VARCHAR(20) NOT NULL,
    "channel_id" VARCHAR(20) NOT NULL,
    "created_by" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ignored_channels_pkey" PRIMARY KEY ("guild_id","channel_id")
);

-- CreateTable
CREATE TABLE "message_snapshots" (
    "message_id" VARCHAR(20) NOT NULL,
    "guild_id" VARCHAR(20) NOT NULL,
    "channel_id" VARCHAR(20) NOT NULL,
    "author_user_id" VARCHAR(20) NOT NULL,
    "author_display" VARCHAR(128) NOT NULL,
    "content" TEXT NOT NULL,
    "attachments" JSONB NOT NULL,
    "embeds_summary" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "message_snapshots_pkey" PRIMARY KEY ("message_id")
);

-- CreateTable
CREATE TABLE "guild_member_snapshots" (
    "guild_id" VARCHAR(20) NOT NULL,
    "user_id" VARCHAR(20) NOT NULL,
    "username" VARCHAR(32) NOT NULL,
    "global_name" VARCHAR(32),
    "nickname" VARCHAR(32),
    "joined_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guild_member_snapshots_pkey" PRIMARY KEY ("guild_id","user_id")
);

-- CreateTable
CREATE TABLE "raid_join_events" (
    "id" UUID NOT NULL,
    "guild_id" VARCHAR(20) NOT NULL,
    "user_id" VARCHAR(20) NOT NULL,
    "joined_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "raid_join_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guild_settings_modlog_channel_id_idx" ON "guild_settings"("modlog_channel_id");

-- CreateIndex
CREATE INDEX "guild_settings_message_log_channel_id_idx" ON "guild_settings"("message_log_channel_id");

-- CreateIndex
CREATE INDEX "guild_settings_server_log_channel_id_idx" ON "guild_settings"("server_log_channel_id");

-- CreateIndex
CREATE INDEX "guild_settings_voice_log_channel_id_idx" ON "guild_settings"("voice_log_channel_id");

-- CreateIndex
CREATE INDEX "punishments_guild_id_threshold_idx" ON "punishments"("guild_id", "threshold");

-- CreateIndex
CREATE UNIQUE INDEX "punishments_guild_id_threshold_key" ON "punishments"("guild_id", "threshold");

-- CreateIndex
CREATE INDEX "user_strikes_guild_id_count_idx" ON "user_strikes"("guild_id", "count" DESC);

-- CreateIndex
CREATE INDEX "strike_transactions_guild_id_user_id_created_at_idx" ON "strike_transactions"("guild_id", "user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "strike_transactions_mod_case_id_idx" ON "strike_transactions"("mod_case_id");

-- CreateIndex
CREATE INDEX "moderation_cases_guild_id_created_at_idx" ON "moderation_cases"("guild_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "moderation_cases_guild_id_case_number_idx" ON "moderation_cases"("guild_id", "case_number" DESC);

-- CreateIndex
CREATE INDEX "moderation_cases_guild_id_target_user_id_created_at_idx" ON "moderation_cases"("guild_id", "target_user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "moderation_cases_guild_id_case_number_key" ON "moderation_cases"("guild_id", "case_number");

-- CreateIndex
CREATE UNIQUE INDEX "moderation_cases_guild_id_discord_audit_log_entry_id_key" ON "moderation_cases"("guild_id", "discord_audit_log_entry_id");

-- CreateIndex
CREATE INDEX "scheduled_actions_status_execute_at_idx" ON "scheduled_actions"("status", "execute_at");

-- CreateIndex
CREATE INDEX "scheduled_actions_guild_id_target_user_id_type_status_idx" ON "scheduled_actions"("guild_id", "target_user_id", "type", "status");

-- CreateIndex
CREATE INDEX "scheduled_actions_guild_id_channel_id_type_status_idx" ON "scheduled_actions"("guild_id", "channel_id", "type", "status");

-- CreateIndex
CREATE INDEX "active_mutes_guild_id_status_idx" ON "active_mutes"("guild_id", "status");

-- CreateIndex
CREATE INDEX "active_mutes_expires_at_idx" ON "active_mutes"("expires_at");

-- CreateIndex
CREATE INDEX "guild_lifecycle_markers_status_cleanup_eligible_at_idx" ON "guild_lifecycle_markers"("status", "cleanup_eligible_at");

-- CreateIndex
CREATE INDEX "message_snapshots_guild_id_channel_id_created_at_idx" ON "message_snapshots"("guild_id", "channel_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "message_snapshots_expires_at_idx" ON "message_snapshots"("expires_at");

-- CreateIndex
CREATE INDEX "raid_join_events_guild_id_joined_at_idx" ON "raid_join_events"("guild_id", "joined_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "raid_join_events_guild_id_user_id_joined_at_key" ON "raid_join_events"("guild_id", "user_id", "joined_at");

-- AddForeignKey
ALTER TABLE "automod_settings" ADD CONSTRAINT "automod_settings_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guild_settings"("guild_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "punishments" ADD CONSTRAINT "punishments_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guild_settings"("guild_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_strikes" ADD CONSTRAINT "user_strikes_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guild_settings"("guild_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strike_transactions" ADD CONSTRAINT "strike_transactions_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guild_settings"("guild_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strike_transactions" ADD CONSTRAINT "strike_transactions_mod_case_id_fkey" FOREIGN KEY ("mod_case_id") REFERENCES "moderation_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guild_settings"("guild_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_actions" ADD CONSTRAINT "scheduled_actions_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guild_settings"("guild_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "active_mutes" ADD CONSTRAINT "active_mutes_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guild_settings"("guild_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "active_mutes" ADD CONSTRAINT "active_mutes_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "moderation_cases"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ignored_roles" ADD CONSTRAINT "ignored_roles_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guild_settings"("guild_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ignored_channels" ADD CONSTRAINT "ignored_channels_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guild_settings"("guild_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_snapshots" ADD CONSTRAINT "message_snapshots_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guild_settings"("guild_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guild_member_snapshots" ADD CONSTRAINT "guild_member_snapshots_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guild_settings"("guild_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raid_join_events" ADD CONSTRAINT "raid_join_events_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guild_settings"("guild_id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "guild_settings" ADD CONSTRAINT "guild_settings_next_case_number_positive" CHECK ("next_case_number" > 0);
ALTER TABLE "guild_settings" ADD CONSTRAINT "guild_settings_verification_level_valid" CHECK ("verification_level_before_raid" IS NULL OR "verification_level_before_raid" BETWEEN 0 AND 4);
ALTER TABLE "automod_settings" ADD CONSTRAINT "automod_settings_bounds" CHECK (("anti_invite_strikes" BETWEEN 0 AND 100) AND ("anti_referral_strikes" BETWEEN 0 AND 100) AND ("anti_everyone_strikes" BETWEEN 0 AND 100) AND ("anti_copypasta_strikes" BETWEEN 0 AND 100) AND ("max_user_mentions" IS NULL OR "max_user_mentions" BETWEEN 1 AND 100) AND ("max_role_mentions" IS NULL OR "max_role_mentions" BETWEEN 1 AND 100) AND ("max_lines" IS NULL OR "max_lines" BETWEEN 1 AND 500) AND ("duplicate_delete_threshold" IS NULL OR "duplicate_delete_threshold" BETWEEN 2 AND 20) AND ("duplicate_strike_threshold" IS NULL OR "duplicate_strike_threshold" BETWEEN 2 AND 20) AND "duplicate_strikes" BETWEEN 1 AND 100 AND "auto_raid_join_count" BETWEEN 3 AND 100 AND "auto_raid_window_seconds" BETWEEN 2 AND 300 AND "auto_raid_idle_seconds" = 120);
ALTER TABLE "punishments" ADD CONSTRAINT "punishments_threshold_valid" CHECK ("threshold" BETWEEN 1 AND 1000000);
ALTER TABLE "punishments" ADD CONSTRAINT "punishments_duration_valid" CHECK ("duration_seconds" IS NULL OR "duration_seconds" BETWEEN 1 AND 31536000);
ALTER TABLE "punishments" ADD CONSTRAINT "punishments_action_duration_valid" CHECK (("action" IN ('MUTE', 'BAN')) OR "duration_seconds" IS NULL);
ALTER TABLE "user_strikes" ADD CONSTRAINT "user_strikes_count_valid" CHECK ("count" BETWEEN 0 AND 1000000);
ALTER TABLE "strike_transactions" ADD CONSTRAINT "strike_transactions_bounds" CHECK ("delta" <> 0 AND "before_count" BETWEEN 0 AND 1000000 AND "after_count" BETWEEN 0 AND 1000000);
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_case_number_positive" CHECK ("case_number" > 0);
ALTER TABLE "message_snapshots" ADD CONSTRAINT "message_snapshots_content_length" CHECK (char_length("content") <= 4000);
ALTER TABLE "scheduled_actions" ADD CONSTRAINT "scheduled_actions_attempts_valid" CHECK ("attempts" BETWEEN 0 AND 5);
CREATE UNIQUE INDEX "scheduled_actions_pending_key" ON "scheduled_actions"("guild_id", COALESCE("target_user_id", ''), COALESCE("channel_id", ''), "type") WHERE "status" = 'PENDING';
CREATE UNIQUE INDEX "active_mutes_one_active" ON "active_mutes"("guild_id", "user_id") WHERE "status" = 'ACTIVE';
ALTER TABLE "active_mutes" ADD CONSTRAINT "active_mutes_expiry_valid" CHECK ("expires_at" IS NULL OR "expires_at" > "created_at");
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_duration_valid" CHECK ("duration_seconds" IS NULL OR "duration_seconds" > 0);
ALTER TABLE "guild_lifecycle_markers" ADD CONSTRAINT "guild_lifecycle_left_dates_valid" CHECK ("status" <> 'LEFT' OR ("departed_at" IS NOT NULL AND "cleanup_eligible_at" IS NOT NULL));
ALTER TABLE "automod_settings" ADD CONSTRAINT "automod_settings_autodehoist_one_codepoint" CHECK ("autodehoist_character" IS NULL OR (char_length("autodehoist_character") = 1 AND octet_length("autodehoist_character") <= 8));
ALTER TABLE "punishments" ADD CONSTRAINT "punishments_mute_max_28_days" CHECK ("action" <> 'MUTE' OR "duration_seconds" IS NULL OR "duration_seconds" <= 2419200);
ALTER TABLE "scheduled_actions" ADD CONSTRAINT "scheduled_actions_target_channel_shape" CHECK (
  ("type" IN ('UNBAN', 'UNMUTE') AND "target_user_id" IS NOT NULL AND "channel_id" IS NULL) OR
  ("type" = 'RESTORE_SLOWMODE' AND "target_user_id" IS NULL AND "channel_id" IS NOT NULL) OR
  ("type" = 'DISABLE_RAIDMODE' AND "target_user_id" IS NULL AND "channel_id" IS NULL));
