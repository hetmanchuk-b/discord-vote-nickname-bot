# Voice Reputation — Planning Specification

Status: **stages 1–6 implemented**, including member commands, reports/warnings, encrypted backup tooling, and deployment/setup guides. All background reputation activity remains **OFF by default**. GitHub secrets and manual backup/verification have been configured, and an approved restore into a separate test database succeeded. Scheduling, command deployment, and production activation remain explicit pending rollout steps.

## Implementation progress

- Stage 1: Prisma ORM 7.10.1, generated CommonJS-compatible client, explicit `.env` loading, lazy PostgreSQL pool, initial guild/member schema and migration, and persistent `/set-reputation-report` settings command.
- Stage 2: single-server Discord voice-state integration, serialized five-minute checkpoints, unrounded verified voice intervals, tracking-run coverage, internal persistent pause/resume, and conservative restart/gateway/database recovery.
- Stage 3: DST-safe Kyiv-day boundaries, transactional whole-point payouts, immutable post-payout balance values in daily results, coverage summaries, duplicate-payout prevention, and startup/midnight catch-up with bounded retries.
- Stage 4: public balance/today commands, ephemeral rules and pause/resume commands, caller-bound 60-second deletion confirmation, and transactional live-data erasure. A monotonic member eligibility cutoff protects against stale work after deletion/re-enrollment.
- With the user's approval, stage-4 migration `20261111030000_member_controls` was applied to the hosted database using `prisma migrate deploy`; subsequent status verification confirmed all four migrations are up to date. All **124 tests** passed against a disposable local database with integration tests enabled; schema validation, type-check, lint, and build also passed. Discord command deployment has not been run.
- Stage 5: positive-earner embeds (10 per shared page), durable publication snapshots/message identities, lost-acknowledgement reconciliation, and a reusable hourly-updated warning message aggregating tracking/settlement/delivery health.
- With the user's approval, stage-5 migration `20261111040000_reports_and_warnings` was applied to the hosted database using `prisma migrate deploy`; subsequent status verification confirmed all five migrations are up to date. All **164 tests** passed with local database integration enabled, including snapshot retention, erasure/publication races, shared navigation, lost acknowledgements, warning recovery, and throttling. Schema validation, type-check, lint, and build also passed. Discord transport was mocked: no live messages or command deployment were performed. Background activity remains disabled by default.
- The initial schema stores server-scoped report destinations and member identities, integer balances, and `is_tracking` (default true). Stage 2 adds tracking runs and voice intervals. Stage 3 adds unique day ledgers, member/day results, and a settled-through watermark. Stage 5 adds published report snapshots, delivery state, and persistent warning metadata.
- With the user's approval, stage-2 migration `20261111010000_voice_tracking` was applied to the hosted database using `prisma migrate deploy`; subsequent status verification confirmed both migrations are up to date. Tracking still requires explicit `REPUTATION_TRACKING_ENABLED=true` and `REPUTATION_GUILD_ID`; keep it disabled until deployment verification is complete and activation is explicitly chosen.
- Database schema changes are explicit deployment steps; no migration is run automatically at startup. With the user's approval, `20261111000000_reputation_foundation` was applied to the configured Prisma database using `prisma migrate deploy`; subsequent `prisma migrate status` confirmed the schema is up to date.
- With the user's approval, stage-3 migration `20261111020000_daily_settlement` was applied to the hosted database using `prisma migrate deploy`; subsequent status verification confirmed all three migrations are up to date. Applying this migration does not activate tracking or issue payouts by itself.
- Stage-3 verification: all **85 tests** passed with integration tests enabled against a disposable local Prisma PostgreSQL-compatible database, including SQL rollback, concurrent payouts, DST days, midnight splitting, and stale checkpoint clipping. Schema validation, type-check, lint, and build also passed. The local database process was stopped afterward.
- Stage 6: manual-first GitHub Actions workflow, streaming AES-256-GCM archives, direct PostgreSQL 17 public-schema exports, Prisma Object Store upload/read-back authentication/catalog verification, and opt-in prefix-scoped retention. The workflow uses Node built-ins plus external tools, not extra bot dependencies.
- Stage-6 verification: all **179 tests** passed with local reputation-database integration enabled. Encryption/authentication and filesystem cleanup are real; PostgreSQL archive tools and S3 operations in backup tests are simulated. Type-check, lint, build, and workflow YAML parsing passed.
- Live stage-6 verification: the owner configured GitHub secrets and reported successful manual check/backup/verify runs. With explicit approval, the agent authenticated the downloaded archive and restored it transactionally into a separately configured empty Prisma test database using Docker PostgreSQL 17. All 10 application tables, 19 indexes, 11 foreign keys, 7 check constraints, and 5 completed migrations with matching repository checksums were verified. Existing managed `public` schema creation/comment entries were excluded through a reviewed catalog list; no schema was dropped. The archive contained no reputation activity yet, so populated member/report recovery still needs a later representative test. Temporary plaintext was removed; production was not modified.
- Backup scheduling and retention deletion remain OFF pending separate opt-in. No production restore or stage-6 database migration was performed.
- Step-by-step rollout guidance and the live restore checkpoint are in `BACKUPS.md` and `DEPLOYMENT.md`. Failure notifications, scheduling, command deployment, and activation still require owner setup/approval.
- Obtain user confirmation before applying further migrations to the hosted database. See `README.md` for stage-1 setup and testing instructions.

