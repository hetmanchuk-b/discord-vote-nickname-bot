# Vote Nickname Discord Bot

A simple Discord bot for starting nickname voting threads on a Discord server.

## Features

- Slash command for starting a nickname vote
- Creates a dedicated thread for nickname suggestions
- Supports Discord application command deployment
- Written in strict TypeScript using Discord.js
- Reaction-weighted, interactive finalist selection and 24-hour Discord polls
- Archive notes, download social-media videos, and generate playful percentage ratings
- IMDb movie cards with poster thumbnails, movie details and persistent, changeable 1–10 community ratings

## Requirements

- Node.js 22.12+ (Node.js 24 LTS recommended)
- npm
- A Discord bot token
- Discord application client ID

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a configuration file at:

   ```text
   data/config.json
   ```

3. Add your Discord bot token and client ID:

   ```json
   {
     "token": "YOUR_DISCORD_BOT_TOKEN",
     "clientId": "YOUR_DISCORD_APPLICATION_CLIENT_ID"
   }
   ```

4. Deploy slash commands:

   ```bash
   npm run commands
   ```

5. Build and start the bot:

   ```bash
   npm run build
   npm start
   ```

## Usage

Use the `/nickname-start` slash command in a server text channel to start a nickname vote for a selected user.
The bot will create a thread where users can suggest nickname variants.

Use the `/nickname-variants` or `/nickname-variants-by` slash command to view current variants.

Use `/nickname-end` in the suggestion thread to open interactive finalist selection. Reactions increase a suggestion's selection weight. Use the buttons to select 5–10 finalists, remove the last selection, or create a 24-hour poll.

Use the `/nickname-manage-result` slash command to end the poll and set the final nickname for the selected member.

## Movies

`/movie imdb:<IMDb movie URL>` posts a compact card with a poster thumbnail, clickable title/year, runtime, genres, plot, director, country, cast, external ratings, and separate community average/count. Anyone on the server can rate using two rows of 1–10 buttons; one changeable rating per person/movie is stored in PostgreSQL, shared across reposts. Metadata is cached, and ratings do not need voice participation or passive tracking. See [MOVIES.md](MOVIES.md) for rules, privacy, permissions and recovery.

New lookups need a private `OMDB_API_KEY`. The additive migration `20261111120000_movie_ratings` was **applied to the hosted database with explicit approval and confirmation that the bot was stopped**. All thirteen migrations are applied and the schema diff is clean; streaming checksums/table OIDs confirmed unchanged existing application data. Registration/deployment remain pending explicit approval; the registry now contains **19 commands**. A future movie-list command is not included yet. No new dependency is required.

## Development

```bash
npm run typecheck  # Strict TypeScript checks without emitting files
npm run lint       # ESLint, including TypeScript rules
npm test           # Build and run offline smoke/unit tests
npm run build      # Generate Prisma Client and compile src/ into dist/
npm run dev        # Build and start locally
```

`npm start` runs the precompiled `dist/index.js` without requiring development dependencies. `npm run dev` and `npm run commands` build first. The project retains CommonJS output; TypeScript imports use `.js` extensions for runtime compatibility. Command modules are discovered from `dist/commands/`; event handlers are registered in `src/index.ts`.

Configuration is read from `data/config.json` at runtime, relative to the project root, and is not copied into `dist/`. Keep that file alongside `dist/` when deploying. Never commit the bot token. The generated `dist/` directory is ignored by Git.

### Source layout

- `src/commands/` — slash commands, each checked against the shared `Command` interface
- `src/events/` — ready handler and interaction dispatcher
- `src/interactions/` — slash-command execution and cooldown handling
- `src/buttons/` — button registry and feature-specific handlers
- `src/utils/` — message fetching, deduplication, grouping, and finalist selection
- `src/types.ts` — command, variant, session, and Discord client collection types
- `src/vendor/` — declarations for the untyped media downloader dependency
- `src/reputation/` — database access, voice tracking, Kyiv-day accounting, settlement, and report settings
- `src/movies/` — validated OMDb lookup, persistent movie ratings, compact cards and recoverable delivery
- `prisma/` — database schema and versioned migrations
- `src/generated/` — generated Prisma Client (ignored; included in compiled `dist/`)
- `test/` — offline tests against the compiled output (no Discord login required)

