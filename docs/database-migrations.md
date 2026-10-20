# Database migrations

How to safely apply database schema changes in production, including blue-green
deployment patterns, rollback procedures by migration type, zero-downtime
constraints, and testing against production-like data.

## Quick reference

| Type | Risk | Runbook | Rollback | Compatibility |
|---|---|---|---|---|
| Additive (new column/table/index) | Low | [Additive migrations](#additive-migrations) | [Rollback: additive](#rollback-additive) | Backward compatible |
| Destructive (drop column/table) | High | [Destructive migrations](#destructive-migrations) | [Restore from backup](#recovery-paths) | Requires two-phase deploy |
| Rename (via expand/contract) | Medium | [Renaming columns](#renaming-columns) | [Contract phase rollback](#rollback-expand-contract) | Backward compatible during window |
| Data backfill | Medium | [Data migrations](#data-migrations) | [Idempotent restart](#rollback-data-migration) | Transparent to app |

## Safety gates

Run `npm run migration:safety` before `prisma migrate deploy`. CI runs the
same gate on every commit to main and applies the complete migration history
to a clean PostgreSQL database to check for schema drift. The gate rejects
timestamp/order collisions, duplicate SQL checksums, and unsafe SQL patterns.

The historical `20260824000000` duplicate is grandfathered because renaming an
already-applied Prisma migration would break production ledgers; no new duplicate
timestamp is allowed. The existing `20260825100000_store_payment_memo_context`
conversion is likewise grandfathered because editing its applied SQL changes
its Prisma checksum.

## Production migration procedure

Apply migrations as a pre-deploy job separate from application replicas. This
prevents replicas from racing each other and ensures a failed migration stops
the rollout instead of creating a crash loop.

### Procedure: numbered steps

1. **Prepare backup**
   - Run a full database backup using your orchestrator's backup tooling
   - Verify the backup can be restored (test restore is performed by
     [`docs/disaster-recovery.md`](disaster-recovery.md))
   - Note the backup ID and timestamp for the recovery section

2. **Generate migration artifact**
   - Build the Docker image with the new schema and migrations included
   - Tag it with the commit SHA and release version
   - Verify the image contains `prisma/migrations/` with the new migration

3. **Pre-flight checks** (run these before the actual migration, not during)
   - Verify the target database is reachable and healthy: `psql -c "SELECT version();"`
   - Check free disk space: `psql -c "SELECT pg_database_size(current_database());"`
   - Ensure no long-running queries: `psql -c "SELECT * FROM pg_stat_activity WHERE state != 'idle' AND query NOT LIKE '%pg_stat%';"`
   - If queries are running, wait for them to finish or kill idle transactions

4. **Run migration as a pre-deploy job**
   ```bash
   docker run --rm \
     -e DATABASE_URL="$DATABASE_URL" \
     -e NODE_ENV=production \
     $IMAGE_REGISTRY/earnproof-api:$COMMIT_SHA \
     npm run prisma:migrate:deploy
   ```
   - Capture exit code and log output
   - Log includes: how many migrations ran, how long each took, any warnings

5. **Verify schema**
   - Connect to the database: `psql $DATABASE_URL`
   - Verify the schema matches expectations:
     ```sql
     SELECT migration FROM "_prisma_migrations" ORDER BY finished_at DESC LIMIT 5;
     ```
   - Check no errors in the migration log: `SELECT * FROM "_prisma_migrations" WHERE success = false;`
   - If errors exist, see [Recovery paths](#recovery-paths)

6. **Deploy replicas**
   - Replicas will connect to the migrated schema on startup
   - The Prisma client was generated at build time and matches the new schema
   - Monitor startup logs for connection errors or schema mismatches
   - After replicas are healthy, traffic is routed back

7. **Post-deploy verification**
   - Run a few queries that were critical to the migration:
     ```bash
     curl https://api.example.com/api/v1/health
     ```
   - Monitor error rates and latency in the first 5 minutes
   - Watch database slow-query logs for unexpected sequential scans

### Failure scenarios during migration

| Symptom | Likely cause | Action |
|---|---|---|
| Migration job exits with code 1, message: `Inconsistent migration history` | Reapplied a migration with different SQL than what was recorded | See [Migration already applied](#migration-already-applied) |
| Migration job hangs for >10 minutes | Long-held lock from a concurrent query or another migration job | [Kill idle transactions](#kill-idle-transactions), rerun |
| Migration applies but replicas fail to start with `schema mismatch` | Prisma client generated from old schema | Rebuild image and redeploy job |
| Data integrity errors after deploy (unique constraint violations, foreign key violations) | Backfill was incomplete or violated a constraint | See [Data migration failure](#data-migration-failure) |

## Blue-green deployment and schema compatibility

In blue-green deployment, both the old and new application versions run
simultaneously against the same database during the transition. Schema changes
must be compatible with both versions, or the deployment must coordinate them.

### Expand/contract pattern

The expand/contract pattern makes schema changes transparent across both app
versions:

1. **Expand phase** (deployed as Release N)
   - Add new columns, tables, or indexes as nullable/optional
   - Old app version ignores the new schema additions
   - New app version writes both old and new fields (e.g., `oldField` and `newField`)
   - Index creation on large tables uses `CONCURRENTLY` to avoid table locks
   - Backfill from old to new column is deferred to a background job, idempotent and restartable

2. **Soak period**
   - Both versions run against the schema for hours/days (depends on rollback window)
   - Validates that writes to both fields work correctly
   - Allows rollback to old version if bugs are discovered

3. **Contract phase** (deployed as Release N+1)
   - New app version stops writing old field, reads only new field
   - Add NOT NULL constraint if all rows are backfilled
   - Drop the old column in Release N+2 after rollback window closes
   - Old app version can no longer be deployed (would violate schema)

### Example: adding a required column

Schema change: add `idempotencyKey` column to `idempotency_records` table.

**Release N - Expand**
```sql
ALTER TABLE "idempotency_records" ADD COLUMN "idempotencyKey" VARCHAR(255);
CREATE UNIQUE INDEX ON "idempotency_records"("organizationId", "idempotencyKey");
```
- Prisma schema updated to include the new field as optional
- Application writes both `idempotencyKey` (new) and `requestFingerprint` (old)
- Old app version ignores the new column

**Release N+1 - Contract**
```sql
ALTER TABLE "idempotency_records" ALTER COLUMN "idempotencyKey" SET NOT NULL;
```
- Application stops writing `requestFingerprint`, reads only `idempotencyKey`
- All rows now have `idempotencyKey` filled
- Old app version cannot be deployed (would crash trying to write `requestFingerprint`)

**Release N+2 - Cleanup**
```sql
DROP INDEX "idempotency_records_requestFingerprint_idx";
ALTER TABLE "idempotency_records" DROP COLUMN "requestFingerprint";
```
- Only after rollback window closes (typically 24-48 hours after N+1)
- Safe to drop: new version doesn't reference it, and enough time has passed to catch bugs

### Example: adding an index for query performance

Schema change: add composite index on `Payment(userId, occurredAt)`.

**Release N - Index creation**
```sql
-- Non-transactional index creation, does not lock the table
CREATE INDEX CONCURRENTLY "Payment_userId_occurredAt_idx" 
ON "Payment"("userId", "occurredAt");
```
- Runs without an exclusive lock; queries continue normally
- Takes longer than `CREATE INDEX`, but allows traffic during the operation
- Must be in its own migration file (Prisma limitation)

**Release N+1 - Query optimizer learns the index**
- New queries automatically use the new index
- Old queries still work against the old index
- No schema downtime

## Additive migrations

Additive migrations add new schema elements (columns, tables, indexes) without
removing or modifying existing ones. They are the lowest-risk migration type and
are fully backward compatible.

### Pattern: additive column

Add a nullable column for new application feature, without requiring existing
rows to have a value.

**Migration SQL** (`prisma/migrations/YYYYMMDDHHMMSS_add_column/migration.sql`)
```sql
ALTER TABLE "users" ADD COLUMN "preferredLanguage" VARCHAR(10);
CREATE INDEX "users_preferredLanguage_idx" ON "users"("preferredLanguage");
```

**Rollback**
```sql
DROP INDEX "users_preferredLanguage_idx";
ALTER TABLE "users" DROP COLUMN "preferredLanguage";
```

**Application compatibility**
- Old version: ignores the column
- New version: reads/writes the column
- Downtime: 0 seconds

**Example from codebase**
- [`20260825160000_add_issuer_public_metadata`](../prisma/migrations/20260825160000_add_issuer_public_metadata/migration.sql)
  adds nullable `publicMetadata`, `contractSyncState`, and related columns to `Issuer`
  table for storing Stellar contract sync state

### Pattern: new table

Create a new table for a new feature without affecting existing tables.

**Migration SQL** (from [`20260923205527_add_idempotency_records`](../prisma/migrations/20260923205527_add_idempotency_records/migration.sql))
```sql
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "idempotencyKey" VARCHAR(255) NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'PENDING',
    "responseBody" JSONB,
    "responseStatusCode" INTEGER,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "idempotency_records_organizationId_idempotencyKey_key" 
ON "idempotency_records"("organizationId", "idempotencyKey");

CREATE INDEX "idempotency_records_organizationId_expiresAt_idx" 
ON "idempotency_records"("organizationId", "expiresAt");

ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_organizationId_fkey" 
FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

**Rollback**
```sql
DROP TABLE IF EXISTS "idempotency_records";
DROP TYPE IF EXISTS "IdempotencyStatus";
```

**Application compatibility**
- Old version: no code references the table
- New version: writes idempotency records for deduplication
- Downtime: 0 seconds

### Pattern: index on existing table

Create an index to improve query performance without changing the data.

**Migration SQL** (from [`20260825150000_add_proof_history_index`](../prisma/migrations/20260825150000_add_proof_history_index/migration.sql))
```sql
-- Concurrent index creation for large tables (does not lock)
CREATE INDEX CONCURRENTLY "Proof_userId_createdAt_id_idx"
ON "Proof"("userId", "createdAt", "id");
```

**Rollback**
```sql
DROP INDEX IF EXISTS "Proof_userId_createdAt_id_idx";
```

**Application compatibility**
- Old version: queries still execute (just slower, without the index)
- New version: queries automatically use the new index
- Downtime: 0 seconds
- Note: use `CREATE INDEX CONCURRENTLY` for large tables; include in its own migration

## Destructive migrations

Destructive migrations drop or alter columns/tables in ways that break old app
versions. They require a two-phase deploy strategy and careful rollback planning.

### Strategy: two-phase deploy

**Release N: Deprecate** (Expand phase from blue-green pattern)
- Remove the code that reads/writes the deprecated column
- Leave the schema unchanged
- Application is compatible with both old and new versions

**Release N+1: Drop** (Contract phase)
- Old app version can no longer be deployed (would crash)
- Run the destructive migration
- Drop the column

Never run the destructive migration (Release N+1) without a preceding
deprecation release (Release N). This ensures:
1. A rollback to the old version is possible if Release N+1 is broken
2. Both versions have proven they work against the new schema

### Pattern: drop a column

**Release N: Deprecate**
- Remove code that references the column
- Leave column in schema (migration: none)
- Deploy and soak

**Release N+1: Drop** (Destructive migration SQL)
```sql
ALTER TABLE "users" DROP COLUMN "legacyField";
```

**Rollback within N+1 contract window**
- Database has no `legacyField` column
- Deploy Release N (old code) — it will crash when trying to read the column
- Option 1: Restore database from backup taken before the drop
- Option 2: Hotfix Release N to skip reading the column, deploy it
- Option 3: Keep Release N+1 deployed and treat the column drop as not rolling back

**Rollback after contract window closes (beyond Release N+2)**
- The column was removed hours or days ago
- Restore from backup, or accept the column is gone

### Pattern: drop a table

**Release N: Deprecate**
- Stop all code that queries the table
- Leave table in schema (migration: none)
- Deploy and soak (typically 24+ hours)

**Release N+1: Drop** (Destructive migration SQL)
```sql
DROP TABLE "legacy_events";
```

**Rollback**
- Same as drop column: restore from backup or hotfix the app

## Data migrations

Data migrations backfill columns, transform data, or run cleanup. They are
transparent to the app but carry risks if incomplete or if they violate
constraints that have been added.

### Pattern: backfill a new column

**Scenario**: Added a nullable column `status` to `users`, but want to backfill
it with a computed default for existing rows.

**Expand migration** (adds the column)
```sql
ALTER TABLE "users" ADD COLUMN "status" VARCHAR(50) DEFAULT 'PENDING';
```

**Data migration job** (runs during soak period)
```typescript
// Run as a background job or in application startup
async function backfillUserStatus() {
  const batchSize = 1000;
  let processedTotal = 0;
  
  while (true) {
    // Selection from remaining eligible rows (restartable)
    const batch = await prisma.user.findMany({
      where: { status: 'PENDING' },
      select: { id: true },
      take: batchSize,
    });
    
    if (batch.length === 0) break;
    
    // Compute and update
    const updates = await Promise.all(
      batch.map(user => 
        prisma.user.update({
          where: { id: user.id },
          data: { status: computeStatus(user) },
        })
      )
    );
    
    processedTotal += updates.length;
    logger.info(`Backfilled ${processedTotal} users`, { batch: batch.length });
  }
  
  logger.info('Backfill complete', { total: processedTotal });
}
```

**Backfill requirements**
- **Restartable**: selects from remaining eligible rows, so interruption and restart
  find where it left off
- **Bounded**: fixed batch size and total run cap (e.g., 100 batches max)
- **Observable**: only counts and batch numbers are logged, never source records
- **Chunked**: for tables with millions of rows, process in batches to avoid
  long-held locks

### Pattern: idempotent transformation

Transform data that may have already been transformed (restart-safe).

```typescript
async function migratePaymentClassification() {
  const batchSize = 500;
  
  for (let i = 0; i < 100; i++) { // 100 batches max
    const payments = await prisma.payment.findMany({
      where: {
        classification: 'UNKNOWN', // Restartable: only unprocessed rows
      },
      take: batchSize,
    });
    
    if (payments.length === 0) {
      logger.info('Migration complete: no more UNKNOWN payments');
      return;
    }
    
    // Transform is deterministic: same input always produces same output
    const updates = payments.map(p => ({
      where: { id: p.id },
      data: { classification: classifyPayment(p) },
    }));
    
    await Promise.all(updates.map(u => prisma.payment.update(u)));
    logger.info(`Batch ${i + 1}: transformed ${updates.length} payments`);
  }
}
```

### Pattern: detect partial failure

After a data migration, verify it completed successfully.

```typescript
async function verifyBackfill() {
  const incompleteCount = await prisma.user.count({
    where: { status: 'PENDING' },
  });
  
  const totalCount = await prisma.user.count();
  
  if (incompleteCount > 0) {
    throw new Error(
      `Backfill incomplete: ${incompleteCount} of ${totalCount} users still PENDING`
    );
  }
  
  logger.info('Verification passed', { total: totalCount });
}
```

### Rollback: data migration

If a data migration fails partway through:

1. Check what was completed:
   ```sql
   SELECT COUNT(*) as count FROM "users" WHERE "status" != 'PENDING';
   ```

2. If restartable and correct, re-run the migration job (it picks up where it left off)

3. If the logic was wrong, fix the code and re-run

4. If the migration cannot be trusted:
   - Restore the column to its pre-migration state:
     ```sql
     UPDATE "users" SET "status" = 'PENDING' WHERE "status" != 'PENDING';
     ```
   - Roll back the release and fix the migration logic

## Renaming columns

Renaming a column appears to be a destructive migration but can be done safely
during a blue-green deployment using the expand/contract pattern.

### Pattern: rename a column via expand/contract

**Release N: Expand** (add new column, keep old)
- Add new column with the desired name: `newField`
- Deploy dual-write code that writes both `oldField` and `newField`
- Run backfill job to populate `newField` from `oldField`
- Soak for hours/days

```sql
ALTER TABLE "users" ADD COLUMN "newField" TEXT;
```

**Release N+1: Contract** (switch to new column)
- Code reads from `newField`, writes only `newField`
- Stop writing `oldField`
- Add NOT NULL constraint if appropriate
- Soak

```sql
ALTER TABLE "users" ALTER COLUMN "newField" SET NOT NULL;
```

**Release N+2: Cleanup** (drop old column)
- After rollback window closes (24-48 hours)
- Drop `oldField`

```sql
ALTER TABLE "users" DROP COLUMN "oldField";
```

**Rollback within Release N+1**
- Both columns still exist
- Either old code (reading `oldField`) or new code (reading `newField`) works
- Deploy whichever version needs to run

## Zero-downtime deployment

Large tables and heavily used queries can acquire locks that block traffic.
Prevent this by:

1. **Concurrent index creation** (required for indexes on large tables)
   ```sql
   CREATE INDEX CONCURRENTLY "Payment_sourceAddress_idx" ON "Payment"("sourceAddress");
   ```
   - Does not acquire an exclusive lock
   - Allows reads/writes during index creation
   - Must be in its own migration file

2. **Avoid ALTER TABLE on large tables during traffic**
   - If possible, do it during a maintenance window
   - If during traffic, use `NOT VALID` constraints and check them later:
     ```sql
     ALTER TABLE "large_table" ADD CONSTRAINT check_something CHECK (col > 0) NOT VALID;
     ALTER TABLE "large_table" VALIDATE CONSTRAINT check_something; -- Later, during maintenance
     ```

3. **Monitor lock wait times**
   - Before migrating: `SELECT * FROM pg_stat_activity WHERE wait_event IS NOT NULL;`
   - During migration: watch for blocking locks
   - After migration: verify no long-held locks

## Migration review checklist

Before deploying a migration to production, have a second maintainer review:

- [ ] **Additive or destructive?** If destructive, is there a one-release deprecation preceding it?
- [ ] **Indexes:** do new indexes use `CONCURRENTLY`? Are they on the right columns?
- [ ] **Constraints:** are new constraints `NOT NULL` or unique? Can existing data violate them?
- [ ] **Backfill:** if new columns are backfilled, is the backfill idempotent, bounded, and observable?
- [ ] **Data integrity:** will the migration violate any existing constraints? Tested against production-scale data?
- [ ] **Rollback plan:** what is the concrete rollback if this migration breaks? Restore from backup, or forward fix?
- [ ] **Deployment order:** will the new app code handle the old schema, or does this migration need to run first?
- [ ] **Estimated lock time:** how long will the migration hold exclusive locks? Is it acceptable during traffic?
- [ ] **Blue-green compatibility:** if using blue-green deploy, does the migration follow expand/contract?

## Testing migrations against production-like data

Before deploying a migration to production, test it against a database with
production-like row counts and data distribution. Options:

### Option 1: Staging replica (recommended if available)

1. Restore a point-in-time snapshot from production to a staging database
2. Run the migration against the staging database
3. Verify:
   - Migration completes in acceptable time (< max_acceptable_seconds)
   - Queries still use the expected indexes: `EXPLAIN (ANALYZE) SELECT ...`
   - Row counts match expectations after backfill
4. Record: migration time, final row counts, any warnings

### Option 2: Prisma shadow database (for development)

1. Set `DATABASE_URL` and `SHADOW_DATABASE_URL` in `.env`
   ```bash
   DATABASE_URL="postgresql://user:password@staging:5432/earnproof_test"
   SHADOW_DATABASE_URL="postgresql://user:password@staging:5432/earnproof_test_shadow"
   ```

2. Run migration against shadow database:
   ```bash
   npx prisma migrate deploy --preview-feature
   ```

3. Prisma creates and destroys the shadow database automatically, applying
   every migration to verify correctness

### Option 3: Synthetic data generation (for new features)

1. Generate synthetic data at scale:
   ```bash
   npm run test:performance
   ```
   This creates a test database with tens of thousands of rows, skewed by
   tenant distribution (few heavy users, many light users), matching
   production shape.

2. Test the migration:
   ```bash
   TEST_DATABASE_URL=postgresql://... npm run test:performance
   ```

3. Verify indexes and lock times against this dataset

### Testing checklist

- [ ] Migration runs successfully against production-scale data
- [ ] Execution time is acceptable (no hour-long locks)
- [ ] Row counts match expectations after backfill
- [ ] Indexes are used correctly (verify with `EXPLAIN ANALYZE`)
- [ ] No unexpected constraint violations

## Recovery paths

See [`docs/runbooks/failed-migration.md`](runbooks/failed-migration.md) for
detailed incident response steps. Summary:

| Failure | Recovery |
|---|---|
| Migration applied but app fails to start | Restore from pre-migration backup, hotfix the migration, redeploy |
| Migration already applied (Prisma knows it ran) | Use `prisma migrate resolve` |
| Partial application (some migrations ran, others failed) | Check `_prisma_migrations` table, use `prisma migrate resolve --applied` or `--rolled-back` |
| Constraint violation after backfill | Restore backup and fix the backfill logic |

## Related documentation

- [`deployment.md`](deployment.md) — how migrations fit into the deployment pipeline
- [`disaster-recovery.md`](disaster-recovery.md) — backup/restore procedures
- [`runbooks/failed-migration.md`](runbooks/failed-migration.md) — incident response for migration failures
- [Prisma migrate deploy](https://www.prisma.io/docs/cli/migrate/deploy) — apply pending migrations in production
- [Prisma migrate resolve](https://docs.prisma.io/docs/cli/migrate/resolve) — fix migration history issues
- [Prisma Migrate understanding](https://www.prisma.io/docs/orm/prisma-migrate/understanding-prisma-migrate) — concepts and patterns


## Recent migrations: Issue #331

### Migration: Create SecretRetrievalReceipt table

**File**: `20261015000000_add_secret_retrieval_receipts`

**Type**: Additive (zero-downtime expansion)

**Summary**: Adds `SecretRetrievalReceipt` table to persist immutable evidence of one-time secret revelation (API keys, webhook signing secrets, export download tokens) without storing the secret values themselves.

**Schema changes**:
- New table `SecretRetrievalReceipt` with columns:
  - `id` (primary key, cuid)
  - `organizationId` (foreign key to `Organization`, with cascade delete)
  - `secretType` (string: `api_key`, `webhook`, `export`)
  - `resourceId` (ID of resource: API key ID, webhook ID, export job ID)
  - `resourceReference` (nullable string for user-friendly reference: prefix, URL, category)
  - `recipientId` (nullable string: who received the secret)
  - `deliveryChannel` (string, default `http_response`: `http_response`, `download_url`, `email`)
  - `revealedAt` (timestamp: when secret was revealed)
  - `acknowledgementHash` (string: SHA-256 hash proving revelation)
  - `status` (string, default `ACTIVE`: `ACTIVE`, `EXPIRED`, `REVOKED`)
  - `expiresAt` (nullable timestamp: when receipt expires)
  - `metadata` (JSONB, default `{}`: optional context)
  - `hash`, `hashVersion`, `prevHash` (audit chain fields for cryptographic integrity)
  - `createdAt`, `updatedAt` (timestamps)

**Indexes**:
  - Unique: `(organizationId, resourceId, secretType, revealedAt)` — prevents duplicate receipts
  - Composite: `(organizationId, secretType, resourceId)` — org + secret type queries
  - Composite: `(organizationId, status, expiresAt)` — expiry cleanup queries
  - Composite: `(organizationId, createdAt)` — timeline queries

**Backward compatibility**: None needed; this is a new table. Existing code paths are unaffected.

**Rollback**: Drop the table and remove the Prisma model from schema (one-line rollback):
```sql
DROP TABLE IF EXISTS "SecretRetrievalReceipt" CASCADE;
```

**Data retention policy**: Receipts follow the organization's retention policy (default 2 years). No PII is stored in receipts; only non-sensitive resource identifiers and metadata.

**Testing notes**:
- Receipt creation is atomic with secret creation (same transaction).
- Acknowledgement hash is deterministic and cannot be reversed to recover the secret.
- Unique constraint prevents accidental duplicate receipts from concurrent requests.
- Receipts are immutable after creation (no updates except status and metadata on consumption).
