# Vote Nickname Discord Bot

A simple Discord bot for starting nickname voting threads on a Discord server.

## Features

- Slash command for starting a nickname vote
- Creates a dedicated thread for nickname suggestions
- Supports Discord application command deployment
- Written in strict TypeScript using Discord.js
- Reaction-weighted, interactive finalist selection and 24-hour Discord polls
- Archive notes, download social-media videos, and generate playful percentage ratings

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
- `prisma/` — database schema and versioned migrations
- `src/generated/` — generated Prisma Client (ignored; included in compiled `dist/`)
- `test/` — offline tests against the compiled output (no Discord login required)

## Voice reputation

The reputation system includes voice tracking, daily settlement, member controls, daily reports, shared pagination, and operational warnings. Detailed rules are in [`REPUTATION.md`](REPUTATION.md). **Background tracking, settlement, reports, and warnings remain OFF by default.** Backup tooling and guided deployment are in place. Repository secrets, manual backup/verification, and an approved restore into a separate test database have been verified. Scheduling, slash-command deployment, and activation still require explicit setup. Setting a channel or enabling a personal preference does not activate the global tracking flag.

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

Keep `REPUTATION_TRACKING_ENABLED=false` until deployment checks are complete and you explicitly choose to activate it. This flag gates **tracking, settlement, report delivery, and operational warnings**; historical pagination and member commands remain available with a healthy database. Enabling later requires `REPUTATION_GUILD_ID` for the single target server and all reviewed migrations. No migrations are applied automatically.

The tracker:

- Counts humans in regular voice channels, including solo, muted, and deafened members; excludes bots, Stage channels, and the configured AFK channel.
- Captures joins/leaves and eligibility changes, then serializes writes. Normal-channel moves and mute/deafen changes do not cause extra database writes.
- Saves unrounded UTC intervals at five-minute checkpoints and relevant transitions. Kyiv-day splitting and rounding happen at settlement, not on each visit.
- Supports `/reputation-on` and `/reputation-off` with persistent `is_tracking`. Pausing preserves earlier recorded time; resuming never backfills a pause.
- Records coverage even when voice channels are empty, allowing later reports to distinguish no activity from missing observations.
- Starts a fresh baseline after restart, database failure, or gateway loss. Unsaved tails and offline gaps are not backfilled. A database write with an uncertain acknowledgement is not blindly retried.
- Drops a tail when more than six minutes pass without a successful checkpoint (five-minute interval plus one-minute scheduling grace), rather than awarding an unobserved process suspension.
- Uses bounded recovery backoff, serial checkpoints, and database ownership tokens to fence out a replaced tracker. Run only one active bot instance for this server.
- Flushes on graceful shutdown. Abrupt termination can lose approximately up to five minutes of recent progress under normal operation; outages may lose more.

Coverage is `[started_at, verified_through)`, not the run's `closed_at` timestamp. Status changes feed the reusable warning message described below and are logged without driver credentials.

### Daily settlement (gated with tracking)

- Wakes at **00:00 Europe/Kyiv**, accounting for 23/25-hour DST days. Startup catch-up processes missed days in chronological order from the first tracking day—not before activation.
- Flushes the tracker before closing eligible days, clips midnight-spanning intervals, sums all visits, and awards `floor(eligible milliseconds / 600000)` per member/day. Remainders never carry forward.
- Uses one transaction for balance increments, unique server/day ledger, member/day results, and the settled-through watermark. Retrying after a timeout or running concurrent workers cannot repay a completed day.
- Saves each member's post-payout balance so later payouts do not change earlier daily results. Zero-point activity is retained internally but is not an earning report entry.
- Records coverage duration and incomplete-tracking flags, including partial activation days and fully offline missed days. Previously earned time still settles even if the member has since paused tracking.
- Prevents delayed checkpoints from inserting new earnings before the settlement watermark.
- Retries database failures with 1–5-minute bounded backoff. Catch-up yields after 31 days per batch. There is no per-minute accounting poll during healthy operation.
- Queues independent report publication after settlement. Discord failures do not roll back payouts or cause a second payout. Member deletion removes live daily results while retaining the day ledger to prevent replay.

Migration `20261111020000_daily_settlement` must be explicitly approved/applied before deploying this version against an existing database. It adds settlement tables and a watermark; it does not activate tracking or issue payouts by itself.

### Member commands

Apply migration `20261111030000_member_controls` to the intended database before deploying this version, then run `npm run commands` to register the new commands. Migration and Discord command deployment are explicit operations, not automatic startup work.