## Voice reputation

The reputation system includes voice tracking, daily settlement, attendance bonuses, absence penalties, member controls, daily reports, shared pagination, and operational warnings. Detailed rules are in [`REPUTATION.md`](REPUTATION.md). **Background tracking, settlement, reports, and warnings remain OFF by default.** Backup tooling and guided deployment are in place. Repository secrets, manual backup/verification, and an approved restore into a separate test database have been verified. Scheduling, slash-command deployment, and activation still require explicit setup. Setting a channel or enabling a personal preference does not activate the global tracking flag.

Prisma ORM, Client, and the PostgreSQL adapter are pinned to **7.10.1**. Runtime database access uses a lazy pool of at most 3 connections with finite query/connection timeouts. The bot's existing commands and slash-command deployment do not require a database connection.

### Deployment and backups

- [`DEPLOYMENT.md`](DEPLOYMENT.md) — KataBump upload/startup, permissions, command registration, smoke checks, and deliberate activation.
- [`BACKUPS.md`](BACKUPS.md) — beginner-friendly GitHub Actions setup, private secrets, encrypted Prisma bucket backups, verification, restore testing, and optional retention.

The backup workflow is manual-first: scheduled runs and deletion of old backups are disabled by default. It uses Node built-ins, PostgreSQL 17 tools, and AWS CLI rather than adding runtime npm packages. A real manual encrypted backup and a separate test-database restore succeeded; the archive contained schema/migration history but no reputation activity yet. No production restore was performed. Keep bucket credentials and backup encryption keys off the bot host.

```bash
npm run backup:check   # Offline configuration validation, no database/bucket requests
# The following are REAL remote operations; read BACKUPS.md before using:
# npm run backup
# npm run backup:verify
```

### Environment and migration setup

1. Put a direct `postgres://` or `postgresql://` connection string in `DATABASE_URL`, using `.env.example` as a template. Prisma Accelerate (`prisma://` / `prisma+postgres://`) URLs are not accepted by this adapter.
2. If runtime access uses a pooled endpoint, optionally set `DIRECT_DATABASE_URL` to the direct endpoint for migrations. This is read by `prisma.config.ts`; it is not a Prisma schema `directUrl` field.
3. Run offline checks and generate the client:

   ```bash
   npm run db:validate
   npm run build
   ```

4. Review all pending SQL files under `prisma/migrations/`, then **explicitly apply them to the intended database**:

   ```bash
   npm run db:migrate
   npm run db:status
   ```

   Migration commands access the configured database. Builds, tests (unless the integration test is explicitly enabled), and bot startup do **not** automatically run migrations. Never use `migrate reset` on the hosted database.

5. Deploy slash commands with `npm run commands`. A member with **Manage Server** can run `/set-reputation-report` to set/change the destination. The command validates a regular text channel in this server and checks the bot's View Channel, Send Messages, Embed Links, and Read Message History permissions. Replies are ephemeral; failures do not confirm a successful save.

`.env` is loaded explicitly from the project root and remains ignored by Git. Existing process environment variables take precedence. Never upload credentials to a public repository or paste them into logs. Bucket credentials are used only by the separate backup scripts, not by the running bot.

### KataBump deployment

Build locally, upload the **entire `dist/` directory** (including generated client code), `package.json`, `package-lock.json`, and `data/config.json`. Supply `DATABASE_URL` and the reputation flags securely through the hosting environment or a minimal private `.env` in the project root. Do not upload your entire developer `.env` with bucket/encryption credentials. Keep JS FILE set to `dist/index.js`.

Production installation can use `npm ci --omit=dev`. Migrations require the development CLI and the `prisma/` directory plus `prisma.config.ts`; run them separately from a trusted development/deployment machine, not implicitly on each bot restart. Do not upload `node_modules` from Windows to the Linux host.

