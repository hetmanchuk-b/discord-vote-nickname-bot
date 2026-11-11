CREATE TYPE "ReputationReportStatus" AS ENUM ('pending', 'publishing', 'published', 'missing');

CREATE TABLE "reputation_reports" (
    "id" UUID NOT NULL,
    "guild_id" VARCHAR(20) NOT NULL,
    "day" VARCHAR(10) NOT NULL,
    "status" "ReputationReportStatus" NOT NULL DEFAULT 'pending',
    "channel_id" VARCHAR(20),
    "message_id" VARCHAR(20),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prepared_at" TIMESTAMPTZ(3),
    "last_attempt_at" TIMESTAMPTZ(3),
    "published_at" TIMESTAMPTZ(3),
    "activity_ms" BIGINT NOT NULL DEFAULT 0,
    "points_awarded" INTEGER NOT NULL DEFAULT 0,
    "entry_count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "reputation_reports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reputation_reports_totals_check" CHECK ("activity_ms" >= 0 AND "points_awarded" >= 0 AND "entry_count" >= 0)
);

CREATE TABLE "reputation_report_entries" (
    "report_id" UUID NOT NULL,
    "guild_id" VARCHAR(20) NOT NULL,
    "user_id" VARCHAR(20) NOT NULL,
    "position" INTEGER NOT NULL,
    "eligible_ms" INTEGER NOT NULL,
    "points" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,
    CONSTRAINT "reputation_report_entries_pkey" PRIMARY KEY ("report_id", "position"),
    CONSTRAINT "reputation_report_entries_values_check" CHECK ("position" >= 0 AND "eligible_ms" >= 600000 AND "points" > 0 AND "balance_after" >= 0)
);

CREATE TABLE "reputation_warnings" (
    "guild_id" VARCHAR(20) NOT NULL,
    "channel_id" VARCHAR(20),
    "message_id" VARCHAR(20),
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active_since" TIMESTAMPTZ(3),
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "last_edited_at" TIMESTAMPTZ(3),
    "displayed_active" BOOLEAN NOT NULL DEFAULT false,
    "delivery_uncertain" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "reputation_warnings_pkey" PRIMARY KEY ("guild_id")
);

CREATE UNIQUE INDEX "reputation_reports_message_id_key" ON "reputation_reports"("message_id");
CREATE INDEX "reputation_reports_guild_id_status_day_idx" ON "reputation_reports"("guild_id", "status", "day");
CREATE UNIQUE INDEX "reputation_reports_guild_id_day_key" ON "reputation_reports"("guild_id", "day");
CREATE INDEX "reputation_report_entries_guild_id_user_id_idx" ON "reputation_report_entries"("guild_id", "user_id");
CREATE UNIQUE INDEX "reputation_report_entries_report_id_user_id_key" ON "reputation_report_entries"("report_id", "user_id");

ALTER TABLE "reputation_reports" ADD CONSTRAINT "reputation_reports_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "reputation_guilds"("guild_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reputation_reports" ADD CONSTRAINT "reputation_reports_guild_id_day_fkey" FOREIGN KEY ("guild_id", "day") REFERENCES "reputation_settlements"("guild_id", "day") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reputation_report_entries" ADD CONSTRAINT "reputation_report_entries_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reputation_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reputation_warnings" ADD CONSTRAINT "reputation_warnings_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "reputation_guilds"("guild_id") ON DELETE RESTRICT ON UPDATE CASCADE;
