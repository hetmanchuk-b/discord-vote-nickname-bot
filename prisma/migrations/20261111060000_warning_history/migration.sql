-- Warning history contains safe issue categories/timestamps, never raw errors,
-- connection strings, or exception messages. Older message history cannot be
-- reconstructed; the latest saved legacy state is adopted on first use.
BEGIN;
ALTER TABLE "reputation_warnings" ADD COLUMN "history" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "reputation_warnings" ADD CONSTRAINT "reputation_warnings_history_check"
  CHECK (jsonb_typeof("history") = 'array');
COMMIT;