### Voice tracker (disabled by default)

Keep `REPUTATION_TRACKING_ENABLED=false` until deployment checks are complete and you explicitly choose to activate it. This flag gates **tracking, settlement, raw-interval cleanup, report delivery, and operational warnings**; historical pagination and member commands remain available with a healthy database. Enabling later requires `REPUTATION_GUILD_ID` for the single target server and all reviewed migrations. No migrations are applied automatically.

The tracker:

- Counts humans in regular voice channels, including solo, muted, and deafened members; excludes bots, Stage channels, and the configured AFK channel.
- Captures joins/leaves and eligibility changes, then serializes writes. Normal-channel moves checkpoint only when eligibility or solo/group earning rates change; mute/deafen alone does not cause extra database writes.
- Saves unrounded UTC intervals at five-minute checkpoints and relevant transitions. Kyiv-day splitting and rounding happen at settlement, not on each visit.
- Supports `/reputation-on` and `/reputation-off` with persistent `is_tracking`. Pausing preserves earlier recorded time; resuming never backfills a pause.
- Records coverage even when voice channels are empty, allowing later reports to distinguish no activity from missing observations.
- Starts a fresh baseline after restart, database failure, or gateway loss. Unsaved tails and offline gaps are not backfilled. A database write with an uncertain acknowledgement is not blindly retried.
- Drops a tail when more than six minutes pass without a successful checkpoint (five-minute interval plus one-minute scheduling grace), rather than awarding an unobserved process suspension.
- Uses bounded recovery backoff, serial checkpoints, and database ownership tokens to fence out a replaced tracker. Run only one active bot instance for this server.
- Flushes on graceful shutdown. Abrupt termination can lose approximately up to five minutes of recent progress under normal operation; outages may lose more.

Coverage is `[started_at, verified_through)`, not the run's `closed_at` timestamp. Status changes feed the reusable warning message described below and are logged without driver credentials.

### Quarter-points and 25% solo rate — hosted schema updated

Solo time earns **0.25 points per 10 minutes**. With another human in the same regular voice channel it earns **1 point per 10 minutes**. Bots do not count as company; muted/deafened and personally paused humans do. Occupancy changes checkpoint the old rate before switching, including moves where the eligible user list stays the same. No unobserved time is invented.

Solo/group time is combined per Kyiv day, then rounded down once to the nearest **0.25 points**, with no carry. Thus **30 minutes solo + 10 minutes group = 1.75 points**, before attendance bonuses. Group time can earn 0.25 points per 2.5 minutes. Streak qualification uses actual verified time, not weighted time; attendance bonuses and absence penalties keep their displayed values. Limits remain −500…5,000 and vote choices remain 10/50/100.

Storage uses integer quarter-point units; displayed points are units / 4. Migration `20261111110000_quarter_points_and_solo_rate` multiplies all existing monetary values/snapshots/audits by four and renames physical columns to `*_units` so old binaries cannot misread them. It adds interval `earning_rate` (1 solo / 4 full) and daily `solo_ms` while preserving actual durations and streaks. Historical occupancy is unknown, so existing intervals retain their full earning rate; their default `solo_ms=0` is not proof of company. Completed ledgers are not replayed or repriced.

**The hosted migration was applied with explicit approval and confirmation that the bot was stopped.** All twelve migrations are applied and the schema diff is clean. Streaming before/after checksums across all twelve application tables verified preserved displayed financial values, IDs, poll state, durations, streaks, coverage and metadata; table OIDs, legacy rate defaults and the migration checksum were also verified. Other installations must stop every old instance, preserve a verified backup and explicitly apply the migration first. Deploy the matching complete `dist/` before restarting a single instance; bot deployment has not been performed for this change. Never run old code against the converted database or manually rescale values twice. No new command or option is introduced; this change alone needs no command re-registration.

### Attendance bonuses and absence penalties

