# Encrypted database backups — GitHub Actions walkthrough

## Current status and safety defaults

The workflow and scripts are implemented. **No real database export, bucket upload, GitHub secret configuration, scheduled run, or production restore has been performed by the agent.** Tests use synthetic archives and a fake storage/tool adapter, plus real AES-GCM encryption/authentication. Live Prisma bucket compatibility and a full PostgreSQL restore still need your approved manual test.

- Backups run outside KataBump, independently of the bot.
- Scheduled jobs are **disabled** until the GitHub variable `BACKUPS_SCHEDULE_ENABLED` is `true`.
- Deletion of old backups is **disabled** until `BACKUP_PRUNE_ENABLED` is `true`.
- Creating the Prisma bucket does not create backups automatically.
- Object Store pricing/limits were not published in the Prisma docs checked during planning. Check your Console before enabling unattended uploads; database Free-plan storage is not an Object Store allowance.

## What the job does

1. Runs PostgreSQL **17** `pg_dump` from the official `postgres:17` Docker image. It exports the app's **public schema**, including data, sequences, types, and `_prisma_migrations`, in custom archive format. It does not back up provider settings, database roles, or other schemas.
2. Checks the archive catalog with `pg_restore --list`.
3. Encrypts it locally with **AES-256-GCM**, a random IV, and your separate 32-byte key. Only ciphertext is uploaded.
4. Uploads a unique object using `If-None-Match: *` (no overwriting an existing key).
5. Downloads that object, compares its SHA-256, authenticates/decrypts it, and checks the archive catalog again.
6. Only after successful remote verification, optionally removes older managed objects if you explicitly enabled retention cleanup.
7. Removes temporary files. No plaintext dump or encryption key is uploaded as a GitHub artifact or committed to Git.

The catalog check is **not a full restoration test**. Complete the disposable-database test below before relying on these backups.

## 1. Generate and keep an encryption key privately

Run this **on your own trusted machine**, not in public Actions logs:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Save the resulting value in a password manager outside your Prisma account. Do not paste it into chat, issues, source files, or screenshots. Losing the key makes the encrypted backups unusable. Bucket credentials alone cannot decrypt them.

Keep old encryption keys if you rotate them: existing backups still require their original key. The script never stores a key inside the bucket. Encryption protects contents, not against deletion, replay of an older genuine backup, or compromise of the account running the workflow.

## 2. Add repository secrets

After the workflow is committed and pushed to `main`, open your repository:

**Settings → Secrets and variables → Actions → Secrets → New repository secret**

Add these six secrets:

| Secret | Value |
| --- | --- |
| `BACKUP_DATABASE_URL` | Direct `postgres://` or `postgresql://` connection string from Prisma Postgres; not an Accelerate/API URL |
| `S3_ENDPOINT` | Exact HTTPS endpoint returned with the bucket key |
| `S3_BUCKET` | Provider-assigned `bucketName`/`providerName`, **not the Console display name** |
| `S3_ACCESS_KEY_ID` | Bucket access key ID |
| `S3_SECRET_ACCESS_KEY` | Bucket key secret |
| `BACKUP_ENCRYPTION_KEY` | Base64 key generated in step 1 |

Your local `.env` values are **not automatically available to GitHub Actions**. Copy them privately into the GitHub fields yourself. The workflow never needs your Discord bot token.

Use a dedicated private backup bucket and a bucket-scoped `read_write` key. Prisma does not provide per-prefix permissions: that key can modify/delete any object in its bucket. A dedicated read-only database login is preferable if you have configured one with access to all app tables/sequences; this implementation does not create database roles or change permissions for you.

Repository writers can change workflows and access secrets through their code. Restrict write access, protect `main`, and run only reviewed code from `main`. For stronger controls, arrange a protected Actions environment before enabling unattended exports. GitHub-hosted runners are trusted with plaintext during export/verification; client-side encryption does not remove that trust requirement.

## 3. Configure repository variables

In the same Actions settings, choose **Variables → New repository variable**.

| Variable | Initial value |
| --- | --- |
| `BACKUPS_SCHEDULE_ENABLED` | `false` (or leave unset) |
| `BACKUP_PRUNE_ENABLED` | `false` (or leave unset) |
| `BACKUP_KEEP_COUNT` | `7` |
| `BACKUP_PREFIX` | `votebot/postgres/` |
| `S3_REGION` | The signing region required by your endpoint; script default is `us-east-1` |