## Attendance extension rollout

Attendance bonuses, absence penalties, persistent pause history, bounded balances, and streak displays are implemented. With explicit user approval and confirmation that the bot was stopped, migration `20261111050000_attendance_rewards` was applied to the hosted database. Subsequent status verification confirmed all six migrations are up to date. Existing guilds begin the policy on the next full Kyiv day after migration with zeroed streaks; existing verified participation seeds penalty eligibility, live balances are clamped, and historical awards/report snapshots are preserved. Stop the old bot before migration/deployment. Newly created guilds can begin on their first fully observed day. Checkpoints remain at five minutes.

Verification: all **217 tests** passed with database integration enabled against a disposable local Prisma PostgreSQL-compatible database. This includes a legacy-schema upgrade fixture, day-3/10/17 rewards, day-8 penalties, pause history/zero-duration boundaries, downtime freezes, DST, clamping, transactional rollback/concurrent retries, deletion, and bonus reports with negative balances. Type-check, lint, schema validation, build, fresh migration deployment, and schema-diff checks passed. The hosted attendance migration was subsequently applied with approval; no live Discord test or bot deployment was performed.

## Warning history rollout

Warning descriptions now retain reason changes, hourly snapshots, and recoveries in chronological order, with dates and `HH:mm` timestamps in `Europe/Kyiv` (DST-aware). A maximum of 100 safe-category entries is persisted; the description includes the newest whole entries that fit Discord's 4,096-character limit and indicates when older entries are hidden. Acknowledgement retries reuse the same entry; restart and outage recovery preserve/merge history by immutable event IDs. Hourly throttling and no-ping delivery remain unchanged. Raw exception messages or connection details are not stored in history or rendered.

Migration `20261111060000_warning_history` was applied to the hosted database with explicit approval; subsequent status verification confirmed all seven migrations are up to date. It adds the JSON history column; existing rows default to an empty array, then adopt their latest known state on first use. Earlier pre-upgrade edits cannot be reconstructed. Do not deploy this build before the migration. All **224 tests** passed with local database integration enabled; type-check, lint, build, schema validation, fresh local migration deployment, and schema-diff checks passed. The hosted migration was subsequently applied with approval. No live Discord messages were changed and no bot deployment was performed.

## Sanitized diagnostic summaries

Warnings retain their stable `tracking`/`settlement`/`reports` categories and now include allowlisted diagnostic identifiers in the existing history JSON. Public Ukrainian explanations identify known database timeouts, authentication/TLS/schema/connection-limit failures, gateway/guild/observation gaps, tracking ownership loss, missing report configuration, individual missing Discord permissions, and delivery failures. Structured Prisma/PostgreSQL/Discord codes and bounded cause chains are classified; raw exception messages, stacks, SQL, host names, URLs, and credentials are never copied or parsed. Unknown failures receive generic safe summaries. Up to four diagnostic codes per category bound message size.

Cause changes within an active category are recorded even inside the hourly delivery window. Generic health refreshes do not erase a specific known cause. Recovery clears current diagnostics but preserves earlier history. Existing category-only history is still readable; restored current diagnostics are derived from the latest matching history snapshot. No new migration or hosted database change is required. All **252 tests** passed with local database integration, including safe classification, adapter causes, permission checks, cause changes, persistence, hostile/cyclic error objects, and secret-leak protection; build, type-check and lint passed. Discord delivery was mocked; this extension has not been deployed.

## Voice penalty polls

`/voice-penalty user amount` is implemented with durable 120-second Yes/No button polls for 10, 50, or 100 reputation points. A start requires four humans (including initiator and target) in the same regular voice channel; the initiator cannot target themselves or bots. Targets need prior verified participation, including unsettled recorded visits; paused participants remain eligible, but erased/never-participating targets and balances at −500 are rejected privately. There is one active/creating reservation per target and no cooldown.

Votes can change, are private while active, and are ordered by Discord interaction snowflakes rather than completion order. Voters must be human in the original channel both when casting and at the deadline; the target cannot vote. Later arrivals are allowed. Four people are not required at closure, and target departure does not cancel. One eligible Yes and zero eligible No apply an immediate bounded fine; success displays actual points deducted. Failure identifies eligible No voters only, with no numeric totals. Large lists use an attachment, never silent truncation or mention pings.

Presence is gateway-observed: short event journals reconstruct start/deadline rosters through at most two seconds of normal timer/API jitter. This never extends vote acceptance. Missing visibility/member data, reconnects after the deadline, or excessive delay cancel without a fine. Restart before deadline resumes durable active polls; missed deadlines do not use restart-time attendance. In-memory verified evidence survives DB retries; if lost on restart, the poll cancels. Poll messages are nonce/marker reconciled, never blindly recreated; unresolved creating reservations are bounded and may cancel conservatively. Discord delivery is not exactly-once, but orphan/copy buttons cannot authorize a fine without the stored message identity.