- Any positive verified eligible voice time qualifies as attendance, even under 10 minutes. Voice-time points use the solo/group rates below; attendance qualification itself is unchanged.
- Daily attendance bonuses: days 1–2: none; days 3–9: +5/day; days 10–16: +6/day; days 17–23: +7/day; then another +1 per seven days. There is no retroactive payout for days 1–2.
- Only members who have previously participated can receive absence penalties: missed days 1–7: −5/day; day 8 onward: −10/day. Attendance resets absence; a genuine missed day resets attendance.
- Any positive verified visit advances attendance and resets absence, even if global tracking was incomplete. Without a verified visit, absence is counted only when each completed observation gap is **≤5 minutes** and their combined overlap with that **Europe/Kyiv day is ≤30 minutes**. Exceeding either limit, or an unknown/unclosed boundary gap, freezes both streaks without bonus/penalty.
- Gaps are measured from verified observations, including any lost checkpoint tail. A midnight-crossing gap must satisfy the five-minute limit in full; only its overlap consumes each day's thirty-minute budget. Missing time never earns voice-time points, and reports still flag incomplete coverage even for tolerated gaps. Already-settled days are not recalculated.
- A personal pause overlapping any part of a Kyiv day still freezes both streaks and disables bonuses/penalties. Earlier verified voice time still earns base points. Pauses are persisted so delayed settlement uses historical preferences, not just the current flag.
- Final reputation is clamped to **−500…5,000**. Streaks still progress at the bounds; daily results store the actual balance change plus the uncapped base/bonus/penalty components.
- `/voice-today` shows both last-settled streaks. Its pending-point figure is **voice-time points only, before the balance limit**, not a promise of the final bonus/penalty.
- Daily public reports continue to list positive actual earners only. Penalties are retained in daily accounting and reflected in `/reputation`; they are not public report entries.
- `/reputation-delete` also clears participation and streak history. Resuming does not enable penalties until new verified participation.

**Hosted schema updated:** `20261111050000_attendance_rewards` was applied with approval while the bot was stopped; all six migrations are up to date. Other installations must review and apply the migration before deploying this build. Existing guilds start the attendance policy on the next full Kyiv day after migration, with fresh streaks and no retroactive attendance adjustments. Existing live balances are clamped; historical snapshots are not rewritten. Keep the old bot stopped during migration/deployment.

### Daily settlement (gated with tracking)

- Wakes at **00:00 Europe/Kyiv**, accounting for 23/25-hour DST days. Startup catch-up processes missed days in chronological order from the first tracking day—not before activation.
- Flushes the tracker before closing eligible days, clips midnight-spanning intervals, sums all visits, and awards `floor((4 × group milliseconds + solo milliseconds) / 600000) / 4` per member/day. Remainders smaller than 0.25 points never carry forward.
- Uses one transaction for bounded balance changes, participation/streak updates, unique server/day ledger, member/day results, and the settled-through watermark. Retrying after a timeout or running concurrent workers cannot repay a completed day.
- Saves each member's post-payout balance so later payouts do not change earlier daily results. Zero-point activity is retained internally but is not an earning report entry.
- Records coverage duration and incomplete-tracking flags, including partial activation days and fully offline missed days. Previously earned time still settles even if the member has since paused tracking.
- Prevents delayed checkpoints from inserting new earnings before the settlement watermark.
- Retries database failures with 1–5-minute bounded backoff. Catch-up yields after 31 days per batch. There is no per-minute accounting poll during healthy operation.
- Queues independent report publication after settlement. Discord failures do not roll back payouts or cause a second payout. Member deletion removes live daily results while retaining the day ledger to prevent replay.

Migration `20261111020000_daily_settlement` must be explicitly approved/applied before deploying this version against an existing database. It adds settlement tables and a watermark; it does not activate tracking or issue payouts by itself.

### Raw interval retention — 14 days

With tracking enabled, startup and daily settlement processing automatically remove expired `reputation_voice_intervals` after catch-up completes. Each row must have ended at least **14 × 24 hours** before the cleanup time and entirely at/before the committed settlement watermark. Intervals crossing either cutoff are retained whole; rows with missing settlement/participation proof are not deleted. One guild-locked transaction deletes at most 1,000 rows, yielding between backlog batches. Cleanup-only retries within the same Kyiv day do not trigger extra tracker checkpoints; a new Kyiv day still gets normal settlement processing.

