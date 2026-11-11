BEGIN;
CREATE TABLE "voice_penalty_polls" (
  "id" UUID NOT NULL PRIMARY KEY,
  "guild_id" VARCHAR(20) NOT NULL,
  "target_id" VARCHAR(20) NOT NULL,
  "initiator_id" VARCHAR(20) NOT NULL,
  "voice_channel_id" VARCHAR(20) NOT NULL,
  "text_channel_id" VARCHAR(20) NOT NULL,
  "message_id" VARCHAR(20),
  "amount" INTEGER NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'creating',
  "reason" VARCHAR(32),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMPTZ(3),
  "ends_at" TIMESTAMPTZ(3),
  "closed_at" TIMESTAMPTZ(3),
  "actual_fine" INTEGER NOT NULL DEFAULT 0,
  "balance_after" INTEGER,
  "no_voter_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "publishing" BOOLEAN NOT NULL DEFAULT false,
  "published_at" TIMESTAMPTZ(3),
  "message_missing" BOOLEAN NOT NULL DEFAULT false,
  "last_attempt_at" TIMESTAMPTZ(3),
  CONSTRAINT "voice_penalty_polls_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "reputation_guilds"("guild_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "voice_penalty_polls_values_check" CHECK (
    "amount" IN (10,50,100) AND "target_id" <> "initiator_id"
    AND "status" IN ('creating','active','succeeded','failed','cancelled')
    AND "actual_fine" BETWEEN 0 AND "amount"
    AND ("balance_after" IS NULL OR "balance_after" BETWEEN -500 AND 5000)
    AND ("status" <> 'active' OR ("message_id" IS NOT NULL AND "started_at" IS NOT NULL AND "ends_at" IS NOT NULL))
    AND ("ends_at" IS NULL OR "ends_at" = "started_at" + INTERVAL '120 seconds')
    AND ("status" <> 'succeeded' OR ("actual_fine" > 0 AND "balance_after" IS NOT NULL))
    AND ("status" = 'succeeded' OR "actual_fine" = 0)
  )
);
CREATE UNIQUE INDEX "voice_penalty_polls_message_id_key" ON "voice_penalty_polls"("message_id");
CREATE UNIQUE INDEX "voice_penalty_polls_one_active_target_idx" ON "voice_penalty_polls"("guild_id","target_id") WHERE "status" IN ('creating','active');
CREATE INDEX "voice_penalty_polls_guild_id_status_ends_at_idx" ON "voice_penalty_polls"("guild_id","status","ends_at");
CREATE INDEX "voice_penalty_polls_guild_id_published_at_last_attempt_at_idx" ON "voice_penalty_polls"("guild_id","published_at","last_attempt_at");
CREATE TABLE "voice_penalty_votes" (
  "poll_id" UUID NOT NULL,
  "user_id" VARCHAR(20) NOT NULL,
  "yes" BOOLEAN NOT NULL,
  "interaction_id" VARCHAR(20) NOT NULL DEFAULT '0',
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "voice_penalty_votes_pkey" PRIMARY KEY ("poll_id","user_id"),
  CONSTRAINT "voice_penalty_votes_interaction_check" CHECK ("interaction_id" ~ '^[0-9]{1,20}$'),
  CONSTRAINT "voice_penalty_votes_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "voice_penalty_polls"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "voice_penalty_votes_user_id_poll_id_idx" ON "voice_penalty_votes"("user_id","poll_id");
COMMIT;