Prisma's storage documentation does not publish an exact AWS CLI region recipe. Use the endpoint/key bundle's guidance and override `S3_REGION` if required (for example `auto`). Do not infer the signing region solely from the bucket's physical location. The script uses path-style addressing and optional-only checksum calculation for S3 compatibility; the first live test must verify your endpoint accepts this configuration.

Choose a dedicated prefix before the first upload. Cleanup only considers files matching this script's timestamp/UUID naming pattern inside that prefix. It does not delete unrelated objects, but the access key itself is not restricted to the prefix.

## 4. Run the safe configuration check

Open **Actions → Encrypted database backup → Run workflow**:

1. Choose branch **main**.
2. Select mode **check**.
3. Leave `object_key` empty.
4. Run and inspect the result.

A successful check validates configuration formats only. It makes **no database or bucket requests**, does not pull a PostgreSQL image, and does not prove credentials/connectivity work.

## 5. Explicitly run the first backup

When you approve exporting your database to this bucket:

1. Run the same workflow from **main** with mode **backup**.
2. Keep scheduling and cleanup disabled.
3. Confirm the job reports that an encrypted upload was downloaded and verified.
4. Check the bucket's private object list for a new file under the chosen prefix.

The workflow needs no `npm install`, Prisma CLI, or bot build. It uses Node 24, Docker/PostgreSQL 17, and AWS CLI v2 on the hosted Ubuntu runner. Action versions are pinned by commit SHA; PostgreSQL is pinned to major 17 and receives upstream minor-image updates.

Object names have this form:

```text
votebot/postgres/backup-YYYYMMDDTHHMMSSmmmZ-UUID.pgdump.enc
```

No credentials, raw CLI diagnostics, plaintext catalog output, or object contents are printed. A failure identifies only the safe operation stage. Check the troubleshooting section rather than turning on shell tracing or dumping environment variables.

## 6. Verify an existing object independently

Obtain its **object key**, not a URL or presigned download link, from the bucket object list or a trusted S3 client. Run mode **verify**, setting `object_key` to the full key under your configured prefix.

This reads/decrypts the object into a private temporary directory and runs `pg_restore --list`. It does **not** connect to a database or restore anything. Use the matching encryption key and prefix for older backups.

## 7. Test a real restore into a disposable database

Before turning on schedules, create a completely separate **empty test PostgreSQL database**. Do not use the production database or the bot's live `DATABASE_URL` as the restore target.

1. Download an encrypted backup privately. Do not share its presigned URL.
2. On a trusted machine, set `BACKUP_ENCRYPTION_KEY` to the matching key. Install PostgreSQL 17+ client tools.
3. Create a private local `backups/` directory (ignored by Git), then decrypt:

   ```bash
   npm run backup:decrypt -- backups/downloaded.pgdump.enc backups/restored.dump
   pg_restore --list backups/restored.dump
   ```

