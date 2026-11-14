-- Stop every old bot instance before this coordinated unit conversion.
-- Physical column renames deliberately prevent old binaries misreading units.
BEGIN;
ALTER TABLE reputation_members DROP CONSTRAINT reputation_members_balance_check;
ALTER TABLE reputation_daily_awards DROP CONSTRAINT reputation_daily_awards_totals_check;
ALTER TABLE reputation_report_entries DROP CONSTRAINT reputation_report_entries_values_check;
ALTER TABLE voice_reputation_polls DROP CONSTRAINT voice_reputation_polls_values_check;
ALTER TABLE voice_reputation_polls DROP CONSTRAINT voice_reputation_polls_reward_direction_check;

UPDATE reputation_members SET balance = balance * 4;
UPDATE reputation_settlements SET points_awarded = points_awarded * 4;
UPDATE reputation_daily_awards SET points = points * 4, balance_after = balance_after * 4,
  base_points = base_points * 4, attendance_bonus = attendance_bonus * 4, absence_penalty = absence_penalty * 4;
UPDATE reputation_reports SET points_awarded = points_awarded * 4;
UPDATE reputation_report_entries SET points = points * 4, balance_after = balance_after * 4;
UPDATE voice_reputation_polls SET amount = amount * 4, applied_amount = applied_amount * 4,
  balance_before = balance_before * 4, balance_after = balance_after * 4;

ALTER TABLE reputation_members RENAME COLUMN balance TO balance_units;
ALTER TABLE reputation_settlements RENAME COLUMN points_awarded TO points_awarded_units;
ALTER TABLE reputation_daily_awards RENAME COLUMN points TO points_units;
ALTER TABLE reputation_daily_awards RENAME COLUMN balance_after TO balance_after_units;
ALTER TABLE reputation_daily_awards RENAME COLUMN base_points TO base_points_units;
ALTER TABLE reputation_daily_awards RENAME COLUMN attendance_bonus TO attendance_bonus_units;
ALTER TABLE reputation_daily_awards RENAME COLUMN absence_penalty TO absence_penalty_units;
ALTER TABLE reputation_reports RENAME COLUMN points_awarded TO points_awarded_units;
ALTER TABLE reputation_report_entries RENAME COLUMN points TO points_units;
ALTER TABLE reputation_report_entries RENAME COLUMN balance_after TO balance_after_units;
ALTER TABLE voice_reputation_polls RENAME COLUMN amount TO amount_units;
ALTER TABLE voice_reputation_polls RENAME COLUMN applied_amount TO applied_amount_units;
ALTER TABLE voice_reputation_polls RENAME COLUMN balance_before TO balance_before_units;
ALTER TABLE voice_reputation_polls RENAME COLUMN balance_after TO balance_after_units;
ALTER INDEX reputation_daily_awards_guild_id_day_points_eligible_ms_use_idx RENAME TO reputation_daily_awards_ranking_idx;

-- Historical intervals have no occupancy evidence: preserve their full rate.
ALTER TABLE reputation_voice_intervals ADD COLUMN earning_rate SMALLINT NOT NULL DEFAULT 4,
  ADD CONSTRAINT reputation_voice_intervals_rate_check CHECK (earning_rate IN (1,4));
ALTER TABLE reputation_daily_awards ADD COLUMN solo_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reputation_members ADD CONSTRAINT reputation_members_balance_units_check CHECK (balance_units BETWEEN -2000 AND 20000);
ALTER TABLE reputation_daily_awards ADD CONSTRAINT reputation_daily_awards_totals_check CHECK (
  eligible_ms >= 0 AND solo_ms BETWEEN 0 AND eligible_ms AND balance_after_units >= -2000
  AND base_points_units >= 0 AND attendance_bonus_units >= 0 AND absence_penalty_units >= 0
  AND attendance_streak >= 0 AND absence_streak >= 0);
ALTER TABLE reputation_report_entries ADD CONSTRAINT reputation_report_entries_values_check CHECK (
  position >= 0 AND eligible_ms >= 0 AND points_units > 0 AND balance_after_units >= -2000);
ALTER TABLE voice_reputation_polls ADD CONSTRAINT voice_reputation_polls_values_check CHECK (
  amount_units IN (40,200,400) AND target_id <> initiator_id
  AND status IN ('creating','active','succeeded','failed','cancelled')
  AND applied_amount_units BETWEEN 0 AND amount_units
  AND (balance_after_units IS NULL OR balance_after_units BETWEEN -2000 AND 20000)
  AND (status <> 'active' OR (message_id IS NOT NULL AND started_at IS NOT NULL AND ends_at IS NOT NULL))
  AND (ends_at IS NULL OR ends_at = started_at + INTERVAL '120 seconds')
  AND (status <> 'succeeded' OR (applied_amount_units > 0 AND balance_after_units IS NOT NULL))
  AND (status = 'succeeded' OR applied_amount_units = 0));
ALTER TABLE voice_reputation_polls ADD CONSTRAINT voice_reputation_polls_reward_direction_check CHECK (
  kind <> 'reward' OR status <> 'succeeded' OR (
    balance_before_units IS NOT NULL AND balance_before_units BETWEEN -2000 AND 20000
    AND balance_after_units IS NOT NULL
    AND balance_after_units = LEAST(20000, balance_before_units + amount_units)
    AND applied_amount_units = balance_after_units - balance_before_units));
COMMIT;
