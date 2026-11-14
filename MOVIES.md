# Movies and community ratings

## Commands and layout

`/movie imdb:https://www.imdb.com/title/tt3896198/` creates a public movie card in the current normal text channel or voice channel's text chat. Threads, forum channels and DMs are not supported. Any human server member can run the command or rate a visible card; no voice presence, reputation participation, tracking opt-in or moderator permissions are required.

The compact embed has:

- Clickable IMDb title with release year and a small poster thumbnail on the right.
- Runtime, genres and the short OMDb plot, followed by a clickable [WPARTY](https://wparty.net/s/ds6p2p199fv) watch-room link.
- Director/country as inline fields, followed by cast.
- Separate external ratings (IMDb, Rotten Tomatoes, Metacritic when available).
- A clearly separate community average (one decimal, Ukrainian formatting) and number of raters. Before the first rating it says there are no ratings, rather than showing 0/10.
- Two neutral rows of buttons: 1–5 and 6–10. No public button is styled as one person's selected score.

Missing `N/A` fields/posters are omitted. The title still links to IMDb without a poster. Labels/feedback are Ukrainian; movie metadata stays in OMDb's original language. Discord controls exact sizing and responsive stacking. Public cards do not ping anyone or publish voter identities; each rater receives private confirmation of their effective score.

## Rating and persistence rules

- Scores are whole numbers from 1 to 10, one score per Discord account per movie **per server**.
- Another click changes the score, not the number of raters. The latest Discord interaction ID wins even if handlers arrive out of order; replaying an interaction does not cast another vote.
- Reposting the same IMDb movie in the same server shares its metadata and ratings. All active cards are updated to the same community aggregate; another server has separate records/ratings.
- Ratings have no deadline and persist across restarts. They do not change reputation or require reputation tracking to be enabled.
- Metadata is fetched once per server/movie and retained in PostgreSQL. Reposts and rating clicks do not call OMDb. External ratings are the stored lookup snapshot, **not live critic scores**. `metadata_fetched_at` records the lookup time for a future refresh feature.
- The additive `20261111120000_movie_ratings` migration creates `movies`, `movie_ratings` and `movie_posts`. Movie scores are ordinary 1–10 integers, **not reputation quarter-point units**. It does not modify reputation tables or financial values.
- The schema supports a later movie-list command; **no `/movies` listing command is included yet**.

## Reliability and permissions

The bot needs View Channel, Send Messages, Embed Links and Read Message History in the destination. It checks them before spending an OMDb lookup. IMDb links are parsed locally and only their title ID is sent to a fixed HTTPS OMDb endpoint, with an eight-second timeout, bounded response size and no redirects. Other hosts/lookalike URLs, non-movie titles and mismatched IDs are rejected. API keys, raw provider errors and driver errors are never included in movie feedback/logs. Poster URLs are limited to known HTTPS IMDb/Amazon image hosts and are not fetched by the bot.

Creation is idempotent per command interaction. A durable post first binds an empty `MOVIE:<post-id>:pending` placeholder, then edits in metadata/buttons. Lost send acknowledgements are recovered by nonce and a bounded scan of the latest 200 channel messages. Outside the nonce/history window, a crash can leave an orphaned empty placeholder, but retries never publish a second full card for the same stored post.

DB revisions durably track updates; startup/reconnect catches up unfinished posts and stale aggregates. Failed delivery is retried independently of accepting/saving ratings (30 seconds, increasing to at most five minutes). Healthy idle delivery does not poll the database. An edit that loses its acknowledgement is adopted by its revision stored in hidden button IDs; finished cards show no technical UUID/revision footer. A vote arriving during an edit remains pending for the next revision. One unreachable post does not block the rest of a batch. Run only one bot instance.

Deleted messages/channels are marked missing when encountered during pending work and are never automatically recreated. Their movies/ratings remain for a future list or explicit repost. Reposting uses a new post record and existing ratings. A missing-history/permission/network failure is not treated as proof of deletion.

Movie records/ratings are retained indefinitely, including after a member leaves. The 14-day raw voice-interval cleanup does not touch them. `/reputation-delete` is scoped to reputation and **does not erase movie ratings**. There is no movie-rating erasure command yet; ask the owner for manual movie-data removal if needed. Existing encrypted backups can retain prior data as documented in BACKUPS.md.

## Configuration and deployment status

Keep the real `OMDB_API_KEY` privately in the local/host environment. Do not commit it, paste it into chat, put it in a Discord message or copy the entire developer `.env` to production. Runtime uses the existing `DATABASE_URL`/small shared lazy Prisma pool. Without a database configuration, movie work is disabled without blocking unrelated commands. Without an OMDb key, already-stored movies and ratings still work; new movie lookups report a configuration error.

**The movie migration was applied to the configured hosted database with explicit approval and confirmation that the bot was stopped.** All thirteen migrations are applied and the schema diff is clean. Before/after streaming row checksums and table OIDs verified that all twelve existing application tables were unchanged. The three new tables were empty, their eight checks/two foreign keys validated, and the new migration checksum/history verified. Slash-command registration and bot deployment/start have not been performed for this feature.

To finish deployment:

1. Other installations must explicitly review/apply the additive migration using `npm run db:migrate` from a trusted checkout with the bot stopped, then verify status/schema. Never reset the database or apply migrations automatically at startup.
2. Build/upload the complete fresh `dist/`, including generated Prisma Client, and matching manifests.
3. Privately configure `DATABASE_URL` and `OMDB_API_KEY` on the host. No new gateway intents/dependencies are needed.
4. With explicit approval, run `npm run commands` to replace the global registration list (now **19 commands**, including `/movie`).
5. Start one matching bot instance and test in an intended channel. Existing reputation settings remain unchanged.

Offline tests mock OMDb and Discord. PostgreSQL tests only run with an explicitly configured disposable `REPUTATION_TEST_DATABASE_URL`; they never default to the hosted database.