Financial finalization, daily settlement, vote updates, and erasure share the guild-row lock. Result status and balance delta commit atomically; retries cannot charge again. A fine does not alter attendance/absence streaks or frozen daily snapshots. Private choices are deleted on closure. Published poll outcomes/No identities remain public history; deletion cancels unpublished target polls, resets their unpublished financial results, and removes private choices/pending veto identities. Ambiguous result delivery guards erasure until same-message reconciliation, including a terminal missing-message state. Missing poll messages detected before deduction cancel; deletion after a committed fine is not a refund.

Migration `20261111070000_voice_penalties` was applied to the hosted database with explicit approval; subsequent status verification confirmed all eight migrations are up to date. It adds the poll/vote tables, constraints, and a partial unique active-target index; it does not adjust existing balances. `REPUTATION_GUILD_ID` scopes polls independently of the passive tracking flag. No slash-command deployment or live Discord polling has been performed. The destination must be visible to the original voice participants; private/hidden-channel polls are rejected. See `README.md` for requirements and permissions.

Verification: all **291 tests** passed with local database integration, including concurrent reservations/finalization, ordered changing choices, floor clamping, deadline eligibility, erased targets, unpublished/published veto privacy, rollback, daily-settlement races, restart/acknowledgement recovery, message identity, and observed presence reconstruction. Type-check, lint, build, schema validation, fresh local migration deployment and schema-diff checks passed. The hosted migration was subsequently applied with explicit approval. No bot deployment, slash-command registration, or live Discord poll was performed by the agent.

## Voice reward extension

`/voice-reward user amount` mirrors `/voice-penalty` with 10/50/100-point awards and a 5,000 ceiling. Both use the same runtime, persistence, 120-second deadline, verified four-human start, ordered/private changeable buttons, final original-channel eligibility, unanimity, restart/cancellation rules, erasure guards, and No-voter-only failure disclosure. Targets cannot vote for themselves, must have prior verified participation, and can be personally paused. Awards are immediate, report their actual ceiling-limited magnitude, and leave attendance counters unchanged. A floor balance may receive rewards; a ceiling balance is rejected/cancelled. Both kinds share the existing unique active-target reservation with no cooldown.

Migration `20261111080000_voice_rewards` was applied to the hosted database with explicit approval; subsequent status verification confirmed all nine migrations are up to date. It adds `kind` (defaulting existing rows to `penalty`) and `balance_before`, without changing balances or historical choices/outcomes. That migration retained the then-legacy table/positive-magnitude field names; the neutral-name cutover below replaces them. Persisted kind determines credit versus debit. The reward-direction constraint requires a valid pre-balance audit and positive bounded credit, preventing a legacy penalty-only binary from successfully debiting a reward. Stop the old bot before deploying the new build; the hosted migration was applied with approval, but no command registration, live Discord vote, or bot deployment was performed for this extension.

All **305 tests** passed with local database integration, including capped/exact-once credits, paused/floor targets, veto/no-Yes/unverified outcomes, cross-kind reservation/button isolation, erasure, settlement races, legacy schema upgrades/history preservation, and rollback of legacy-style reward debits. Build, type-check, lint, schema validation, fresh local migration deployment and schema-diff checks passed.

## Quarter-point accounting and 25% solo rate

Implemented integer quarter-unit storage with public point-valued views and localized quarter-point formatting. Live tracking records interval `earning_rate` (1 solo / 4 full), flushes rate changes even for same-roster room moves, and combines weighted time before one daily quarter rounding. Daily `solo_ms` and unweighted `eligible_ms` preserve attendance/graph history after raw retention. Bonuses, absence penalties, streak qualification, displayed bounds and vote choices are unchanged; capped votes can apply an exact 0.25-point delta.

Migration `20261111110000_quarter_points_and_solo_rate` was applied to the hosted database with explicit approval and confirmation that the bot was stopped. It scales every retained monetary value, historical snapshot and poll audit ×4 exactly once and renames physical money columns to `*_units`, preventing old binaries from reading/writing the new unit system. Old interval occupancy cannot be inferred, so existing raw records retain full earning rate; `solo_ms=0` for historical daily records does not prove there was company. Completed ledger values remain the same in displayed points and are never recalculated. New rounding applies to subsequent settlements, including still-unsettled pre-cutover time at its retained full rate.

All twelve hosted migrations are applied and the schema diff is clean. Streaming before/after checksums across all twelve application tables verified preserved displayed financial values, IDs, poll state, durations, streaks, coverage and metadata; table OIDs, legacy rate defaults and the migration checksum were also verified. Other installations must stop all old instances and explicitly apply the reviewed migration first. Deploy the matching full build before restarting one instance; old binaries are incompatible. No command/option changes require registration for this feature. No command registration or bot deployment has been performed.

All **413 tests** passed with disposable local PostgreSQL-compatible integration enabled (none skipped). Tests cover scaled raw storage, mixed-rate 1.75-point earnings, quarter rounding, same-roster rate changes, bots/paused company, outage recovery, midnight/DST clipping, opt-outs, exact fractional vote bounds, retained graph history, full legacy migration preservation and overflow rollback. Type-check, lint, clean build, schema validation, deployment of all twelve migrations and a zero-difference schema comparison passed. Legacy behavior fixtures use a test-only point-valued adapter; the new storage/migration tests deliberately assert raw persisted units.

