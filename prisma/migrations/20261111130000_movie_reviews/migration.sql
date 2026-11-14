BEGIN;

CREATE TABLE "movie_reviews" (
  "movie_id" UUID NOT NULL,
  "user_id" VARCHAR(20) NOT NULL,
  "text" VARCHAR(1000),
  "contains_spoilers" BOOLEAN NOT NULL DEFAULT false,
  "interaction_id" VARCHAR(20) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "movie_reviews_pkey" PRIMARY KEY ("movie_id", "user_id"),
  CONSTRAINT "movie_reviews_text_check" CHECK (
    ("text" IS NULL AND NOT "contains_spoilers") OR
    ("text" IS NOT NULL AND char_length(btrim("text")) BETWEEN 1 AND 1000)
  ),
  CONSTRAINT "movie_reviews_interaction_check" CHECK ("interaction_id" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "movie_reviews_movie_id_fkey" FOREIGN KEY ("movie_id") REFERENCES "movies"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "movie_reviews_movie_id_created_at_user_id_idx" ON "movie_reviews"("movie_id", "created_at", "user_id");

-- Refresh all existing cards to add the review buttons on the next delivery pass.
-- Metadata, numerical ratings, and all reputation/financial records are unchanged.
UPDATE "movies" SET "revision" = "revision" + 1;

COMMIT;
