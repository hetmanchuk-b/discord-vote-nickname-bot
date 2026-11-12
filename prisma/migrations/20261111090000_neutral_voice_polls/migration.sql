-- Coordinated cutover: stop all old bot instances before applying this rename.
-- Only names change. Rows, IDs, choices, deadlines, balances and results remain.
BEGIN;
ALTER TABLE "voice_penalty_polls" RENAME TO "voice_reputation_polls";
ALTER TABLE "voice_penalty_votes" RENAME TO "voice_reputation_votes";
ALTER TABLE "voice_reputation_polls" RENAME COLUMN "actual_fine" TO "applied_amount";

-- PostgreSQL updates FK/check expressions and preserves index definitions/OIDs.
-- Rename their identifiers too so future Prisma diffs and diagnostics are neutral.
ALTER TABLE "voice_reputation_polls" RENAME CONSTRAINT "voice_penalty_polls_pkey" TO "voice_reputation_polls_pkey";
ALTER TABLE "voice_reputation_polls" RENAME CONSTRAINT "voice_penalty_polls_guild_id_fkey" TO "voice_reputation_polls_guild_id_fkey";
ALTER TABLE "voice_reputation_polls" RENAME CONSTRAINT "voice_penalty_polls_values_check" TO "voice_reputation_polls_values_check";
ALTER TABLE "voice_reputation_polls" RENAME CONSTRAINT "voice_penalty_polls_kind_check" TO "voice_reputation_polls_kind_check";
ALTER TABLE "voice_reputation_polls" RENAME CONSTRAINT "voice_penalty_polls_reward_direction_check" TO "voice_reputation_polls_reward_direction_check";
ALTER TABLE "voice_reputation_votes" RENAME CONSTRAINT "voice_penalty_votes_pkey" TO "voice_reputation_votes_pkey";
ALTER TABLE "voice_reputation_votes" RENAME CONSTRAINT "voice_penalty_votes_poll_id_fkey" TO "voice_reputation_votes_poll_id_fkey";
ALTER TABLE "voice_reputation_votes" RENAME CONSTRAINT "voice_penalty_votes_interaction_check" TO "voice_reputation_votes_interaction_check";

ALTER INDEX "voice_penalty_polls_message_id_key" RENAME TO "voice_reputation_polls_message_id_key";
ALTER INDEX "voice_penalty_polls_one_active_target_idx" RENAME TO "voice_reputation_polls_one_active_target_idx";
ALTER INDEX "voice_penalty_polls_guild_id_status_ends_at_idx" RENAME TO "voice_reputation_polls_guild_id_status_ends_at_idx";
ALTER INDEX "voice_penalty_polls_guild_id_published_at_last_attempt_at_idx" RENAME TO "voice_reputation_polls_publication_retry_idx";
ALTER INDEX "voice_penalty_votes_user_id_poll_id_idx" RENAME TO "voice_reputation_votes_user_id_poll_id_idx";
COMMIT;