## Fourteen-day raw interval retention

Automatic raw-interval cleanup is implemented in `src/reputation/interval-retention.ts`, wired into the tracking-gated settlement scheduler after successful catch-up. It deletes only rows ended at least 14 × 24 hours ago and wholly at/before the committed Kyiv-midnight settlement watermark, for members whose participation is already persisted. It uses the shared guild lock and bounded 1,000-row transactions, yields between backlog batches without amplifying tracker writes, and retries maintenance failures independently of accounting health with safe console diagnostics.

Daily awards for historical attendance heatmaps, day ledgers, balances, streaks, report snapshots, observation runs and pauses remain unchanged. Cutoff-crossing/unsettled intervals, unknown participation proof and missing/malformed watermarks are protected. No raw archive is created; existing backups are not rewritten. Self-service erasure still applies to personal daily history. The next deployment with tracking enabled will activate irreversible cleanup, including an existing backlog; no hosted cleanup or deployment has been performed for this feature. No migration or command re-registration is required.

All **389 tests** passed with disposable local database integration enabled (none skipped), including exact age/settlement cutoffs, preserved daily/report history, cross-guild isolation, concurrent batches, rollback/restart, scheduling, safe independent retries and shutdown. Type-check, lint and clean build passed.

## Required voice-vote reasons

Both `/voice-penalty` and `/voice-reward` require a nonblank `reason` string, trimmed and limited to 1,000 Unicode characters. New requests are validated at command/runtime/storage boundaries. `proposalReason` / `proposal_reason` is separate from internal cancellation codes. Reasons survive restarts, appear during voting and remain in successful results, with Markdown escaping and no mention notifications. Failed/cancelled reasons are discarded; erasure removes authored reasons awaiting final publication and guards uncertain successful publication, while published successful reasons remain public history. Legacy/erased NULL reasons do not produce invented text or prevent an existing poll from finishing.

Migration `20261111100000_voice_poll_reasons` was applied to the hosted database with explicit approval and confirmation that the bot was stopped. All eleven migrations are applied and the schema diff is clean. Before/after verification confirmed unchanged poll/vote/member rows, preserved table OIDs, NULL historical reasons, a validated constraint and a matching migration checksum. Other installations must stop the bot and explicitly apply the migration first. Deploy the matching build and explicitly re-register the existing 18 commands for their new required option before restarting. No command registration, live Discord messages or bot deployment has been performed for this feature.

All **371 tests** passed with disposable local database integration enabled (none skipped). Coverage includes both command definitions, blank/oversized/Unicode validation, escaped rendering during voting and after success, restart and exact-once persistence, legacy upgrade preservation, cancellation codes, and unpublished/published reason erasure guards. Type-check, lint, clean build, schema validation, fresh deployment of all eleven migrations and a zero-difference Prisma schema comparison passed.

## Outage-tolerant streaks

Implemented verified-attendance progression despite global outages, plus absence tolerance of ≤5 minutes per completed gap and ≤30 minutes total per Kyiv day. Personal pauses and pre-policy days remain exempt. Unknown boundary gaps remain conservative, cross-midnight gaps cannot evade the per-outage limit, and daily coverage warnings/voice-time accounting stay exact. No schema migration or command re-registration is needed; the policy applies to subsequent settlements, including unsettled catch-up days, without rewriting completed ledgers.

All **351 tests** passed with disposable local database integration enabled (none skipped), including millisecond boundaries, both gap limits, cross-midnight budgets, DST, unknown edges, pause precedence and bonuses on incomplete days. Type-check, lint and build passed. No hosted migration, registration or bot deployment was performed for this change.

## Private participant list

`/reputation-all` lists participants and their settled reputation privately, highest balance first with a stable user-ID tie-break. It shows only participant mentions and balances, without pagination or extra statistics. Zero/negative balances and paused participants are included; erased/never-participating identities are excluded, while verified unsettled participation qualifies. Reads do not checkpoint tracking or change balances. Lists exceeding Discord's 2,000-character message limit are attached in full as `reputation-all.txt` instead of being truncated.

All **316 tests** passed with disposable local database integration enabled (none skipped); type-check, lint and build passed. No new schema migration is needed. Register the updated **18-command** list explicitly with `npm run commands` before using the new command; registration and bot deployment have not been performed for this addition.

## Neutral shared voting names

Shared modules/types now use `voice-poll-*` / `VoicePoll*`, and the client exposes `voicePolls`. Prisma models are `VoiceReputationPoll` and `VoiceReputationVote`; `appliedAmount` is a positive magnitude with direction determined by `kind`. Migration `20261111090000_neutral_voice_polls` renames the existing PostgreSQL tables to `voice_reputation_polls` / `voice_reputation_votes` and the column to `applied_amount`, including associated index/constraint identifiers. It does not recreate tables or alter data, balances, choices, deadlines or published audit history. Historical migrations remain unchanged.