4. **Review the test host/database before continuing.** Set `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, and appropriate TLS settings securely to that disposable target. Do not put passwords in command arguments or public logs.
5. After target review, a native-client restore uses an all-or-nothing transaction. Bash example:

   ```bash
   pg_restore --single-transaction --exit-on-error --no-owner --no-privileges --dbname="$PGDATABASE" backups/restored.dump
   ```

   PowerShell uses `"--dbname=$env:PGDATABASE"` instead. The target connection must be independently configured; this is **not** the source database URL. We will review the exact target and commands together before any agent-executed restore.

6. Check schema/table counts, representative balances and `is_tracking` preferences, day ledgers, frozen report entries, and `_prisma_migrations`. Do not post user rows publicly.
7. If a managed test database reports existing-schema/ownership conflicts, stop and review the archive/target. Do not blindly add `--clean`, drop schemas, or bypass errors.
8. Remove local plaintext after testing and retire the disposable test database when you no longer need it.

Backups are logically removed from temporary storage; this is not a claim of secure physical erasure on disks. Protect the restore machine and its disk encryption.

### Production recovery is a separate supervised procedure

Disable background tracking, stop the bot, preserve the current database separately, and review the restore point and target before any production restore. Restoring older backups can revive deleted user data or an old tracking preference, lose later points, and conflict with Discord messages published after the backup. Existing backups are intentionally **not rewritten on user deletion**. Review/reapply known erasures and opt-outs privately, apply any newer migrations, and reconcile report delivery before re-enabling the bot. No automatic production restore or deletion replay is implemented.

## 8. Enable daily scheduling only after verification

Set the repository variable `BACKUPS_SCHEDULE_ENABLED` to **true** when you are satisfied with the live backup and restore test.

Schedule: **02:17 UTC daily** (04:17 Kyiv in winter, 05:17 in summer), after the midnight settlement. GitHub schedules can be delayed/dropped and public-repository schedules can be disabled after 60 days without repository activity. They are not an exact-time or guaranteed backup SLA.

Enable GitHub Actions failure notifications in your personal notification settings. Periodically inspect the last successful run and the bucket. No Discord token is stored in this workflow, and it does not send backup alerts through the bot. Check your GitHub Actions allowance and Prisma storage/operation limits; no zero-cost guarantee is implied.

## 9. Optional retention — separate approval

Cleanup remains off by default. If you choose to keep only the latest seven managed archives, set:

```text
BACKUP_PRUNE_ENABLED=true
BACKUP_KEEP_COUNT=7
```

This counts **archives**, not calendar days; manual backups count too. Choose a higher count if you run many manual exports. Cleanup happens only after a new upload passes read-back, decryption/authentication, and catalog verification. It refuses unexpected timestamp ordering, never intentionally deletes the new verified archive, and ignores other prefixes/names.

Object Store has **no versioning or soft delete**. Deletions are irreversible, and a partial storage error may leave only some old objects removed. Confirm namespace/retention before enabling it. This routine cleanup is separate from user-data deletion; `/reputation-delete` never touches backups.

Keep an occasional encrypted copy outside the Prisma account, plus a separately secured encryption key. The bucket is outside KataBump, but not independent of a Prisma/account-wide incident.

## Local commands and prerequisites

```bash
npm run backup:check   # Offline validation only
npm run backup        # REAL export + encrypted upload + read-back verification
npm run backup:verify # REAL object download/authentication; BACKUP_VERIFY_KEY required
```

Scripts use only Node built-ins, not bot/runtime npm dependencies. Local execution loads the root `.env` without replacing existing process environment variables. Native mode needs `pg_dump` **17**, `pg_restore` 17+, and a current AWS CLI v2 in PATH. Export is restricted to major 17 so all archives remain readable by the workflow's version-17 tool. `BACKUP_USE_DOCKER=true` instead uses the official PostgreSQL 17 image, but still needs Docker and AWS CLI. No services are installed or started automatically on KataBump.

A dump is a consistent PostgreSQL snapshot and does not stop ordinary bot writes. Schema changes may cause a safe lock-timeout failure; retention will not run. Large databases can exceed runner disk/time limits. Monitor actual usage rather than treating one backup as one database operation.

## Troubleshooting without leaking credentials

- **Configuration:** fill all six secrets; use a 32-byte canonical base64 encryption key, an HTTPS S3 endpoint, safe prefix, direct PostgreSQL URL, and literal `true`/`false` flags.
- **Export:** check Docker/PG client availability, database connectivity, password/read permissions, TLS, and version compatibility. Prisma currently documents PostgreSQL 17. Source URLs with custom certificate/service/host overrides need a separately reviewed setup.
- **Upload:** check endpoint, provider-assigned bucket name, signing region, `read_write` key, CLI version, and provider limits. Do not weaken TLS or enable public access to troubleshoot.
- **Remote/stored verification:** check read access, object key/prefix, matching encryption key, and archive integrity. Authentication failure must not be ignored.
- **Retention:** inspect namespace, count, timestamps/clock, and storage deletion permissions. The newly verified object is retained even if cleanup later fails; older objects cannot be undeleted by this tool.

Do not use `set -x`, `printenv`, echo a connection string, print decrypted SQL, or attach `.env`/dumps to issues. Configuration secrets remain private even when repository workflow logs are public.

Sources: [Prisma storage](https://www.prisma.io/docs/storage), [bucket limitations](https://www.prisma.io/docs/storage/behavior), [manual Postgres backups](https://www.prisma.io/docs/postgres/database/backups), [GitHub schedules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule), [GitHub secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions).
