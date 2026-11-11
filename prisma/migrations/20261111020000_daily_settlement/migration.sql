-- Freeze completed days. Later tracking writes are clipped to this boundary.
ALTER TABLE "reputation_guilds" ADD COLUMN "settled_through" TIMESTAMPTZ(3);

CREATE TABLE "reputation_settlements" (
    "guild_id" VARCHAR(20) NOT NULL,
    "day" VARCHAR(10) NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3) NOT NULL,
    "settled_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_ms" INTEGER NOT NULL,
    "incomplete" BOOLEAN NOT NULL,
    "activity_ms" BIGINT NOT NULL,
    "points_awarded" INTEGER NOT NULL,

    CONSTRAINT "reputation_settlements_pkey" PRIMARY KEY ("guild_id", "day"),
    CONSTRAINT "reputation_settlements_range_check" CHECK ("ended_at" > "started_at"),
    CONSTRAINT "reputation_settlements_totals_check" CHECK ("verified_ms" >= 0 AND "activity_ms" >= 0 AND "points_awarded" >= 0)
);

CREATE TABLE "reputation_daily_awards" (
    "guild_id" VARCHAR(20) NOT NULL,
    "user_id" VARCHAR(20) NOT NULL,
    "day" VARCHAR(10) NOT NULL,
    "eligible_ms" INTEGER NOT NULL,
    "points" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,

    CONSTRAINT "reputation_daily_awards_pkey" PRIMARY KEY ("guild_id", "user_id", "day"),
    CONSTRAINT "reputation_daily_awards_totals_check" CHECK ("eligible_ms" >= 0 AND "points" >= 0 AND "balance_after" >= 0)
);

CREATE INDEX "reputation_daily_awards_guild_id_day_points_eligible_ms_use_idx" ON "reputation_daily_awards"("guild_id", "day", "points", "eligible_ms", "user_id");

ALTER TABLE "reputation_settlements" ADD CONSTRAINT "reputation_settlements_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "reputation_guilds"("guild_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reputation_daily_awards" ADD CONSTRAINT "reputation_daily_awards_guild_id_user_id_fkey" FOREIGN KEY ("guild_id", "user_id") REFERENCES "reputation_members"("guild_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reputation_daily_awards" ADD CONSTRAINT "reputation_daily_awards_guild_id_day_fkey" FOREIGN KEY ("guild_id", "day") REFERENCES "reputation_settlements"("guild_id", "day") ON DELETE RESTRICT ON UPDATE CASCADE;
