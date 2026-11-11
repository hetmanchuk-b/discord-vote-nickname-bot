# Voice Reputation — Planning Specification

Status: **stage 1 implemented; stage 2 voice tracking implemented behind an OFF-by-default flag**. This document records agreed rules, proposed interfaces, and unresolved decisions. No reputation payouts or member commands are active yet.

## Implementation progress

- Stage 1: Prisma ORM 7.10.1, generated CommonJS-compatible client, explicit `.env` loading, lazy PostgreSQL pool, initial guild/member schema and migration, and persistent `/set-reputation-report` settings command.
- Stage 2: single-server Discord voice-state integration, serialized five-minute checkpoints, unrounded verified voice intervals, tracking-run coverage, internal persistent pause/resume, and conservative restart/gateway/database recovery.
- The initial schema stores server-scoped report destinations and member identities, integer balances, and `is_tracking` (default true). Stage 2 adds tracking runs and voice intervals; settlement and immutable report snapshots remain future work.
- With the user's approval, stage-2 migration `20261111010000_voice_tracking` was applied to the hosted database using `prisma migrate deploy`; subsequent status verification confirmed both migrations are up to date. Tracking still requires explicit `REPUTATION_TRACKING_ENABLED=true` and `REPUTATION_GUILD_ID`; keep it disabled until settlement and member commands are ready.
- Database schema changes are explicit deployment steps; no migration is run automatically at startup. With the user's approval, `20261111000000_reputation_foundation` was applied to the configured Prisma database using `prisma migrate deploy`; subsequent `prisma migrate status` confirmed the schema is up to date.
- Next stages: daily settlement; member commands/deletion; reports/warnings; backups/deployment.
- Obtain user confirmation before applying further migrations to the hosted database. See `README.md` for stage-1 setup and testing instructions.

## Purpose

Reward members for time connected to server voice channels. The bot tracks connection time, not speech or audio. It does not need to join a voice channel; it must be online and receiving voice-state events.

Discord does not provide historical voice-duration reports. Tracking begins when this feature is enabled; earlier activity cannot be reconstructed from Discord.

## Confirmed earning rules

- Every **10 accumulated minutes of eligible voice time per Kyiv calendar day earns 1 reputation point**.
- Separate visits within the same day accumulate together. For example, 6 minutes plus 7 minutes earns 1 point.
- Being alone earns the full rate. The proposed 50% solo rate was repealed.
- Muted and deafened members still earn reputation.
- Bot accounts do not earn reputation.
- Only regular voice channels count; Stage channels and the server's AFK voice channel do **not** count.
- There is no daily reputation cap and no additional anti-farming rule.
- Incomplete 10-minute blocks are discarded at midnight; they do not carry into the next day.
- Reputation awards and settled balances are whole integers.
- Reputation is retained if a member leaves and later rejoins the server.

For each member and day:

```text
daily award = floor(verified eligible seconds / 600)
```

Time should be accumulated before rounding, not rounded separately for each visit.

| Daily eligible time | Daily award |
| --- | ---: |
| 9 minutes | 0 |
| 10 minutes | 1 |
| 29 minutes | 2 |
| 60 minutes | 6 |

## Daily accounting and settlement

- A day is a calendar day in **Europe/Kyiv**, not a rolling 24-hour window.
- At **00:00 Europe/Kyiv**, close the previous calendar day.
- Calculate each member's verified eligible time, convert it into points, and add those points to the permanent balance.
- Settled reputation updates once per day; today's earned reputation remains pending until settlement.
- Split ongoing sessions at local midnight. A member need not disconnect to receive the previous day's credit.
- Use timezone-aware calendar boundaries, including daylight-saving changes; do not hard-code a UTC offset or assume every day lasts exactly 24 hours.
- After a restart, automatically process missed settlements and publish delayed reports for their original dates.
- Retrying a settlement or restarting the bot must not award the same day's points twice.

## Commands and transparency

### `/reputation [user]`

- Shows the settled reputation balance, not today's pending award.
- Defaults to the caller.
- Can show another member's balance when that member is selected.
- Replies publicly.

### `/voice-today [user]`

- Members can inspect their own tracked statistics or another member's statistics.
- Replies publicly.
- Shows today's verified eligible time and expected pending award.
- Include the daily reset/rounding explanation where useful.
- Use a Discord user option to select another member rather than ambiguous free-text username lookup.

### `/reputation-off` and `/reputation-on`