Daily awards (including attendance duration for calendar heatmaps), settlements, balances, streaks, report snapshots, tracking-run coverage and pause history are preserved. Daily history has no automatic age expiry; `/reputation-delete` still removes the member's personal live history. This is deletion, not merging or archival: expired exact visit timestamps cannot be recovered from the live database. Existing backups are not rewritten, and backup-archive retention remains separate.

**Deploying this build with tracking enabled activates cleanup of existing expired rows too.** No migration or command re-registration is needed. Cleanup failures produce a sanitized console warning and bounded retries without blocking accounting. During normal operation, cleanup runs daily; expired rows can remain longer while the bot is stopped, tracking is disabled, settlement is behind, or a backlog is draining. PostgreSQL may reuse deleted space without immediately shrinking its allocated files; no automatic `VACUUM FULL` is performed.

### Member commands

Apply migration `20261111030000_member_controls` to the intended database before deploying this version, then run `npm run commands` to register the new commands. Migration and Discord command deployment are explicit operations, not automatic startup work.

| Command | Behavior | Visibility |
| --- | --- | --- |
| `/reputation [user]` | Settled balance; defaults to the caller | Public |
| `/reputation-all` | Participants and their settled reputation, highest first; no pagination | Ephemeral |
| `/voice-today [user]` | Verified time, pending quarter-points, tracking status, and incomplete-data warnings for the current Kyiv day | Public |
| `/reputation-off` | Pause only the caller; preserve earlier time and balance | Ephemeral |
| `/reputation-on` | Resume only the caller without retroactive pause credit | Ephemeral |
| `/reputation-rules` | Earning, settlement, channel, downtime, and deletion rules | Ephemeral |
| `/reputation-delete` | Caller-only Delete/Cancel confirmation, expiring after 60 seconds | Ephemeral |
| `/voice-penalty user amount reason` | Start a 120-second button vote for a 10/50/100-point fine | Public poll; private confirmations |
| `/voice-reward user amount reason` | Same voting rules, but award 10/50/100 points, capped at 5,000 | Public poll; private confirmations |

All commands are server-only. User options use Discord's member/user picker, not ambiguous free-text username matching. Bots are not eligible. Public statistics do not ping the selected user. Reading statistics for an unknown member does not create a database record.

`/voice-today` requests an on-demand checkpoint when a tracker exists, so ongoing verified time is included. These reads may produce additional checkpoint writes beyond the five-minute schedule. They do not award points. When global tracking is disabled/unavailable, commands show that clearly; personal preferences and deletion remain usable with a healthy database. Database failures produce an error, never a fabricated zero balance.

Deletion removes the live balance, all member voice intervals, and member/day results (including entries not yet published). It retains the disabled identity and a monotonic eligibility cutoff, untouched day ledgers/anonymous accounting summaries, previously published report history, and existing backups. Nothing changes until the owner confirms. Expired, cancelled, repeated, foreign-user/server, or post-restart confirmation clicks cannot authorize deletion.

Deletion and tracking-preference changes serialize with the active tracker. Database writes also hold the same server-row lock as settlement. The `tracking_since` cutoff prevents queued pre-erasure/resume work from restoring old time. A deletion failure with an uncertain commit outcome asks the caller to verify/retry instead of claiming success. `/reputation-on` after deletion starts at zero. Historical Discord reports are not edited by deletion; their saved snapshots survive. If a report containing the member is in the middle of an unconfirmed Discord delivery, deletion returns a retry message without erasing data or pausing healthy tracking. Restore access to the original report channel if reconciliation is blocked by permissions.

### Reports and operational warnings

Review/apply `20261111040000_reports_and_warnings` before deploying this version. It adds report snapshots, publication state, and warning metadata; applying it does not send messages or activate tracking.

