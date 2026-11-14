-- Additive movie metadata, per-member ratings and recoverable Discord posts.
-- No reputation tables or balances are changed.
CREATE TABLE "movies" (
  "id" UUID NOT NULL,
  "guild_id" VARCHAR(20) NOT NULL,
  "imdb_id" VARCHAR(16) NOT NULL,
  "title" VARCHAR(180) NOT NULL,
  "year" VARCHAR(24),
  "runtime" VARCHAR(40),
  "genres" VARCHAR(180),
  "director" VARCHAR(180),
  "country" VARCHAR(120),
  "cast" VARCHAR(400),
  "plot" VARCHAR(900),
  "poster_url" VARCHAR(2048),
  "external_ratings" JSONB NOT NULL,
  "revision" BIGINT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata_fetched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "movies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "movies_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "movies_imdb_id_check" CHECK ("imdb_id" ~ '^tt[0-9]{7,12}$'),
  CONSTRAINT "movies_external_ratings_check" CHECK (jsonb_typeof("external_ratings") = 'array')
);
CREATE TABLE "movie_ratings" (
  "movie_id" UUID NOT NULL,
  "user_id" VARCHAR(20) NOT NULL,
  "score" SMALLINT NOT NULL,
  "interaction_id" VARCHAR(20) NOT NULL,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "movie_ratings_pkey" PRIMARY KEY ("movie_id", "user_id"),
  CONSTRAINT "movie_ratings_score_check" CHECK ("score" BETWEEN 1 AND 10),
  CONSTRAINT "movie_ratings_interaction_check" CHECK ("interaction_id" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "movie_ratings_movie_id_fkey" FOREIGN KEY ("movie_id") REFERENCES "movies"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "movie_posts" (
  "id" UUID NOT NULL,
  "request_id" VARCHAR(20) NOT NULL,
  "movie_id" UUID NOT NULL,
  "channel_id" VARCHAR(20) NOT NULL,
  "message_id" VARCHAR(20),
  "status" VARCHAR(16) NOT NULL DEFAULT 'creating',
  "delivered_revision" BIGINT,
  "last_attempt_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "movie_posts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "movie_posts_status_check" CHECK ("status" IN ('creating', 'active', 'missing')),
  CONSTRAINT "movie_posts_revision_check" CHECK ("delivered_revision" IS NULL OR "delivered_revision" >= 0),
  CONSTRAINT "movie_posts_binding_check" CHECK (
    ("status" = 'creating' AND "message_id" IS NULL AND "delivered_revision" IS NULL) OR
    ("status" = 'active' AND "message_id" IS NOT NULL) OR "status" = 'missing'
  ),
  CONSTRAINT "movie_posts_movie_id_fkey" FOREIGN KEY ("movie_id") REFERENCES "movies"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "movies_guild_id_imdb_id_key" ON "movies"("guild_id", "imdb_id");
CREATE INDEX "movies_guild_id_created_at_idx" ON "movies"("guild_id", "created_at");
CREATE INDEX "movie_ratings_user_id_movie_id_idx" ON "movie_ratings"("user_id", "movie_id");
CREATE UNIQUE INDEX "movie_posts_request_id_key" ON "movie_posts"("request_id");
CREATE UNIQUE INDEX "movie_posts_message_id_key" ON "movie_posts"("message_id");
CREATE INDEX "movie_posts_status_last_attempt_at_created_at_idx" ON "movie_posts"("status", "last_attempt_at", "created_at");