| Command | Behavior | Visibility |
| --- | --- | --- |
| `/reputation [user]` | Settled balance; defaults to the caller | Public |
| `/voice-today [user]` | Verified time, pending whole points, tracking status, and incomplete-data warnings for the current Kyiv day | Public |
| `/reputation-off` | Pause only the caller; preserve earlier time and balance | Ephemeral |
| `/reputation-on` | Resume only the caller without retroactive pause credit | Ephemeral |
| `/reputation-rules` | Earning, settlement, channel, downtime, and deletion rules | Ephemeral |
| `/reputation-delete` | Caller-only Delete/Cancel confirmation, expiring after 60 seconds | Ephemeral |

All commands are server-only. User options use Discord's member/user picker, not ambiguous free-text username matching. Bots are not eligible. Public statistics do not ping the selected user. Reading statistics for an unknown member does not create a database record.

`/voice-today` requests an on-demand checkpoint when a tracker exists, so ongoing verified time is included. These reads may produce additional checkpoint writes beyond the five-minute schedule. They do not award points. When global tracking is disabled/unavailable, commands show that clearly; personal preferences and deletion remain usable with a healthy database. Database failures produce an error, never a fabricated zero balance.

Deletion removes the live balance, all member voice intervals, and member/day results (including entries not yet published). It retains the disabled identity and a monotonic eligibility cutoff, untouched day ledgers/anonymous accounting summaries, previously published report history, and existing backups. Nothing changes until the owner confirms. Expired, cancelled, repeated, foreign-user/server, or post-restart confirmation clicks cannot authorize deletion.

Deletion and tracking-preference changes serialize with the active tracker. Database writes also hold the same server-row lock as settlement. The `tracking_since` cutoff prevents queued pre-erasure/resume work from restoring old time. A deletion failure with an uncertain commit outcome asks the caller to verify/retry instead of claiming success. `/reputation-on` after deletion starts at zero. Historical Discord reports are not edited by deletion; their saved snapshots survive. If a report containing the member is in the middle of an unconfirmed Discord delivery, deletion returns a retry message without erasing data or pausing healthy tracking. Restore access to the original report channel if reconciliation is blocked by permissions.

### Reports and operational warnings

Review/apply `20261111040000_reports_and_warnings` before deploying this version. It adds report snapshots, publication state, and warning metadata; applying it does not send messages or activate tracking.

Daily reports use one public embed with **5 positive earners per page** and shared Previous/Next buttons. Each entry includes eligible time, daily points, and the frozen settled balance. Order is daily points descending, eligible time descending, then user ID ascending. Everyone can navigate, but cannot change saved data. Navigation acknowledges clicks immediately and serializes edits to the same message; saved message identity and snapshots keep old buttons working after restarts, even when background tracking is disabled.

A fully observed empty day says `No activity recorded`. Recorded sub-threshold activity says `No reputation earned today`, without zero-point rows. Missing observations say `No verified activity recorded` with an incomplete-coverage warning. Catch-up reports retain the original Kyiv date and indicate delayed delivery/confirmation. Embeds and warnings disable mention notifications.

Publication is separate from payout:

1. Queue one report per settled server/day. Missing channels or permissions leave it queued with bounded retry.
2. Create/recover an **empty placeholder** with a stable marker and nonce. It contains no member statistics.
3. Under the server-row lock, read current live daily results, freeze all positive-earner pages, and mark the report `publishing` **before** editing Discord.
4. Edit the saved placeholder and mark the report `published`. An uncertain acknowledgement is reconciled by reading that same message's author/marker, not by sending another populated report.

Deletion before freezing removes the user from future report data. During uncertain publication, deletion of affected members waits for reconciliation (the caller receives a retry instruction); after confirmation, deletion preserves the historical snapshot. A definitively missing in-flight message is marked `missing`, releases the erasure guard, and is not automatically republished. Already published messages deleted by administrators are not recreated. Channel changes move only pending/unfrozen reports and current warnings; published history and in-flight frozen reports keep their original destination.

Discord's nonce deduplication covers only the [past few minutes](https://docs.discord.com/developers/resources/message#create-message). Placeholder recovery scans up to 200 recent channel messages; a rare orphaned **empty** placeholder is possible after long acknowledgement loss in a busy channel. This is not a permanent exactly-once guarantee for Discord sends. Populated reports use the single saved message ID; payout idempotency remains a database guarantee.

Operational warnings combine tracking, settlement, and report-delivery health in **one reusable message** in the configured channel: initial alert, ongoing edits no more than hourly, and a final recovery edit once all issue groups clear. IDs/throttle metadata and uncertain-delivery intent survive restarts when database persistence is available; repeated incidents reuse the message without pings. During a database outage, an already known channel/message can still be updated from memory. At cold start without database access, or if the channel is inaccessible, the bot logs and retries rather than guessing a channel or spamming messages. These limitations do not grant voice credit for missing observations.

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