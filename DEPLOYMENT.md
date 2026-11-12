# KataBump deployment and activation checklist

The reputation implementation is present, but activation is a deliberate deployment step. **The agent has not enabled tracking, deployed slash commands, started a live bot, or configured unattended backups.** See [REPUTATION.md](REPUTATION.md) for rules and [BACKUPS.md](BACKUPS.md) for the guided backup setup.

## 1. Prepare locally

Use Node.js **24** (the project requires at least 22.12).

```bash
npm ci
npm run db:validate
npm run typecheck
npm run lint
npm test
npm run build
```

Normal tests are offline; real database tests require an explicitly configured disposable `REPUTATION_TEST_DATABASE_URL`. Never point integration tests at production. Discord transport and backup tools/storage are mocked in automated tests; production connectivity is not implied by passing them.

Check the intended hosted schema separately:

```bash
npm run db:status
```

The original six reputation migrations, including `20261111050000_attendance_rewards`, were applied to the configured hosted database with approval. The newer `20261111060000_warning_history` migration was subsequently applied with explicit approval; status verification confirmed the original seven hosted migrations are applied. The subsequent `20261111070000_voice_penalties` migration was applied with explicit approval; status verification confirmed the original eight hosted migrations are applied. The subsequent `20261111080000_voice_rewards` migration was applied with explicit approval; status verification confirmed all nine hosted migrations are up to date. It preserves existing balances and penalty history, adds the vote kind/pre-balance audit, and prevents penalty-only binaries from debiting rewards. Stop the old bot before replacing its build and run only one instance. The warning-history migration adds persistent JSON history; the voice-penalty migration adds durable poll/vote tables. Neither adjusts existing balances. The owner confirmed the bot was stopped before the attendance migration. Other installations must review and apply pending migrations before deploying the updated build. Stop the old bot first; it is not compatible with the new attendance/bounded-balance accounting. Existing guilds start attendance accounting on the next full Kyiv day after migration, with fresh streaks; live balances are clamped to −500…5,000 without rewriting published history. Migrations must be reviewed and explicitly applied with `npm run db:migrate` from a trusted checkout. Do not use `migrate reset` or automatic startup migrations.

### Neutral voting rename: hosted migration applied

`20261111090000_neutral_voice_polls` was **applied to the configured hosted database with explicit approval and confirmation that the bot was stopped**. All ten migrations are applied, the migration checksum matches, and the Prisma schema diff is clean. Before/after verification confirmed unchanged poll/vote/member rows and preserved table OIDs. The matching bot build still needs to be uploaded before restarting. It renames poll/vote tables to `voice_reputation_polls` / `voice_reputation_votes`, `actual_fine` to `applied_amount`, and the associated indexes/constraints. It preserves rows, IDs, deadlines, choices, audit results and balances. Old migrations are not rewritten.

For other installations, or when reviewing the cutover:

1. Prefer letting active polls finish before stopping the bot. A deadline missed during downtime still cancels without financial change, as designed.
2. Stop **all** old bot instances. Review the migration and preserve a verified backup/restore point.
3. With explicit approval, apply the pending migration from the trusted checkout using `npm run db:migrate`; verify status. Do not reset or drop/recreate tables.
4. Replace the entire old hosted `dist/` with the fresh build (including generated Prisma Client), then start only the new version. Old binaries cannot use the renamed schema. Local `npm run build` now cleans obsolete compiled modules automatically.

The slash-command definitions, both existing button prefixes, and `VP:<id>:active|final` message markers are unchanged. No command re-registration is needed solely for this rename if both commands are already registered. Do not roll back to the old binary against the renamed database; any reverse cutover needs a separately reviewed migration.

## 2. Register slash commands explicitly

Your local `data/config.json` must contain the correct application client ID and bot token. Then, when you approve updating this application's global command list:

```bash
npm run commands
```

This contacts Discord and replaces this application's global command registrations with the **18 commands** in the repository. Do not use another bot application's credentials. Refresh Discord/wait for command propagation if new commands do not appear immediately.

Do not put the Discord token in GitHub's backup secrets. The backup workflow does not need it.

## 3. Upload the production files

Upload through KataBump's file manager or SFTP:

- The **entire `dist/` directory**, including `dist/generated/prisma/`.
- `package.json` and `package-lock.json`.
- Private `data/config.json` containing the bot token/client ID.
- A minimal private server `.env`, or equivalent hosting environment variables.

Do **not** upload Windows `node_modules`, Git metadata, tests, plaintext dumps, backup keys, or the entire developer `.env`. The running bot does not need the Prisma bucket credentials or the backup encryption key. Backup scripts run separately in GitHub Actions.

Example server-only environment (replace placeholders privately):

```dotenv
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/postgres?sslmode=require
REPUTATION_GUILD_ID=YOUR_DISCORD_SERVER_ID
REPUTATION_TRACKING_ENABLED=false
```

Use Discord Developer Mode → right-click the server → **Copy Server ID**. Existing hosting environment variables override `.env`; changing a file will not replace an already-set hosting value.

Production dependencies can be installed with:

```bash
npm ci --omit=dev
```

KataBump may run installation automatically; verify its configured behavior. The bot uses the prebuilt output and does not need TypeScript or the Prisma CLI on the production host. Build locally again after source/schema changes and upload the complete new `dist/`, not only `index.js`.

