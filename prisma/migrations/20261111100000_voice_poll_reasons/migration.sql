-- Nullable only for historical polls and erased unpublished reasons.
-- New application reservations require a nonblank reason for both vote kinds.
BEGIN;
ALTER TABLE "voice_reputation_polls"
  ADD COLUMN "proposal_reason" VARCHAR(1000),
  ADD CONSTRAINT "voice_reputation_polls_proposal_reason_check"
    CHECK ("proposal_reason" IS NULL OR
      (char_length("proposal_reason") BETWEEN 1 AND 1000 AND "proposal_reason" ~ '[^[:space:]]'));
COMMIT;
