BEGIN;

-- Preserve already-frozen report semantics and pagination. Pending reports are
-- upgraded by prepare(); newly created reports use the new defaults.
ALTER TABLE "reputation_reports" ADD COLUMN "page_size" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "reputation_reports" ALTER COLUMN "page_size" SET DEFAULT 15;
ALTER TABLE "reputation_reports" ADD COLUMN "format_version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "reputation_reports" ALTER COLUMN "format_version" SET DEFAULT 2;
ALTER TABLE "reputation_reports" ADD CONSTRAINT "reputation_reports_page_size_check" CHECK ("page_size" IN (10,15));
ALTER TABLE "reputation_reports" ADD CONSTRAINT "reputation_reports_format_version_check" CHECK ("format_version" IN (1,2));

-- Reports now carry signed net changes; historical positive-only values stay intact.
ALTER TABLE "reputation_reports" DROP CONSTRAINT "reputation_reports_totals_check";
ALTER TABLE "reputation_reports" ADD CONSTRAINT "reputation_reports_totals_check"
  CHECK ("activity_ms" >= 0 AND "entry_count" >= 0 AND ("format_version" = 2 OR "points_awarded_units" >= 0));
ALTER TABLE "reputation_report_entries" DROP CONSTRAINT "reputation_report_entries_values_check";
ALTER TABLE "reputation_report_entries" ADD CONSTRAINT "reputation_report_entries_values_check"
  CHECK ("position" >= 0 AND "eligible_ms" >= 0 AND "balance_after_units" >= -2000);

-- Monetary components are quarter-point units, not displayed points.
-- NULL means a legacy snapshot did not capture a breakdown; never infer one.
ALTER TABLE "reputation_report_entries"
  ADD COLUMN "daily_points_units" INTEGER,
  ADD COLUMN "vote_rewards_units" INTEGER,
  ADD COLUMN "vote_penalties_units" INTEGER,
  ADD COLUMN "reward_vote_count" INTEGER,
  ADD COLUMN "penalty_vote_count" INTEGER;
ALTER TABLE "reputation_report_entries" ADD CONSTRAINT "reputation_report_entries_changes_check" CHECK (
  ("daily_points_units" IS NULL AND "vote_rewards_units" IS NULL AND "vote_penalties_units" IS NULL AND "reward_vote_count" IS NULL AND "penalty_vote_count" IS NULL AND "points_units" > 0) OR
  ("daily_points_units" IS NOT NULL AND "vote_rewards_units" IS NOT NULL AND "vote_penalties_units" IS NOT NULL AND "reward_vote_count" IS NOT NULL AND "penalty_vote_count" IS NOT NULL
    AND "vote_rewards_units" >= 0 AND "vote_penalties_units" >= 0 AND "reward_vote_count" >= 0 AND "penalty_vote_count" >= 0
    AND (("vote_rewards_units" = 0 AND "reward_vote_count" = 0) OR ("vote_rewards_units" > 0 AND "reward_vote_count" > 0))
    AND (("vote_penalties_units" = 0 AND "penalty_vote_count" = 0) OR ("vote_penalties_units" > 0 AND "penalty_vote_count" > 0))
    AND ("daily_points_units" <> 0 OR "vote_rewards_units" > 0 OR "vote_penalties_units" > 0)
    AND "points_units"::bigint = "daily_points_units"::bigint + "vote_rewards_units"::bigint - "vote_penalties_units"::bigint)
);
CREATE INDEX "voice_reputation_polls_report_day_idx" ON "voice_reputation_polls"("guild_id", "status", "closed_at");

COMMIT;
