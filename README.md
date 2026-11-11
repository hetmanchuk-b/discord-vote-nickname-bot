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
- `src/reputation/` — lazy database connection and persistent report settings
- `prisma/` — database schema and versioned migrations
- `src/generated/` — generated Prisma Client (ignored; included in compiled `dist/`)
- `test/` — offline tests against the compiled output (no Discord login required)

## Reputation: stages 1–2

The agreed rules and implementation status are in [`REPUTATION.md`](REPUTATION.md). Stage 1 adds storage and `/set-reputation-report id:<channel ID>`. Stage 2 adds an opt-in voice tracker. **Tracking remains OFF by default, and reputation payouts, member commands, reports, and backups are not implemented yet.** Setting a channel does not activate tracking.

Prisma ORM, Client, and the PostgreSQL adapter are pinned to **7.10.1**. Runtime database access uses a lazy pool of at most 3 connections with finite query/connection timeouts. The bot's existing commands and slash-command deployment do not require a database connection.

### Environment and migration setup

1. Put a direct `postgres://` or `postgresql://` connection string in `DATABASE_URL`, using `.env.example` as a template. Prisma Accelerate (`prisma://` / `prisma+postgres://`) URLs are not accepted by this adapter.
2. If runtime access uses a pooled endpoint, optionally set `DIRECT_DATABASE_URL` to the direct endpoint for migrations. This is read by `prisma.config.ts`; it is not a Prisma schema `directUrl` field.
3. Run offline checks and generate the client:

   ```bash
   npm run db:validate
   npm run build
   ```

4. Review `prisma/migrations/20261111000000_reputation_foundation/migration.sql`, then **explicitly apply it to the intended database**:

   ```bash
   npm run db:migrate
   npm run db:status
   ```

   Migration commands access the configured database. Builds, tests (unless the integration test is explicitly enabled), and bot startup do **not** automatically run migrations. Never use `migrate reset` on the hosted database.

5. Deploy slash commands with `npm run commands`. A member with **Manage Server** can run `/set-reputation-report` to set/change the destination. The command validates a regular text channel in this server and checks the bot's View Channel, Send Messages, Embed Links, and Read Message History permissions. Replies are ephemeral; failures do not confirm a successful save.

`.env` is loaded explicitly from the project root and remains ignored by Git. Existing process environment variables take precedence. Never upload credentials to a public repository or paste them into logs. Bucket credentials are not used yet.

### KataBump deployment

Build locally, upload the **entire `dist/` directory** (including generated client code), `package.json`, `package-lock.json`, and `data/config.json`. Supply `DATABASE_URL` securely through the hosting environment or a private `.env` in the project root. Keep JS FILE set to `dist/index.js`.

Production installation can use `npm ci --omit=dev`. Migrations require the development CLI and the `prisma/` directory plus `prisma.config.ts`; run them separately from a trusted development/deployment machine, not implicitly on each bot restart. Do not upload `node_modules` from Windows to the Linux host.

### Voice tracker (stage 2, disabled by default)

Keep `REPUTATION_TRACKING_ENABLED=false` while settlement and user controls are unfinished. Enabling tracking later requires `REPUTATION_GUILD_ID` for the single target server and the reviewed `20261111010000_voice_tracking` migration. No migrations are applied automatically.

The tracker:

- Counts humans in regular voice channels, including solo, muted, and deafened members; excludes bots, Stage channels, and the configured AFK channel.
- Captures joins/leaves and eligibility changes, then serializes writes. Normal-channel moves and mute/deafen changes do not cause extra database writes.
- Saves unrounded UTC intervals at five-minute checkpoints and relevant transitions. Eligible time is not converted into points yet; Kyiv-day splitting/rounding belongs to settlement.
- Supports internal pause/resume with persistent `is_tracking`; Discord member commands arrive later. Pausing preserves earlier recorded time.
- Records coverage even when voice channels are empty, allowing later reports to distinguish no activity from missing observations.
- Starts a fresh baseline after restart, database failure, or gateway loss. Unsaved tails and offline gaps are not backfilled. A database write with an uncertain acknowledgement is not blindly retried.
- Drops a tail when more than six minutes pass without a successful checkpoint (five-minute interval plus one-minute scheduling grace), rather than awarding an unobserved process suspension.
- Uses bounded recovery backoff, serial checkpoints, and database ownership tokens to fence out a replaced tracker. Run only one active bot instance for this server.
- Flushes on graceful shutdown. Abrupt termination can lose approximately up to five minutes of recent progress under normal operation; outages may lose more.

Coverage is `[started_at, verified_through)`, not the run's `closed_at` timestamp. Status changes are logged safely to the console for now; hourly-updated Discord warnings are part of the later reporting stage.

### Database tests

`npm test` runs offline tests and skips the PostgreSQL integration test by default. It never falls back to `DATABASE_URL` for integration testing.

To test real persistence, provision a **disposable PostgreSQL test database**, apply the checked-in migration to it, and set `REPUTATION_TEST_DATABASE_URL` to that database before running tests. When applying test migrations, explicitly point both `DATABASE_URL` and `DIRECT_DATABASE_URL` at the test database so a local `.env` cannot accidentally select the hosted database. The tests create uniquely named fixture records and remove them afterward. Apply **all** checked-in migrations to the disposable database; opt-in tests cover settings persistence, tracking preferences, interval transactions, rollback, and stale-run fencing. Never point these tests at production.

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