- Members can pause and resume their own voice-reputation tracking using these commands.
- Tracking is **enabled by default**.
- Public `/voice-today` responses display **"Tracking paused"** when applicable.
- Other behavior is pending confirmation. Recommended semantics:
  - `/reputation-off` records eligible time up to the pause, then stops accumulating it.
  - Pausing does not delete previously recorded time, pending awards, or settled reputation; earlier verified time still settles normally.
  - `/reputation-on` resumes from the command time if the member is already in an eligible channel, or from their next eligible join otherwise.
  - Paused periods are not credited retroactively.
  - Persist the preference across reconnects, restarts, and server leave/rejoin.
  - Commands affect only the caller and reply ephemerally; repeated calls are harmless and report the existing state.
- A paused member's earlier daily earnings remain reportable under the existing positive-earner rule unless a separate visibility rule is approved. Confirm this distinction explicitly.

### `/reputation-delete`

- Deletes the invoking user's live reputation-feature data and requires explicit confirmation. Explicit exceptions: a minimal disabled-tracking user record, historical report snapshots/messages, and existing backups remain.
- Treat this as a self-service command, not permission to delete another user's data.
- Scope is reputation-feature records, not unrelated nickname-voting, archive, or other bot data.
- Confirmation is an ephemeral warning with Delete/Cancel buttons, restricted to the caller, expiring after **60 seconds**. Cancellation or expiry makes no changes.
- Remove/reset the live balance, pending earnings, voice records, and member-level daily reward data, while keeping the minimum user identity and `is_tracking = false`. Do not remove frozen historical report snapshots.
- Tracking remains disabled until the caller explicitly uses `/reputation-on`. The user proposed `is_tracking` on the user table; this is suitable. Prisma may expose it as `isTracking` while mapping the database column to `is_tracking`.
- Do not update already published historical reports or their saved pagination data. Historical daily points, balance snapshots, and aggregates remain unchanged.
- Do not include deleted live data in future reports, including reports not yet published. Define how this interacts with queued reports and later re-enrollment so deleted old earnings never reappear.
- Do not clear or rewrite existing backups in response to deletion. Routine backup retention is a separate policy. Restoring an old backup can restore deleted data or an outdated tracking preference; define and disclose restore handling rather than promising automatic deletion replay.
- Coordinate deletion with ongoing tracking and settlement so stale work cannot recreate deleted records or award deleted earnings.
- The confirmation must explain the retained identity/disabled flag, historical reports, and backups; do not describe this as erasing every copy of the user's data.
- After deletion, `/reputation-on` resumes from **zero reputation and zero accumulated time**, with no retroactive credit.

### `/reputation-rules`

- Publishes the earning and settlement rules on demand.
- Replies **ephemerally**, visible only to the invoking member.
- There is no requirement to post or pin a public rules message.

## Daily embed report

- Post to a main text channel that will be explicitly configured; do not guess the destination.
- Describe the **previous Kyiv calendar day**, clearly stating its date.
- Include all members whose daily award is greater than zero, paginated with **5 members per page**.
- Use **shared pagination**: a public embed with Previous/Next buttons. Members can navigate; the bot updates the visible page for everyone. Navigating cannot modify stored statistics.
- Display page numbers and disable navigation where there is no previous/next page. Single-page reports need no navigation controls.
- Historical pagination remains available after restarts, using saved daily results rather than temporary in-memory sessions.
- When nobody participated and tracking was complete, still publish a report with **"No activity recorded"**.
- Distinguish genuinely absent activity from missing observations during bot downtime.
- A day with incomplete tracking must include a clear coverage warning; do not imply the bot observed zero activity for the entire day.
- Delayed reports should retain the original day and be identifiable as delayed.
- If eligible activity occurred but nobody earned a point, publish **"No reputation earned today"**, without listing zero-point members.
- Each earning member's entry shows eligible voice time, daily points earned, and total settled reputation.
- Order by daily points descending, then eligible voice time descending, then user ID for a stable final tie-breaker.
- Snapshot total balances at settlement so historical report values remain stable.
- If no usable report channel is configured, continue tracking and settlement, queue reports, and publish them once a valid destination is configured. Log delivery failures without interrupting accounting.

## Downtime and verified time

