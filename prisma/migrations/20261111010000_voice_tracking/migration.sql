-- The current run token fences stale/replaced tracking processes.
ALTER TABLE "reputation_guilds" ADD COLUMN "tracking_run_id" UUID;

CREATE TABLE "reputation_tracking_runs" (
    "id" UUID NOT NULL,
    "guild_id" VARCHAR(20) NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "verified_through" TIMESTAMPTZ(3) NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    "end_reason" VARCHAR(32),

    CONSTRAINT "reputation_tracking_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reputation_tracking_runs_verified_check" CHECK ("verified_through" >= "started_at")
);

CREATE TABLE "reputation_voice_intervals" (
    "id" BIGSERIAL NOT NULL,
    "guild_id" VARCHAR(20) NOT NULL,
    "user_id" VARCHAR(20) NOT NULL,
    "run_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reputation_voice_intervals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reputation_voice_intervals_duration_check" CHECK ("ended_at" > "started_at")
);

CREATE INDEX "reputation_tracking_runs_guild_id_started_at_idx" ON "reputation_tracking_runs"("guild_id", "started_at");
CREATE INDEX "reputation_voice_intervals_guild_id_ended_at_started_at_idx" ON "reputation_voice_intervals"("guild_id", "ended_at", "started_at");
CREATE INDEX "reputation_voice_intervals_guild_id_user_id_started_at_idx" ON "reputation_voice_intervals"("guild_id", "user_id", "started_at");

ALTER TABLE "reputation_tracking_runs" ADD CONSTRAINT "reputation_tracking_runs_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "reputation_guilds"("guild_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reputation_voice_intervals" ADD CONSTRAINT "reputation_voice_intervals_guild_id_user_id_fkey" FOREIGN KEY ("guild_id", "user_id") REFERENCES "reputation_members"("guild_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reputation_voice_intervals" ADD CONSTRAINT "reputation_voice_intervals_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "reputation_tracking_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