Daily reports use one public embed with **10 positive earners per page** and shared Previous/Next buttons. Each entry includes eligible time, daily points, and the frozen settled balance. Order is daily points descending, eligible time descending, then user ID ascending. Everyone can navigate, but cannot change saved data. Navigation acknowledges clicks immediately and serializes edits to the same message; saved message identity and snapshots keep old buttons working after restarts, even when background tracking is disabled.

A fully observed empty day says `No activity recorded`. Recorded sub-threshold activity says `No reputation earned today`, without zero-point rows. Missing observations say `No verified activity recorded` with an incomplete-coverage warning. Catch-up reports retain the original Kyiv date and indicate delayed delivery/confirmation. Embeds and warnings disable mention notifications.

Publication is separate from payout:

1. Queue one report per settled server/day. Missing channels or permissions leave it queued with bounded retry.
2. Create/recover an **empty placeholder** with a stable marker and nonce. It contains no member statistics.
3. Under the server-row lock, read current live daily results, freeze all positive-earner pages, and mark the report `publishing` **before** editing Discord.
4. Edit the saved placeholder and mark the report `published`. An uncertain acknowledgement is reconciled by reading that same message's author/marker, not by sending another populated report.

Deletion before freezing removes the user from future report data. During uncertain publication, deletion of affected members waits for reconciliation (the caller receives a retry instruction); after confirmation, deletion preserves the historical snapshot. A definitively missing in-flight message is marked `missing`, releases the erasure guard, and is not automatically republished. Already published messages deleted by administrators are not recreated. Channel changes move only pending/unfrozen reports and current warnings; published history and in-flight frozen reports keep their original destination.

Discord's nonce deduplication covers only the [past few minutes](https://docs.discord.com/developers/resources/message#create-message). Placeholder recovery scans up to 200 recent channel messages; a rare orphaned **empty** placeholder is possible after long acknowledgement loss in a busy channel. This is not a permanent exactly-once guarantee for Discord sends. Populated reports use the single saved message ID; payout idempotency remains a database guarantee.

Operational warnings combine tracking, settlement, and report-delivery health in **one reusable message** in the configured channel: initial alert, ongoing edits no more than hourly, and a final recovery edit once all issue groups clear. IDs/throttle metadata and uncertain-delivery intent survive restarts when database persistence is available; repeated incidents reuse the message without pings. The description preserves a chronological history of reason changes, hourly updates, and recoveries with Kyiv dates and `HH:mm` times. The latest 100 safe-category entries are persisted; Discord displays the newest complete entries that fit its 4,096-character description limit. Retries do not add duplicate entries. Known structured error codes produce allowlisted Ukrainian summaries, such as database timeouts, authentication/schema failures, gateway disconnects, or the exact missing Discord permission. Unknown failures use a generic explanation. Safe diagnostic codes are saved alongside history entries; older category-only entries remain readable. Raw exception text, stacks, SQL, URLs, and connection details are never included. This diagnostic extension uses the existing history column and needs no additional migration. During a database outage, an already known channel/message can still be updated from memory. At cold start without database access, or if the channel is inaccessible, the bot logs and retries rather than guessing a channel or spamming messages. These limitations do not grant voice credit for missing observations.

**Warning-history schema updated:** `20261111060000_warning_history` was applied to the hosted database with approval; the original seven migrations are applied. Other installations must review and apply this JSON history migration before deploying the updated build. Pre-upgrade warning edits cannot be reconstructed; the latest saved state becomes the history's starting point.

### Voice penalty polls

`/voice-penalty user:@member amount:10|50|100 reason:TEXT` starts a poll in the current regular text/voice text channel. The initiator and target must be different humans in the same regular voice channel, with at least **four humans including both** when the poll starts. The target must have previously participated in reputation (including a verified visit not yet settled); poll creation checkpoints an available tracker first. Paused participants are allowed. Never-participated/deleted targets and balances already at −500 are rejected privately.

