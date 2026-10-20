# Failed migration response

Numbered incident-response steps when a database migration fails during
deployment or while running against live traffic.

## Severity classification

| Severity | Scenario | Response window |
|---|---|---|
| **S1** | Migration failed, app startup is blocked, no fallback deployment is available | Immediate (seconds) |
| **S1** | Successful migration but app rejects the schema (code/schema version mismatch) | Immediate (seconds) |
| **S2** | Migration hung (not completed after max expected time) | 5 minutes |
| **S2** | Migration applied but some rows violated constraints (partial failure, integrity error) | 15 minutes |
| **S3** | Pre-deployment test showed migration would be unsafe (caught before production) | Next business day |

Escalate to S1 if: any part of the system cannot start, or data integrity is
affected. Escalate from S2 to S1 if remediation takes more than 15 minutes or
requires production data restoration.

## Detection

### How you'll notice a migration failed

1. **CI signal: migration job exits non-zero**
   - Pre-deploy job in CI/CD pipeline logs:
     ```
     docker run ... npm run prisma:migrate:deploy
     EXIT CODE: 1
     ```
   - Check the job logs for the error message (see [Triage](#triage) below)

2. **Application startup failure**
   - Containers crash with exit code 1 or log:
     ```
     Error: P3018: Prisma Migrate could not find the migration file at ...
     Error: Unknown database error
     ```
   - Readiness probe fails (health checks fail)
   - Traffic is not routed to these replicas

3. **Health check probe fails**
   - `/api/v1/health` returns 503 Service Unavailable
   - `/api/v1/health/ready` returns 503 (dependency unhealthy)
   - Orchestrator stops routing traffic

4. **Partial schema inconsistency**
   - Some migrations applied, others failed
   - New app code expects columns that don't exist
   - Queries fail with "column does not exist" errors

### Validate this is a migration failure, not something else

```bash
# 1. Can you reach the database?
psql $DATABASE_URL -c "SELECT version();"

# 2. Check Prisma's migration ledger
psql $DATABASE_URL -c "SELECT migration, finished_at, success FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 5;"

# 3. Look for errors in the ledger
psql $DATABASE_URL -c "SELECT * FROM _prisma_migrations WHERE success = false;"

# 4. Check if the database is locked
psql $DATABASE_URL -c "SELECT * FROM pg_stat_activity WHERE wait_event IS NOT NULL;"
```

If any of these commands fail, see the orchestrator's logs for connection errors.
If the migration ledger shows `success = false` or a hung status, proceed to [Triage](#triage).

## Triage

### Step 1: Identify the failure mode

Read the exit log from the pre-deploy job:

```bash
# In GitHub Actions:
# Go to the failed workflow run → pre-deploy migration job → view raw logs

# In other CI/CD:
# Dig into your orchestrator's build/deploy job output
```

Match the error message to one of these:

| Error | Meaning | Next step |
|---|---|---|
| `P3022: Migration failed, error in migration step: ...` | The SQL in the migration has a syntax error or constraint violation | [SQL syntax or constraint error](#sql-syntax-or-constraint-error) |
| `P3005: Inconsistent migration history` | The migration file was re-run but the SQL changed, or a migration was applied out of order | [Inconsistent migration history](#inconsistent-migration-history) |
| `P3008: Migration reverted` | A migration was rolled back without proper cleanup | [Migration already rolled back](#migration-already-rolled-back) |
| Timeout after 30+ minutes | The migration is hanging, likely on a lock | [Migration hung on lock](#migration-hung-on-lock) |
| `Connection refused` | Cannot reach the database | [Database unreachable](#database-unreachable) |
| `P3018: Prisma Migrate could not find migration file` | Migration file was deleted or renamed | [Missing migration file](#missing-migration-file) |

### Step 2: Check migration history

Connect to the database and list the ledger:

```bash
psql $DATABASE_URL << 'EOF'
SELECT 
  migration,
  started_at,
  finished_at,
  success,
  execution_time_secs,
  EXTRACT(EPOCH FROM (finished_at - started_at)) as duration_seconds
FROM "_prisma_migrations"
ORDER BY started_at DESC
LIMIT 10;
EOF
```

Look for:
- **Last successful migration**: when did the last one that succeeded complete?
- **Failed migration**: which migration has `success = false`?
- **Stuck migration**: is there a migration with `finished_at = NULL`?

### Step 3: Examine the database state

For the failed migration, check what was actually applied:

```bash
# If the migration created a table, does it exist?
psql $DATABASE_URL -c "SELECT * FROM information_schema.tables WHERE table_name = 'new_table';"

# If it added a column, does it exist?
psql $DATABASE_URL -c "SELECT column_name FROM information_schema.columns WHERE table_name='existing_table' AND column_name='new_column';"

# Any rows in the table, or empty?
psql $DATABASE_URL -c "SELECT COUNT(*) FROM new_table;"

# Any constraint violations?
psql $DATABASE_URL -c "SELECT * FROM pg_constraint WHERE conname LIKE '%constraint_name%';"
```

This tells you: was the migration partially applied, or did it roll back cleanly?

## Recovery paths

### SQL syntax or constraint error

**Symptom**: `P3022: Migration failed, error in migration step: syntax error at or near ...`

**Recovery**:

1. Stop the deployment immediately (do not deploy the broken image)

2. Identify the bad SQL:
   ```bash
   # The error message includes the migration name, e.g. "20260923_add_column"
   cat prisma/migrations/20260923_add_column/migration.sql
   ```

3. Check what was partially applied:
   ```bash
   psql $DATABASE_URL -c "SELECT * FROM _prisma_migrations WHERE migration LIKE '20260923%';"
   ```

4. If Prisma rolled it back automatically, the database is clean. Go to step 6.

   If the migration is listed with `success = false` or partial application:

5. **Restore from backup** (safest option):
   ```bash
   # Use your backup tooling
   # See docs/disaster-recovery.md for restore procedures
   ```

6. **Fix the migration SQL**:
   - Edit `prisma/migrations/YYYYMMDD_name/migration.sql`
   - Fix the syntax or constraint issue
   - Validate against a test database (see [Testing migrations](#testing-migrations-against-staging))

7. **Increment the migration timestamp** (if you edited the file):
   - Prisma records the migration timestamp in its ledger
   - If you changed the SQL, create a new migration with a new timestamp:
     ```bash
     npx prisma migrate create --name fix_previous_migration
     # Now edit the new migration file with the corrected SQL
     ```
   - Do NOT re-use the old timestamp (Prisma will reject it as a checksum mismatch)

8. **Re-deploy**: rebuild the image, run the pre-deploy migration job again

9. **Verify**:
   ```bash
   psql $DATABASE_URL -c "SELECT * FROM _prisma_migrations WHERE migration LIKE '20260923%';"
   ```

### Inconsistent migration history

**Symptom**: `P3005: Inconsistent migration history. The following migrations have been applied to the database but not found in the migrations folder: <list>`

**Meaning**: The migration was already applied in the database, but the migration file has been edited or deleted since.

**Recovery**:

1. Check what's in the database:
   ```bash
   psql $DATABASE_URL -c "SELECT migration FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 5;"
   ```

2. Check what's in the code:
   ```bash
   ls -la prisma/migrations/
   ```

3. Find the mismatch — there's a migration in the ledger that's not on disk.

4. **If the migration should have been deleted** (code cleanup):
   - The migration did run; Prisma just lost the file
   - Tell Prisma to forget it: `prisma migrate resolve --applied <migration_name>`
   - Example:
     ```bash
     prisma migrate resolve --applied 20260825_old_migration
     ```

5. **If the migration should still exist** (file was accidentally deleted or not committed):
   - Restore the migration file from version control
   - Verify the checksum matches what Prisma expects
   - Rerun the migration: `npm run prisma:migrate:deploy`

6. **If the migration file was edited after being applied** (dangerous):
   - Do NOT change it — Prisma checksums the SQL
   - Create a new migration with a new timestamp that applies the intended changes
   - Use `prisma migrate resolve --rolled-back <old_migration>` only if you are certain the
     old migration was never actually applied (rare)

### Inconsistent migration history (duplicate timestamp)

**Symptom**: `P3020: Migration already exists`

**Meaning**: Two migrations have the same timestamp.

**Recovery**:

1. Check for duplicates:
   ```bash
   ls -la prisma/migrations/ | grep '20260923' | sort
   ```

2. Rename one of them:
   ```bash
   mv prisma/migrations/20260923000000_add_column \
      prisma/migrations/20260923000100_add_column_2
   ```

3. Update `migration.lock` to reflect the new name (or let Prisma regenerate it)

4. Rerun the migration: `npm run prisma:migrate:deploy`

### Migration already applied

**Symptom**: `P3018: Prisma Migrate could not find the migration file` or Prisma says the migration already succeeded

**Recovery**:

1. Verify the migration actually succeeded:
   ```bash
   psql $DATABASE_URL -c "SELECT migration, success FROM _prisma_migrations WHERE migration = '20260923_add_column';"
   ```

2. If `success = true`, the migration is applied. To redeploy:
   - Prisma will skip it (it's already in the ledger)
   - If you need to re-run it, use `prisma migrate resolve`:
     ```bash
     prisma migrate resolve --rolled-back 20260923_add_column
     prisma migrate deploy
     ```
     This marks it as not-run, then reruns it (risky if idempotent).

3. If you want to apply a new version:
   - Create a new migration with a new timestamp
   - Do NOT re-use the old timestamp

### Migration hung on lock

**Symptom**: Migration job runs for > 10 minutes without progress, or logs show it waiting for a lock

**Recovery**:

1. Identify what's holding the lock:
   ```bash
   psql $DATABASE_URL << 'EOF'
   SELECT 
     pid,
     usename,
     application_name,
     state,
     query,
     wait_event
   FROM pg_stat_activity
   WHERE wait_event IS NOT NULL
   ORDER BY query_start;
   EOF
   ```

2. If the lock is held by an old query or idle transaction:
   ```bash
   # Kill the blocking connection
   psql $DATABASE_URL -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid != pg_backend_pid() AND wait_event IS NOT NULL;"
   ```

3. Check if the migration continues or is still stuck:
   - If it resumes within 30 seconds, let it complete
   - If still stuck after 30 seconds, kill the migration job

4. Once the migration job is killed:
   - Check if Prisma rolled back the changes or left them partial:
     ```bash
     psql $DATABASE_URL -c "SELECT * FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 1;"
     ```
   - If partial, see [Partial application](#partial-application)

5. **Prevent this in the future**:
   - Reduce the duration of the migration (e.g., use `CREATE INDEX CONCURRENTLY` for large tables)
   - Or run migrations during a maintenance window when no queries are active

### Database unreachable

**Symptom**: `Connection refused` or `timeout connecting to database`

**Recovery**:

1. Check network connectivity:
   ```bash
   ping $DB_HOST
   psql $DATABASE_URL -c "SELECT 1;"
   ```

2. Check database status:
   - SSH to the database server or use your orchestrator's logs
   - Is PostgreSQL running? `systemctl status postgresql` or equivalent
   - Are there connection errors in the database logs?

3. Check credentials:
   - Verify `DATABASE_URL` is correct (check without logging the password)
   - Verify the user has login permissions
   - Verify no firewall rule is blocking the connection

4. Once connectivity is restored:
   - Rerun the migration job: `npm run prisma:migrate:deploy`

### Missing migration file

**Symptom**: `P3018: Prisma Migrate could not find the migration file at <path>`

**Recovery**:

1. Verify the file exists:
   ```bash
   ls -la prisma/migrations/20260923_migration_name/migration.sql
   ```

2. If missing:
   - Check version control history:
     ```bash
     git log --oneline -- prisma/migrations/20260923_migration_name/
     ```
   - Restore the file: `git checkout HEAD^ -- prisma/migrations/20260923_migration_name/`

3. If the file exists but Prisma can't find it:
   - Check file permissions: `chmod 644 prisma/migrations/*/migration.sql`
   - Rebuild the image and retry

4. Rerun: `npm run prisma:migrate:deploy`

### Partial application

**Symptom**: Some migrations succeeded, others failed. The migration ledger shows mixed results.

**Recovery**:

1. Identify which migrations succeeded and which failed:
   ```bash
   psql $DATABASE_URL -c "SELECT migration, success FROM _prisma_migrations ORDER BY started_at;"
   ```

2. If the failures are early in the list:
   - Restore from a pre-migration backup
   - Fix the failed migration
   - Redeploy

3. If the failures are at the end:
   - Successful migrations before the failure are fine
   - For the failed migration, use `prisma migrate resolve`:
     ```bash
     prisma migrate resolve --rolled-back 20260923_failed_migration
     ```
   - Fix the migration and retry: `npm run prisma:migrate:deploy`

4. Verify the schema matches the code:
   ```bash
   npx prisma db pull  # Update schema.prisma from database
   # Check if schema.prisma changed — if so, there's a mismatch
   git diff prisma/schema.prisma
   ```

## Escalation criteria

Stop and escalate to on-call or incident commander if:

- Data integrity is affected (constraint violations, rows deleted unexpectedly)
- Multiple different migrations failed in sequence
- Root cause cannot be determined within 15 minutes
- Recovery requires restoring from backup and the RTO is > 30 minutes
- The production database is completely unreachable or corrupted

**Do NOT escalate** if:
- Pre-deployment test caught the failure (fix and retry)
- The failure is clear (bad SQL, missing file) and the fix is straightforward
- The database is healthy and only the app needs restarting

## Post-incident actions

After the migration is recovered and the system is healthy:

1. **Document the failure**:
   - What went wrong: e.g., "SQL syntax error in migration 20260923"
   - What was the impact: e.g., "5-minute deployment delay, no traffic loss"
   - How was it detected: e.g., "pre-deploy job failed"
   - How was it resolved: e.g., "fixed SQL and redeployed"

2. **Update the migration review checklist** (see [`docs/database-migrations.md`](../database-migrations.md)):
   - If this failure was predictable, add it to the checklist
   - Example: "verify no long-running queries before running ALTER TABLE on large tables"

3. **Improve tooling or testing** (if the same failure could recur):
   - Example: "add pre-migration lock check to catch hung queries earlier"
   - Example: "test migrations against staging replica before production deploy"

4. **Review the deployment procedure**:
   - Did the pre-deploy job catch this early enough?
   - Could a faster rollback have reduced impact?
   - Should this migration type have been split into smaller chunks?

## Testing migrations against staging

Before deploying to production, test against a production-like database:

**Option 1: Staging replica** (if available)
```bash
# 1. Restore a point-in-time snapshot from production
# 2. Run the migration against the staging database
docker run --rm \
  -e DATABASE_URL="postgresql://user:password@staging:5432/earnproof_staging" \
  $IMAGE_REGISTRY/earnproof-api:$COMMIT_SHA \
  npm run prisma:migrate:deploy

# 3. Verify schema and row counts
psql postgresql://user:password@staging:5432/earnproof_staging \
  -c "SELECT migration FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 1;"

# 4. Note: migration time, final row counts, any warnings
```

**Option 2: Shadow database** (for development)
```bash
# Set in .env
DATABASE_URL="postgresql://user:password@dev:5432/earnproof_dev"
SHADOW_DATABASE_URL="postgresql://user:password@dev:5432/earnproof_dev_shadow"

# Prisma creates, migrates, and destroys the shadow database automatically
npx prisma migrate dev
```

**Option 3: Local testing with production-scale data**
```bash
# Run the performance test suite to create a production-scale dataset
npm run test:performance
# This creates earnproof_test_perf with ~250k rows, skewed tenant distribution
```

See [`docs/database-migrations.md`](../database-migrations.md#testing-migrations-against-production-like-data)
for detailed testing guidance.

## Related

- [`docs/database-migrations.md`](../database-migrations.md) — safe migration procedures and patterns
- [`docs/disaster-recovery.md`](../disaster-recovery.md) — backup and restore
- [`docs/deployment.md`](../deployment.md) — deployment pipeline overview
- [Prisma migrate reference](https://www.prisma.io/docs/orm/reference/prisma-cli-reference#migrate-deploy)
- [Prisma migrate resolve](https://www.prisma.io/docs/orm/reference/prisma-cli-reference#migrate-resolve)
