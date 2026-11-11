-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "reputation_guilds" (
    "guild_id" VARCHAR(20) NOT NULL,
    "report_channel_id" VARCHAR(20),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reputation_guilds_pkey" PRIMARY KEY ("guild_id")
);

-- CreateTable
CREATE TABLE "reputation_members" (
    "guild_id" VARCHAR(20) NOT NULL,
    "user_id" VARCHAR(20) NOT NULL,
    "is_tracking" BOOLEAN NOT NULL DEFAULT true,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reputation_members_pkey" PRIMARY KEY ("guild_id","user_id")
);

-- AddForeignKey
ALTER TABLE "reputation_members" ADD CONSTRAINT "reputation_members_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "reputation_guilds"("guild_id") ON DELETE RESTRICT ON UPDATE CASCADE;