With explicit approval and confirmation that the bot was stopped, the hosted rename was applied. All ten migrations are applied and the schema diff is clean; before/after verification confirmed unchanged poll/vote/member rows, preserved table OIDs and a matching migration checksum. Other installations must stop all old instances before applying it. Deploy the matching new build before restarting; old binaries are incompatible with the new names. Existing commands, button prefixes and `VP:<id>:active|final` markers remain compatible. Missed unverifiable deadlines still cancel safely. See `DEPLOYMENT.md` for the coordinated cutover. Builds now clean stale compiled modules from `dist/`.

Verification: all **308 tests** passed with disposable local PostgreSQL-compatible integration enabled (none skipped). The upgrade fixture verifies unchanged poll/vote/member rows and table OIDs, preserves published audit/veto history, resumes legacy penalty/reward choices through the new Prisma delegates, and finalizes both kinds exactly once. Fresh deployment of all ten migrations and the Prisma schema diff passed with no differences; the publication-retry index has an explicit short name to avoid PostgreSQL identifier truncation. Type-check, lint, schema validation and the clean build passed. The hosted migration was subsequently applied and verified with explicit approval. No command registration, live Discord poll or bot deployment was performed for this refactor.

## Purpose

Reward members for time connected to server voice channels. The bot tracks connection time, not speech or audio. It does not need to join a voice channel; it must be online and receiving voice-state events.

Discord does not provide historical voice-duration reports. Tracking begins when this feature is enabled; earlier activity cannot be reconstructed from Discord.

## Confirmed earning rules

- In the same regular voice room with another human, **10 minutes earns 1 point**; alone, **10 minutes earns 0.25 points** (25% rate).
- Separate solo/group visits accumulate before rounding. For example, 30 solo minutes plus 10 group minutes earns 1.75 base points.
- Bots do not count as company; muted/deafened and personally paused humans do. Changes in occupancy/earning rate checkpoint even if the set of eligible users is unchanged.
- Muted and deafened members still earn reputation.
- Bot accounts do not earn reputation.
- Only regular voice channels count; Stage channels and the server's AFK voice channel do **not** count.
- There is no daily voice-time cap and no additional anti-farming rule. The final balance is bounded to **−500…5,000**.
- The combined weighted result is rounded down to the nearest 0.25 points once per Kyiv day; smaller remainders are discarded, never carried.
- Reputation balances/awards are exact quarter-points. All stored money is integer quarter units (4 units = 1 displayed point); timestamps, eligible milliseconds and streak counts are not scaled.
- Reputation is retained if a member leaves and later rejoins the server.

For each member and day:

```text
base units = floor((4 * verified group milliseconds + verified solo milliseconds) / 600000)
base points = base units / 4
new balance = clamp(old balance + base points + attendance bonus - absence penalty, -500, 5000)
actual daily points = new balance - old balance
```

Time should be accumulated before rounding, not rounded separately for each visit.

| Verified solo time | Verified group time | Base points (before bonus/penalty and bounds) |
| --- | --- | ---: |
| 9 minutes | 0 | 0 |
| 10 minutes | 0 | 0.25 |
| 30 minutes | 10 minutes | 1.75 |
| 0 | 2.5 minutes | 0.25 |
| 0 | 60 minutes | 6 |

## Attendance and absence

- Any positive verified eligible voice time qualifies as attendance, including sub-ten-minute visits; zero-duration/unverified joins do not.
- Consecutive qualifying attendance days 1–2 pay no bonus; days 3–9 pay +5/day; days 10–16 pay +6/day; days 17–23 pay +7/day. Thereafter the daily bonus increases by +1 each seven days: `5 + floor((attendance streak - 3) / 7)` for streaks of at least 3. No retroactive payment for days 1–2.
- Only members with previous verified participation receive absence penalties. Completely observed missed days 1–7 cost −5/day; day 8 onward costs −10/day.
- Attendance resets absence; a genuine missed day resets attendance. Exempt days freeze both counters and neither advance nor break the streak.
- A verified visit advances attendance and resets absence even on an incompletely observed day. Without a verified visit, count absence only if each completed gap is ≤5 minutes and total missing coverage within the Kyiv day is ≤30 minutes. Both limits are inclusive. Otherwise freeze both streaks without bonus/penalty; unknown or unclosed boundary gaps are not assumed short.
- Gaps use verified observation timestamps (including lost checkpoint tails), not guessed process downtime. A gap crossing midnight is checked at its full length; only its overlap contributes to each day's daily budget. Incomplete flags and verified voice-time points remain strict—no missing time is filled or rewarded. Already-settled days remain unchanged.
- Any personal pause overlapping the day still exempts the entire day from attendance bonuses/absence penalties. Verified time still earns normal base points. Untracked members receive neither bonus nor penalty for untracked days.
- Pause intervals are persisted independently of the current preference, allowing historical settlement after a pause/resume/restart without guessing. Zero-length pause intervals do not exempt a day; midnight boundaries are half-open.
- Verified participation on an exempt day still establishes that the member has participated, without advancing a streak. Read-only statistics and preference commands alone never establish participation.
- Balance limits apply to the combined daily result. Streak counters keep advancing at either bound. Daily rows preserve base points, theoretical bonus/penalty, actual signed delta, final balance, exemption flag, and resulting streak counters.
- Deletion clears participation, both streaks and old pause history, retaining only a fresh open pause alongside the disabled identity. Re-enrollment requires new verified voice participation before penalties can apply.
- Positive actual earners remain the only public report entries, including sub-ten-minute attendance-bonus earners and members whose settled balances are negative. Penalties are reflected in balances and live day records, not added to the public earning list.

