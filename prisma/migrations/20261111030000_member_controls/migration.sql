-- Eligibility floor prevents queued pre-pause/deletion work from being credited
-- after a member explicitly re-enables tracking. Existing members retain their
-- previous verified time; NULL preserves the original default-on behavior.
ALTER TABLE "reputation_members" ADD COLUMN "tracking_since" TIMESTAMPTZ(3);