- Award points **only for verified time**. Do not credit unobserved gaps by assuming members remained connected.
- After restart, reconcile members currently connected and resume tracking from when observations become available.
- Do not claim to recover voice activity from before tracking began or during an unobserved interval.
- The first partial day earns points for verified time from activation onward; label the report as partially tracked.
- Record tracking coverage separately from member activity so reports can distinguish zero activity from missing data.
- Database outages: stop crediting time that cannot be durably recorded and flag tracking as incomplete. No durable local fallback is required.
- Send operational tracking warnings to the configured reputation report channel.
- Avoid warning spam: post one initial alert for an incident, then edit that same message at most once per hour with updated status and time. Perform a final recovery edit when resolved.
- Do not send repeated pings or create a new message for each failed retry. Background recovery attempts and public warning edits have separate schedules.
- Preserve previously recorded time; do not backfill the unrecorded gap after recovery.
- Proposed recovery: reconcile current voice states after database connectivity returns and resume from a new verified checkpoint.
- If settlement cannot run because the database is unavailable, defer it until recovery; the previously agreed missed-settlement behavior applies.
- Persist periodic checkpoints every **5 minutes**, with additional saves on relevant voice transitions and settlement.
- An unexpected crash may lose approximately up to 5 minutes of recent unpersisted eligible time under healthy database operation; database/network outages can create longer gaps. Do not invent credit for lost time.
- Consider batching active-member updates rather than one network operation per member. Actual database operations and costs depend on the Prisma/provider setup; a batch may execute multiple SQL statements.
- Stage 2 stores coverage as `[run.startedAt, run.verifiedThrough)` alongside atomic interval writes. Closing/replacing a run does not advance `verifiedThrough`.
- An uncertain checkpoint acknowledgement is not blindly replayed. Recovery starts a fresh run, accepting only intervals that actually committed.
- After more than six minutes without a successful checkpoint, drop the unsaved tail and start a fresh baseline (five-minute schedule plus one-minute grace). This conservatively excludes long event-loop/host suspensions.
- Discord disconnects or unavailable guilds suspend tracking. Reconnects reconcile current eligible members; queued pre-recovery snapshots cannot retroactively credit downtime.
- Stage 2 logs status changes to the console only. Public warning delivery/throttling remains a later stage.

## Technical design (partially implemented; see progress above)