## Daily accounting and settlement

- A day is a calendar day in **Europe/Kyiv**, not a rolling 24-hour window.
- At **00:00 Europe/Kyiv**, close the previous calendar day.
- Calculate verified base points plus applicable attendance bonus/absence penalty, update streaks, and clamp the final balance atomically.
- Settled reputation updates once per day; today's earned reputation remains pending until settlement.
- Split ongoing sessions at local midnight. A member need not disconnect to receive the previous day's credit.
- Use timezone-aware calendar boundaries, including daylight-saving changes; do not hard-code a UTC offset or assume every day lasts exactly 24 hours.
- After a restart, automatically process missed settlements and publish delayed reports for their original dates.
- Retrying a settlement or restarting the bot must not award the same day's points twice.
- Stage 3 implements a unique server/day ledger and serializes tracking/settlement on the server row. Balance increments, daily results, and the closed-day watermark commit atomically. Removing member-level results cannot enable replay of a settled day.
- Late tracking writes are clipped to the watermark. Coverage and results for completed days remain frozen, rather than being silently revised by a delayed checkpoint.
- Healthy scheduling wakes at Kyiv midnight and startup, not by querying every minute. Database failures use bounded 1–5-minute retries; long catch-up queues yield after 31 days per batch.
- Member/day results retain the day's eligible milliseconds, points, and settled balance. These are live reputation records that deletion may remove. Stage 5 separately freezes published-history snapshots with no member foreign key, so published statistics survive erasure.

## Commands and transparency

### `/reputation [user]`

- Shows the settled reputation balance, not today's pending award.
- Defaults to the caller.
- Can show another member's balance when that member is selected.
- Replies publicly.

### `/voice-today [user]`

- Members can inspect their own tracked statistics or another member's statistics.
- Replies publicly.
- Shows today's verified eligible time, base voice-time points before bounds (excluding the still-undetermined daily bonus/penalty), and both last-settled streaks.
- Include the daily reset/rounding explanation where useful.
- Use a Discord user option to select another member rather than ambiguous free-text username lookup.

### `/reputation-off` and `/reputation-on`

- Members can pause and resume their own voice-reputation tracking using these commands.
- Tracking is **enabled by default**.
- Public `/voice-today` responses display **"Tracking paused"** when applicable.
- Implemented semantics:
  - `/reputation-off` records eligible time up to the pause, then stops accumulating it.
  - Pausing does not delete previously recorded time, pending awards, or settled reputation; earlier verified time still settles normally.
  - `/reputation-on` resumes from the command time if the member is already in an eligible channel, or from their next eligible join otherwise.
  - Paused periods are not credited retroactively.
  - Persist the preference across reconnects, restarts, and server leave/rejoin.
  - Commands affect only the caller and reply ephemerally; repeated calls are harmless and report the existing state.
- A paused member's earlier daily earnings remain eligible for settlement and reporting. Pausing is not deletion.

### `/reputation-delete`

- Deletes the invoking user's live reputation-feature data and requires explicit confirmation. Explicit exceptions: a minimal disabled-tracking user record, historical report snapshots/messages, and existing backups remain.
- Treat this as a self-service command, not permission to delete another user's data.
- Scope is reputation-feature records, not unrelated nickname-voting, archive, or other bot data.
- Confirmation is an ephemeral warning with Delete/Cancel buttons, restricted to the caller, expiring after **60 seconds**. Cancellation or expiry makes no changes.
- Remove/reset the live balance, participation/streak counters, old pause history, pending earnings, voice records, and member-level daily reward data, while keeping the minimum user identity and `is_tracking = false`. Do not remove frozen historical report snapshots.
- Tracking remains disabled until the caller explicitly uses `/reputation-on`. The user proposed `is_tracking` on the user table; this is suitable. Prisma may expose it as `isTracking` while mapping the database column to `is_tracking`.
- Do not update already published historical reports or their saved pagination data. Historical daily points, balance snapshots, and aggregates remain unchanged.
- Do not include deleted live data in future reports, including reports not yet published. Stage 4 removes all live member/day rows used as pending report entries. The stage-5 publisher uses those live rows when freezing unpublished reports, and a separate frozen snapshot for published history; it never reconstructs erased entries from old accounting summaries.
- Do not clear or rewrite existing backups in response to deletion. Routine backup retention is a separate policy. Restoring an old backup can restore deleted data or an outdated tracking preference; define and disclose restore handling rather than promising automatic deletion replay.
- Stage 4 coordinates deletion with the tracker's serial queue and the same server-row database lock used by settlement. Erasure, the zero balance, and the disabled flag commit together; failure rolls everything back. Stale checkpoints are clipped to the monotonic `tracking_since` cutoff after re-enrollment, and day ledgers remain to prevent duplicate payouts.
- The retained record contains the server/user IDs, zero balance, disabled flag, eligibility cutoff, and reset bookkeeping timestamps, not the member's previous activity history.
- The confirmation must explain the retained identity/disabled flag, historical reports, and backups; do not describe this as erasing every copy of the user's data.
- After deletion, `/reputation-on` resumes from **zero reputation and zero accumulated time**, with no retroactive credit.