- There is one active poll per target and **no cooldown**. The target cannot vote. Anyone else must be human and in the original voice channel when clicking; joins after the start are allowed.
- Yes/No buttons allow changing selection. The latest Discord interaction wins even if database requests complete out of order. Confirmations are private; no live totals or choices are displayed.
- Voting closes exactly 120 seconds after the poll message's Discord creation time. At least one eligible Yes and no eligible No are required. Only voters in the **original channel at the deadline** count; four people are not required at the end. The target leaving does not cancel the poll.
- Start/end presence uses the bot's gateway-observed roster, accounting for changes during up to two seconds of scheduling/API jitter. A reconnect after the deadline, lost voice visibility, unknown member data, or a longer delay cancels without a fine. This tolerance does **not** allow late votes: the database rejects them at the deadline.
- Successful fines are immediate and clamp to −500; the edited result states only who lost the **actual** number of points. Failures state unanimity was not reached and identify only eligible No voters. Large No lists use an attached plain-ID file; no vote counts or Yes-voter lists are published, and mentions never ping.
- Fully active polls and private choices survive restarts before the deadline. If the deadline was missed or evidence was lost, the result cancels without a fine. Valid evidence captured before a DB outage is reused on retry, not replaced by a later roster. Durable results/transactions prevent duplicate deductions after lost acknowledgements.
- Deleted messages detected before deduction cancel without a fine. Outcomes are edited into the existing message, not reposted; deletion after a committed fine does not refund it. Publication failures never reapply the fine.
- Deletion cancels the target's unpublished polls and removes private choices/unpublished veto identities. Published outcomes and their No identities remain history. Ambiguous result publication may temporarily block erasure until reconciliation, like daily reports.

The poll destination must be visible to the humans in the original voice channel; hidden-channel polls are rejected. The bot needs View Channel in the original voice channel, and View Channel, Send Messages, Embed Links, Read Message History, and Attach Files in the poll's text destination. Polls require `REPUTATION_GUILD_ID` and a healthy database, independently of passive `REPUTATION_TRACKING_ENABLED`; no extra intent or environment secret is needed.

**Hosted schema updated:** `20261111070000_voice_penalties` was applied with approval; all eight migrations are up to date. It adds durable poll/vote tables without adjusting existing balances. Other installations must review and apply pending migrations before deploying this build. Register the new command explicitly with `npm run commands`.

### Voice reward polls

`/voice-reward user:@member amount:10|50|100 reason:TEXT` mirrors `/voice-penalty`: four humans at the start, same-channel participation, no self-targeting or target voting, changeable private Yes/No choices, a 120-second deadline, and at least one eligible Yes with no eligible No. Tracking pauses do not prevent rewards, but prior verified reputation participation is required. The original channel, restart/deadline safeguards, hidden-channel prevention, permissions, and failed No-voter disclosure are shared rather than implemented separately.

Rewards are added immediately and stop at **5,000**. A requested +100 at 4,980 awards **20**, and the result reports that actual credit. Targets already at 5,000 are rejected privately; reaching the ceiling while voting cancels without claiming a zero-point reward. A −500 balance may receive rewards. Neither vote type changes attendance streaks. There is **one active poll per target across penalties and rewards**, with no cooldown.

**Hosted schema:** the first nine migrations through `20261111080000_voice_rewards` were applied with approval. The reward migration adds a poll kind (existing rows stay penalties) and a pre-balance audit, preserving old messages, votes, results and balances. Its database direction check prevents a legacy penalty-only binary from debiting a reward. Register the reward command explicitly with `npm run commands` if not already registered.

### Neutral shared voting names — hosted schema updated

Both commands use `voice-poll-*` modules and `client.voicePolls`. Prisma models are `VoiceReputationPoll` / `VoiceReputationVote`; PostgreSQL tables are `voice_reputation_polls` / `voice_reputation_votes`. `appliedAmount` (`applied_amount`) is a positive applied magnitude; `kind` determines debit or credit.