- Consume Discord voice-state events; the existing bot already enables the `GuildVoiceStates` intent.
- Track joins, leaves, switches into/out of the AFK channel, and sessions spanning midnight.
- Moving between eligible channels should preserve accumulated eligible time.
- Use persistent storage so restarts do not erase sessions, balances, or settlement records.
- **PostgreSQL with Prisma ORM** is the chosen storage direction, replacing SQLite.
- The user reports having created a database in Prisma and added `DATABASE_URL` to the local `.env`. Connection details have not been inspected or tested during planning.
- Stage 1 explicitly loads the root `.env` for local execution without overriding hosting environment variables. Configure credentials securely on the hosting server as well. Never commit connection strings or include them in reports.
- The first version serves one Discord server. Retaining server IDs in database keys is still recommended for isolation.
- `/set-reputation-report [ID]` sets or changes the destination for both daily reports and operational warnings.
- Proposed command semantics: accept a channel ID, validate that it belongs to this server and that the bot can view it, send messages, and embed links, then persist the setting in PostgreSQL.
- Require the Discord **Manage Server** (`ManageGuild`) permission for `/set-reputation-report [ID]`, enforced when the command runs as well as through default command permissions.
- Configuration-command confirmations and errors are ephemeral. If no usable channel is configured, accounting continues and report delivery is postponed.
- Stage 1 pins Prisma ORM/Client/PostgreSQL adapter to **7.10.1** (stable version selected rather than the registry's Prisma 8 release candidate), generates a CommonJS-compatible client, and includes an offline-generated initial migration.
- Candidate records: voice sessions/checkpoints, tracking-coverage intervals, daily summaries, reputation transactions, and settlement/report delivery status.
- Separate accounting from report delivery: an embed failure must not cause a second payout.
- Database provider: Prisma's hosted database, **Free plan**, as reported by the user: 200,000 operations, 1,000,000 compute requests, 2 GiB storage, up to 50 databases, community support, and **no daily backups**. Billing/reset semantics and metering definitions have not been independently verified.
- A 5-minute schedule has 288 checkpoint opportunities per 24-hour period, or 8,640 per 30 days. These are timer cycles, **not a forecast of billed operations**: checkpoint statements, transitions, commands, reads, settlements, and retries must also be accounted for under provider metering.
- Plan batched writes, avoid overlapping checkpoint jobs, and use bounded retry/backoff rather than continuous outage polling. Exact query strategy and usage monitoring remain to be designed.
- Do not assume the database Free plan provides daily backups. The user has created a **Prisma Object Store bucket** as the proposed backup destination; its credentials, connectivity, and pricing have not been inspected or tested.
- Prisma Object Store is S3-compatible and can hold uploaded database exports. Creating a bucket does not schedule or produce database backups.
- Proposed workflow: a scheduled job obtains a consistent PostgreSQL dump using a direct database connection, uploads a uniquely dated export, verifies success, and removes older exports according to an agreed retention policy. Choose the scheduler, encryption/access policy, and retention before implementation.
- The user reports adding bucket credentials to local `.env`; values have not been inspected or tested. Local `.env` does not automatically supply credentials to a hosted bot or an external backup scheduler.
- Recommended scheduler: a separate GitHub Actions workflow, with a daily schedule and manual trigger, PostgreSQL client tools, and an S3-compatible upload client. This is a proposal, not a configured workflow. Use repository/environment secrets; never commit `.env`, credential-bearing URLs, or backup files.
- GitHub scheduled jobs can be delayed or dropped, and schedules in public repositories are disabled after 60 days without repository activity. Monitor the last successful backup and retain a manual-run option; the schedule is not a guaranteed backup SLA.
- Prefer a non-midnight/non-top-of-hour backup time, after expected settlement, and keep 7 successful daily exports initially (proposal). Never delete the last good backup before a replacement is verified. Decide encryption and restore testing before implementation.
- A bucket-scoped `read_write` key can upload and delete objects; keep it secret. Prisma Object Store has no versioning or soft delete, so deleting an object is irreversible through its API. Do not rely on automatic lifecycle cleanup without verifying support.
- A bucket in the same Prisma account is outside KataBump but not independent of Prisma/account-wide failures or compromise. An occasional separate downloaded copy remains recommended.
- Bucket pricing and plan limits were not published in the storage documentation checked during planning; do not assume database Free-plan allowances cover bucket storage.
- A backup must be a consistent database export with schema and reputation data, not merely a copy of the bot source or `.env`. Credentials must not appear in logs or public artifacts.

## Out of scope / superseded ideas

- Historical voice-time backfill from Discord.
- Listening to or recording audio, or measuring actual speaking time.
- Reduced earning rate for solo participation.
- Requiring multiple participants to earn points.
- Daily point caps or additional anti-farming rules.
- Carrying incomplete 10-minute blocks into the next day.
- The original absence-based idea ("John did not join, so Nathan gets +10") has been replaced by voice-time rewards and is not part of this version.
- A reputation leaderboard was suggested but has not been approved.

## Database provider

Decision: **Prisma Postgres Free with Prisma ORM**.

- Database storage: **2 GB**.
- Database allowance: **200,000 operations/month**; pricing defines 1 query as 1 operation.
- Connections: **10 pooled and 10 direct** connections listed.
- Automatic database backups are not included; arrange scheduled exports separately.
- Prisma's **1 million Compute requests** are a separate app-hosting allowance, not an extra database-query allowance for the KataBump bot.

Source: https://www.prisma.io/pricing

## Open rules and product decisions

1. Define behavior for deleted report messages and simultaneous pagination clicks.
2. Finalize report layout and operational warning presentation.
3. Decide whether changing the report channel affects old report messages or only future/undelivered reports.
4. Should any administrative balance adjustments or corrections be allowed? None are currently specified.
5. Verify provider metering and finalize a backup/export policy. Stage 1 selects Prisma 7.10.1 with the PostgreSQL adapter and explicit versioned migration deployment.
6. Decide raw session/checkpoint retention versus long-term daily summary retention.
7. Decide how Discord warnings are handled if the configured channel is inaccessible. Stage 2 implements conservative checkpoint/reconnect reconciliation and bounded retries.
8. Confirm remaining pause/resume semantics: persistence, treatment of earlier pending awards, and ephemeral command replies. Defaults and public paused-status display are confirmed.
9. Confirm the external backup scheduler, export retention/encryption, access secrets, and failure monitoring. The user requests step-by-step guidance for GitHub Actions; no workflow has been created yet.
10. Specify exclusion from queued unpublished reports and backup restore handling. Deletion confirmation expires after 60 seconds, and re-enrollment starts from zero; both are confirmed.