### `/reputation-rules`

- Publishes the earning and settlement rules on demand.
- Replies **ephemerally**, visible only to the invoking member.
- There is no requirement to post or pin a public rules message.

## Daily embed report

- Post to a main text channel that will be explicitly configured; do not guess the destination.
- Describe the **previous Kyiv calendar day**, clearly stating its date.
- New reports include every member with an actual nonzero automatic daily change or a successful applied vote reward/penalty, with **15 members per page**. Include members whose gains and losses cancel to zero net; omit members with no actual changes. Already-frozen legacy reports keep their original positive-earner snapshots and 10-person pagination.
- Use **shared pagination**: a public embed with Previous/Next buttons. Members can navigate; the bot updates the visible page for everyone. Navigating cannot modify stored statistics.
- Display page numbers and disable navigation where there is no previous/next page. Single-page reports need no navigation controls.
- Historical pagination remains available after restarts, using saved daily results rather than temporary in-memory sessions.
- When no reputation changes occurred, new reports say **"Змін репутації за день немає."**. This is not used when offsetting changes produce a zero net total. Legacy empty reports retain their original activity/no-earner labels.
- Distinguish genuinely absent activity from missing observations during bot downtime.
- A day with incomplete tracking must include a clear coverage warning; do not imply the bot observed zero activity for the entire day.
- Delayed reports should retain the original day and be identifiable as delayed.
- No-op capped/cancelled/failed votes and zero-value automatic awards alone do not qualify a member. Attendance/absence eligibility, outage exemptions and balance bounds are unchanged; reports never apply money.
- Each entry shows eligible voice time, the signed net daily change, and the frozen settlement balance. Separate lines identify actual time/attendance earnings, missed-day deductions, vote rewards and vote penalties; vote amounts are actual capped amounts and counts mean successful polls, not voters. Reasons and voter identities are not duplicated. When verified solo duration is positive, add `Наодинці: …` on a separate line. This is actual unweighted solo time already included in the eligible total, not additional time or points. Omit the line for known zero or uncaptured historical detail.
- Order by net daily change descending, then eligible voice time descending, then user ID for a stable final tie-breaker.
- Snapshot total balances and each entry's actual solo milliseconds so historical report values remain stable after restarts, member erasure, and raw-interval retention. New snapshots copy `soloMs` from the settled daily award; old snapshots remain NULL/unknown and are not reconstructed or repriced.
- Vote changes belong to the half-open Kyiv-day boundary recorded for the settlement (`Europe/Kyiv`, including DST), using the poll's financial application/closure timestamp `closed_at`, not its proposal, deadline or Discord delivery date. Count only succeeded polls with a positive actual applied amount.
- A current daily award is required for inclusion; retained public vote history cannot recreate erased private daily results. Polls created before the member identity's erasure/reset cutoff are excluded after re-enrollment. Personally paused participants remain eligible for vote reporting.
- The balance remains the daily settlement checkpoint snapshot, not a live balance or a newly reconstructed midnight balance. With delayed accounting it may already include later-day actions; the day's change breakdown still uses the defined logical day/closure boundaries.
- If no usable report channel is configured, continue tracking and settlement, queue reports, and publish them once a valid destination is configured. Log delivery failures without interrupting accounting.

### Complete-change report cutover

Migration `20261111150000_all_daily_changes` was **applied to the hosted database with explicit approval and confirmation that the bot was stopped**. All sixteen migrations are applied and the schema diff is clean. Before/after streaming checksums and table OIDs verified unchanged existing values across all sixteen application tables; legacy page sizes/formats and unknown breakdowns were preserved, and new defaults, validated constraints/index and migration checksum/history verified. It stores nullable legacy/known new breakdown components (quarter units) and poll counts, supports signed report totals/entries, adds a financial-closure lookup index, and persists page size/format version. Existing frozen reports retain page size 10, format 1 and unknown breakdowns without repricing history; pending reports upgrade atomically when prepared, and new reports use page size 15/format 2. Other installations require explicit approval and stopped-bot confirmation before applying the migration. Upload the full matching build before restarting; bot deployment/start has not been performed for this extension. No command re-registration is needed solely for this feature.

### Solo-time report cutover