Migration `20261111090000_neutral_voice_polls` renames the existing tables, column, indexes and constraints **in place**, without recreating tables or changing records, balances, deadlines or choices. Historical migrations remain unchanged. With explicit approval and confirmation that the bot was stopped, this migration was applied to the configured hosted database. All ten migrations are applied and the schema diff is clean; before/after verification confirmed unchanged poll/vote/member rows and preserved table OIDs. Other installations must stop all old bot instances before explicitly applying it. Deploy the matching fresh build before restarting; old binaries are incompatible with the renamed schema. Existing `/voice-penalty` / `/voice-reward` commands, button IDs and `VP:<id>:active|final` message markers remain unchanged, so this refactor alone needs no command re-registration. See [DEPLOYMENT.md](DEPLOYMENT.md) for the coordinated cutover. `npm run build` cleans `dist/` first to remove obsolete modules.

### Required vote reasons — hosted schema updated

Both vote commands require a nonblank plain-text `reason` (up to 1,000 Unicode characters; surrounding whitespace is trimmed). It is saved durably, shown **during voting**, and retained at the end of a successful result after the actual credited/deducted amount. Failed and cancelled results omit it. Markdown is escaped and mention notifications remain disabled. Unsuccessful reasons are discarded; erasure clears authored reasons awaiting final publication, while successfully published results remain public history. Historical votes without a reason continue normally without an invented explanation.

Migration `20261111100000_voice_poll_reasons` adds nullable `proposal_reason`, separate from the existing internal cancellation `reason` code. It preserves existing polls, choices, deadlines, results and balances. With explicit approval and confirmation that the bot was stopped, it was applied to the configured hosted database. All eleven migrations are applied and the schema diff is clean; verification confirmed unchanged poll/vote/member rows, preserved table OIDs, NULL historical reasons and a matching migration checksum. Other installations must stop the bot and explicitly review/apply the migration before deploying. Deploy the fresh complete `dist/` and explicitly run `npm run commands` to update the required options on the existing **18 commands** before restarting; command registration and bot deployment have not been performed for this feature.

### Database tests

`npm test` runs offline tests and skips PostgreSQL integration tests by default. It never falls back to `DATABASE_URL` for integration testing. Test files run sequentially to bound connection pressure and support Prisma's local development database; concurrency protection is explicitly tested inside a transaction test.

To test real persistence, provision a **disposable PostgreSQL test database**, apply the checked-in migration to it, and set `REPUTATION_TEST_DATABASE_URL` to that database before running tests. When applying test migrations, explicitly point both `DATABASE_URL` and `DIRECT_DATABASE_URL` at the test database so a local `.env` cannot accidentally select the hosted database. The tests create uniquely named fixture records and remove them afterward. Apply **all** checked-in migrations to the disposable database; opt-in tests cover settings persistence, tracking preferences, interval transactions, rollback, stale-run fencing, DST settlement, midnight splitting, concurrent payouts, immutable balance snapshots, late checkpoint clipping, member statistics, pause cutoffs, deletion rollback, concurrent deletion/settlement, report snapshot retention and erasure races, restart-safe pages, lost delivery acknowledgements, and warning persistence. Discord transport is mocked in tests; no live bot login or channel publication is performed. Never point these tests at production.

### Adding buttons

Define handlers in a feature module under `src/buttons/`, keyed by exact Discord `customId` values:

```typescript
import type { ButtonHandler } from '../types.js';

export const exampleButtons = {
  'example:hello': async interaction => {
    await interaction.reply('Hello!');
  },
} satisfies Record<string, ButtonHandler>;
```

Import the group into `src/buttons/index.ts` and spread it into the registry alongside `shuffleButtons`. Each custom ID must be unique. No changes to `src/events/interaction-create.ts` are needed. Shuffle handlers share session lookup and selection rendering within their own module.

### Other commands

- `/archive` posts a formatted note to the thread configured by `ARCHIVE_NOTES_THREAD_ID` in `src/utils/constants.ts`.
- `/dw` downloads supported social-media videos; YouTube is excluded.
- `/yok` generates a random percentage rating.

Enable the Message Content privileged intent in the Discord developer portal. The bot also needs permission to read message history, create/send to threads, send polls, attach files, and manage nicknames as appropriate. Discord role hierarchy still limits which nicknames it can change.