The existing downloader's install-script/deprecation warnings are separate from reputation startup. Do not blindly approve every dependency script or run forced dependency upgrades as a deployment fix.

## 4. Configure startup without TypeScript execution

In **Startup**:

- Docker image: **NodeJs 24**.
- **JS FILE:** `dist/index.js`.
- Resulting command: `node /home/container/dist/index.js`.

If the panel permits a custom command, `npm start` also runs the compiled output. **Do not use `node src/index.ts`.** `npm run dev` is the local build-and-start command, not the production entry point.

Keep background reputation disabled for the first start. Confirm the console reports the correct bot login and that existing commands work. Run only **one active bot instance** for this server; do not leave a local `npm run dev` instance running beside KataBump.

## 5. Set the report destination and check permissions

A member with **Manage Server** runs:

```text
/set-reputation-report id:TEXT_CHANNEL_ID
```

The bot needs **View Channel**, **Send Messages**, **Embed Links**, and **Read Message History** there. Use a regular server text channel, not a thread, voice channel, forum, or Stage channel. This destination receives daily reports and reusable operational warnings.

Check while background tracking is still disabled:

- `/reputation-rules` is visible only to its caller.
- `/reputation` shows a settled balance publicly.
- `/reputation-all` privately lists participants and their settled balances without pagination. Long lists are attached in full as `reputation-all.txt`.
- `/voice-today` clearly says collection is inactive/unavailable, not that the bot is earning time.
- `/reputation-off` and `/reputation-on` save only your own preference privately. They do not override the global switch.
- `/voice-penalty user amount` and `/voice-reward user amount` need View Channel in the original voice channel and View Channel, Send Messages, Embed Links, Read Message History, and Attach Files at the poll destination. It is an interactive feature independent of the passive tracking flag; test only with consenting members. Real fines take effect immediately at the deadline and are not automatically refunded.
- Do not confirm `/reputation-delete` on an account whose data you want to keep. It is a real irreversible live-data reset, not a deployment health check.

The code already subscribes to `GuildVoiceStates`; the bot does not join voice or record audio. Keep the Message Content privileged intent enabled for the bot's existing nickname-suggestion features. No new voice-specific privileged-intent toggle is needed.

## 6. Complete the backup walkthrough

Follow [BACKUPS.md](BACKUPS.md): configure private GitHub secrets, validate, explicitly run the first encrypted backup, verify it, and test restoration into a separate disposable database. Scheduling and destructive retention stay disabled until you choose to enable them.

Neither repository code nor a green synthetic test proves the real bucket/runner/database permissions work. Do not claim a successful recovery plan before the live export/restore test.

## 7. Activate background reputation deliberately

After reviewing the rules, report destination, database status, and operational/backup checks, set the actual hosting value:

```dotenv
REPUTATION_TRACKING_ENABLED=true
```

Restart the bot once. This activates tracking, settlement, report delivery, and operational warnings for **only** `REPUTATION_GUILD_ID`. Members' `is_tracking` preferences still apply.

Verify with your own account:

1. Join a normal voice channel; solo participation counts.
2. Spend at least 10 accumulated minutes there, across visits if desired.
3. `/voice-today` should include verified time and pending whole points (it requests an on-demand checkpoint).
4. `/reputation` does **not** add today's pending points before settlement.
5. At 00:00 **Europe/Kyiv**, the previous day's verified time settles and the daily embed appears.
6. If there are more than ten positive earners, anyone can navigate shared pages. Snapshot balances are the totals at that day's settlement, not their later live balances.

The first activation day is intentionally marked partial: the bot cannot observe earlier hours. A verified visit can advance attendance despite incomplete coverage (unless personally paused or before the policy boundary). Without a verified visit, absence requires every completed gap to be ≤5 minutes and their combined duration within the Kyiv day to be ≤30 minutes; otherwise both streaks freeze. Unknown/unclosed boundary gaps never authorize an absence penalty. Gap length includes unsaved checkpoint tails, and crossing-midnight gaps are checked in full. AFK/Stage/bot participation does not count; muted/deafened members count normally. Unrecorded gaps after crashes/outages are never invented as credit. Do not change the system clock, backdate production records, or force payouts to simulate midnight—use the automated settlement tests instead.

## 8. Operational checks

- Confirm that saved progress survives a normal restart; only verified time counts, and abrupt crashes may lose the recent unsaved tail.
- Warnings reuse a message: initial alert, hourly ongoing edits, and final recovery edit. No repeated pings. A completely stopped bot cannot announce its own outage; later coverage reports reveal the gap.
- If the report channel is inaccessible, restore permissions. Accounting continues independently. Pending/unfrozen reports follow later channel changes; published history and unconfirmed frozen deliveries keep their original channel.
- A deletion may require retry while a containing report's Discord delivery is unconfirmed. Restore access to the original channel so the bot can reconcile delivery safely; do not manually clear its publication state in SQL.
- Monitor Prisma operation/storage usage and the last successful external backup. Five-minute checkpoints are not the only database operations: commands, report pages, transitions, settlement, and backups add usage.
- Keep the encryption key and an occasional encrypted backup outside the Prisma account. Free database hosting has no automatic daily backup safety net.

For a deployment rollback, first disable background activity and stop the bot. Preserve the current database; do not run older code that assumes a destructive schema rollback. Reconcile any uncertain report state before reactivation. A production database restore requires a separate reviewed recovery procedure, not merely uploading an old dump.