Migration `20261111140000_report_solo_time` adds nullable `solo_ms` to frozen report entries with a 0…eligible-time constraint. It leaves all existing snapshots unknown (NULL), even if daily data still exists, preserving published history. It does not change accounting, balances, points, ranking, report eligibility or 10-person pagination. The migration was **applied to the hosted database with explicit approval and confirmation that the bot was stopped**. All fifteen migrations are applied and the schema diff is clean. Before/after streaming checksums and table OIDs verified unchanged existing values across all sixteen application tables; old report entries retained NULL solo detail, and the new column, validated constraint and migration checksum/history were verified. Upload the complete matching build before restarting; bot deployment/start has not been performed for this extension. No command re-registration is needed solely for this change.

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
- Stage 5 aggregates tracking, settlement, and delivery issues in one warning message. An initial alert and final recovery edit are immediate; ongoing edits are at most hourly, with no repeated pings. IDs and last-edit metadata persist; warm-process cached state can still deliver alerts while the database is down. Cold-start database failure or inaccessible channels fall back to safe logging and bounded retry.

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
- Do not assume the database Free plan provides daily backups. The user created a **Prisma Object Store bucket** and successfully ran manual encrypted backup/verification workflows. Credentials remain private; pricing and allowances still require owner review.
- Prisma Object Store is S3-compatible and can hold uploaded database exports. Creating a bucket does not schedule or produce database backups.
- Implemented workflow: an explicitly invoked job obtains a consistent direct-connection PostgreSQL 17 public-schema dump, encrypts it locally, uploads a uniquely named object, and verifies a read-back. Scheduling and irreversible retention cleanup remain separately disabled until the owner configures/approves them.
- The user supplied bucket credentials privately in local `.env` and GitHub secrets; successful manual workflows exercised connectivity without displaying secret values. Local `.env` does not automatically supply credentials to a hosted bot or an external backup scheduler.
- Stage 6 provides `.github/workflows/database-backup.yml` with manual check/backup/verify modes and an opt-in daily 02:17 UTC schedule (after Kyiv settlement). It uses PostgreSQL 17 in Docker and AWS CLI v2. The owner configured repository secrets separately; local `.env` is not copied automatically. Never commit `.env`, credential-bearing URLs, plaintext dumps, or encryption keys.
- GitHub scheduled jobs can be delayed or dropped, and schedules in public repositories are disabled after 60 days without repository activity. Monitor the last successful backup and retain a manual-run option; the schedule is not a guaranteed backup SLA.
- Backups are encrypted before upload with a separate 32-byte AES-256-GCM key. The key must be stored privately outside Prisma and supplied separately as a GitHub secret. Downloaded ciphertext is SHA-256 checked, authenticated/decrypted, and checked with `pg_restore --list`; that is not a complete restore test.
- Retention defaults to disabled. If explicitly enabled, the proposed default keeps the latest 7 managed archives in a dedicated prefix; manual runs count, so this is not a seven-calendar-day policy. Cleanup only runs after a verified replacement and refuses unexpected ordering. User-data deletion never clears backups.
- A bucket-scoped `read_write` key can upload and delete objects; keep it secret. Prisma Object Store has no versioning or soft delete, so deleting an object is irreversible through its API. Do not rely on automatic lifecycle cleanup without verifying support.
- A bucket in the same Prisma account is outside KataBump but not independent of Prisma/account-wide failures or compromise. An occasional separate downloaded copy remains recommended.
- Bucket pricing and plan limits were not published in the storage documentation checked during planning; do not assume database Free-plan allowances cover bucket storage.
- A backup must be a consistent database export with schema and reputation data, not merely a copy of the bot source or `.env`. Credentials must not appear in logs or public artifacts.

## Out of scope / superseded ideas

- Historical voice-time backfill from Discord.
- Listening to or recording audio, or measuring actual speaking time.
- Requiring multiple participants to earn points.
- Daily point caps or additional anti-farming rules.
- Carrying sub-quarter point remainders into the next day.
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

1. Stage 5 resolves navigation and missing-message behavior: serialize edits per message, retain restart-safe snapshots, never automatically recreate published/deleted history. A missing in-flight message becomes terminal `missing`.
2. Stage 5 uses one positive-earner embed with 10 rows/page, time/points/frozen balance, coverage warnings, and original-day labels. Operational issues share one reusable warning embed.
3. Channel changes affect pending/unfrozen reports and future/current warnings, not historical published messages or already-frozen in-flight deliveries.
4. Should any administrative balance adjustments or corrections be allowed? None are currently specified.
5. Verify provider metering and finalize a backup/export policy. Stage 1 selects Prisma 7.10.1 with the PostgreSQL adapter and explicit versioned migration deployment.
6. Raw interval retention is now 14 days after settlement; daily graph summaries have no automatic age expiry. Monitor cleanup retries/backlogs and PostgreSQL space reuse. Explicit member erasure remains effective for personal daily history.
7. Decide how Discord warnings are handled if the configured channel is inaccessible. Stage 2 implements conservative checkpoint/reconnect reconciliation and bounded retries.
8. Stage 5 resolves erasure/publication races: live rows are read while freezing under the server lock; erasure of an affected member is temporarily rejected while Discord publication is unconfirmed. After marker reconciliation, historical snapshots remain and live erasure can proceed. If access to the original channel is lost, restore access so reconciliation can finish.
9. Complete GitHub Actions setup: encryption-key custody, six repository secrets, live encrypted backup/verification, full disposable restore, failure notifications, and explicit opt-in scheduling. Manual check/backup/verify and the approved disposable restore have passed; failure notifications and scheduling remain pending, and retention deletion remains separately opt-in.
10. Specify backup restore handling so an old backup does not silently undo a user's deletion or opt-out. Existing backups are not rewritten on deletion.
