-- New attendance policy begins on the NEXT full Kyiv day for existing guilds.
-- No historical day is replayed and no retroactive bonus/penalty is generated.
BEGIN;
ALTER TABLE "reputation_guilds" ADD COLUMN "attendance_starts_at" TIMESTAMPTZ(3);
UPDATE "reputation_guilds" SET "attendance_starts_at" = GREATEST(
  ((CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Kyiv')::date + 1)::timestamp AT TIME ZONE 'Europe/Kyiv',
  "settled_through"
);

ALTER TABLE "reputation_members"
  ADD COLUMN "has_participated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "attendance_streak" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "absence_streak" INTEGER NOT NULL DEFAULT 0;
UPDATE "reputation_members" SET "balance" = GREATEST(-500, LEAST(5000, "balance"));
UPDATE "reputation_members" m SET "has_participated" = true
WHERE EXISTS (SELECT 1 FROM "reputation_voice_intervals" v
  JOIN "reputation_guilds" g ON g.guild_id = v.guild_id
  WHERE v.guild_id = m.guild_id AND v.user_id = m.user_id AND v.started_at < g.attendance_starts_at)
OR EXISTS (SELECT 1 FROM "reputation_daily_awards" a
  WHERE a.guild_id = m.guild_id AND a.user_id = m.user_id AND a.eligible_ms > 0);
ALTER TABLE "reputation_members"
  ADD CONSTRAINT "reputation_members_balance_check" CHECK ("balance" BETWEEN -500 AND 5000),
  ADD CONSTRAINT "reputation_members_streaks_check" CHECK (
    "attendance_streak" >= 0 AND "absence_streak" >= 0
    AND NOT ("attendance_streak" > 0 AND "absence_streak" > 0)
    AND ("has_participated" OR ("attendance_streak" = 0 AND "absence_streak" = 0)));

CREATE TABLE "reputation_tracking_pauses" (
  "id" BIGSERIAL PRIMARY KEY,
  "guild_id" VARCHAR(20) NOT NULL,
  "user_id" VARCHAR(20) NOT NULL,
  "started_at" TIMESTAMPTZ(3) NOT NULL,
  "ended_at" TIMESTAMPTZ(3),
  CONSTRAINT "reputation_tracking_pauses_range_check" CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at"),
  CONSTRAINT "reputation_tracking_pauses_member_fkey" FOREIGN KEY ("guild_id", "user_id")
    REFERENCES "reputation_members"("guild_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "reputation_tracking_pauses_guild_id_user_id_started_at_idx"
  ON "reputation_tracking_pauses"("guild_id", "user_id", "started_at");
CREATE UNIQUE INDEX "reputation_tracking_pauses_one_open_idx"
  ON "reputation_tracking_pauses"("guild_id", "user_id") WHERE "ended_at" IS NULL;
-- Old pause timestamps cannot be reconstructed. Record the known disabled
-- state NOW; pre-policy days are already exempt. A future pause start at the
-- policy boundary would incorrectly delay a same-day resume's voice cutoff.
INSERT INTO "reputation_tracking_pauses" ("guild_id", "user_id", "started_at")
SELECT m.guild_id, m.user_id, CURRENT_TIMESTAMP FROM "reputation_members" m WHERE NOT m.is_tracking;

ALTER TABLE "reputation_daily_awards"
  ADD COLUMN "base_points" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "attendance_bonus" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "absence_penalty" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "attendance_streak" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "absence_streak" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "exempt" BOOLEAN NOT NULL DEFAULT false;
UPDATE "reputation_daily_awards" SET "base_points" = "points", "exempt" = true;
ALTER TABLE "reputation_daily_awards" DROP CONSTRAINT "reputation_daily_awards_totals_check";
-- Historical snapshots are not clamped/re-written when introducing live limits.
ALTER TABLE "reputation_daily_awards" ADD CONSTRAINT "reputation_daily_awards_totals_check" CHECK (
  "eligible_ms" >= 0 AND "balance_after" >= -500 AND "base_points" >= 0
  AND "attendance_bonus" >= 0 AND "absence_penalty" >= 0
  AND "attendance_streak" >= 0 AND "absence_streak" >= 0);
ALTER TABLE "reputation_settlements" DROP CONSTRAINT "reputation_settlements_totals_check";
ALTER TABLE "reputation_settlements" ADD CONSTRAINT "reputation_settlements_totals_check"
  CHECK ("verified_ms" >= 0 AND "activity_ms" >= 0);
-- A positive attendance award can come from less than ten minutes, and can
-- increase a negative balance. Published pre-policy snapshots remain untouched.
ALTER TABLE "reputation_report_entries" DROP CONSTRAINT "reputation_report_entries_values_check";
ALTER TABLE "reputation_report_entries" ADD CONSTRAINT "reputation_report_entries_values_check"
  CHECK ("position" >= 0 AND "eligible_ms" >= 0 AND "points" > 0 AND "balance_after" >= -500);
COMMIT;
