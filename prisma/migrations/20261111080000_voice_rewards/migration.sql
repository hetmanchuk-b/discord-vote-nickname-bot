BEGIN;
-- Preserve all existing poll identities, buttons, outcomes, and deduction audit.
-- actual_fine is the legacy column name for the POSITIVE applied magnitude;
-- kind determines whether that magnitude is subtracted or added.
ALTER TABLE "voice_penalty_polls" ADD COLUMN "kind" VARCHAR(8) NOT NULL DEFAULT 'penalty';
ALTER TABLE "voice_penalty_polls" ADD COLUMN "balance_before" INTEGER;
ALTER TABLE "voice_penalty_polls" ADD CONSTRAINT "voice_penalty_polls_kind_check" CHECK ("kind" IN ('penalty','reward'));
-- A legacy penalty-only binary must not be able to debit a reward row. Its
-- finalization lacks the new pre-balance audit, so the entire transaction fails.
ALTER TABLE "voice_penalty_polls" ADD CONSTRAINT "voice_penalty_polls_reward_direction_check" CHECK (
  "kind" <> 'reward' OR "status" <> 'succeeded' OR (
    "balance_before" IS NOT NULL AND "balance_before" BETWEEN -500 AND 5000
    AND "balance_after" IS NOT NULL
    AND "balance_after" = LEAST(5000, "balance_before" + "amount")
    AND "actual_fine" = "balance_after" - "balance_before"
  )
);
-- The existing partial unique target index intentionally covers BOTH kinds.
COMMIT;
