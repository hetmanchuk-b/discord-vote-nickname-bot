BEGIN;

-- Freeze solo time in NEW report snapshots. NULL on existing snapshots means
-- the detail was not captured: do not reconstruct or rewrite published history.
ALTER TABLE "reputation_report_entries" ADD COLUMN "solo_ms" INTEGER;
ALTER TABLE "reputation_report_entries" ADD CONSTRAINT "reputation_report_entries_solo_ms_check"
  CHECK ("solo_ms" IS NULL OR ("solo_ms" >= 0 AND "solo_ms" <= "eligible_ms"));

COMMIT;
