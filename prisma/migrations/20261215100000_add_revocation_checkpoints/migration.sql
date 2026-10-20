-- CreateEnum for RevocationCheckpointStatus
CREATE TYPE "RevocationCheckpointStatus" AS ENUM ('ACCEPTED', 'QUARANTINED');

-- CreateEnum for RevocationCheckpointQuarantineReason
CREATE TYPE "RevocationCheckpointQuarantineReason" AS ENUM (
  'LOWER_SEQUENCE',
  'SEQUENCE_CONFLICT',
  'STALE_OBSERVED_TIME',
  'MALFORMED_INPUT',
  'ALGORITHM_UNKNOWN',
  'WRONG_CONTRACT_ID',
  'WRONG_LEDGER',
  'REPLAY_DUPLICATE'
);

-- CreateTable RevocationCheckpoint
CREATE TABLE "RevocationCheckpoint" (
  "id" TEXT NOT NULL,
  "ledger" TEXT NOT NULL,
  "contractIdentity" TEXT NOT NULL,
  "algorithm" TEXT NOT NULL,
  "sequence" BIGINT NOT NULL,
  "root" TEXT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "status" "RevocationCheckpointStatus" NOT NULL DEFAULT 'ACCEPTED',
  "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "quarantineReason" "RevocationCheckpointQuarantineReason",
  "quarantineDetails" TEXT,
  "quarantinedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "RevocationCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex for idempotency
CREATE UNIQUE INDEX "checkpoint_idempotency" ON "RevocationCheckpoint"("ledger", "contractIdentity", "algorithm", "sequence", "root");

-- CreateIndex for stream head queries
CREATE INDEX "stream_head_query" ON "RevocationCheckpoint"("ledger", "contractIdentity", "algorithm", "status", "sequence");

-- CreateIndex for quarantine queries
CREATE INDEX "idx_RevocationCheckpoint_status_quarantine" ON "RevocationCheckpoint"("status", "quarantineReason");

-- CreateIndex for observedAt
CREATE INDEX "idx_RevocationCheckpoint_observedAt" ON "RevocationCheckpoint"("observedAt");

-- CreateTable RevocationCheckpointStreamHead
CREATE TABLE "RevocationCheckpointStreamHead" (
  "id" TEXT NOT NULL,
  "ledger" TEXT NOT NULL,
  "contractIdentity" TEXT NOT NULL,
  "algorithm" TEXT NOT NULL,
  "sequence" BIGINT NOT NULL,
  "root" TEXT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "RevocationCheckpointStreamHead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex for unique stream identity
CREATE UNIQUE INDEX "stream_unique" ON "RevocationCheckpointStreamHead"("ledger", "contractIdentity", "algorithm");

-- CreateIndex for stream head lookups
CREATE INDEX "idx_RevocationCheckpointStreamHead_stream" ON "RevocationCheckpointStreamHead"("ledger", "contractIdentity", "algorithm", "sequence");
