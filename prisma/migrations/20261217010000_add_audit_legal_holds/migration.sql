-- Issue #311: audit retention legal holds.
-- Additive only. With no rows, retention cleanup behaves exactly as before.

-- CreateEnum
CREATE TYPE "AuditLegalHoldScope" AS ENUM ('ORGANIZATION', 'PLATFORM');

-- CreateEnum
CREATE TYPE "AuditLegalHoldAuthority" AS ENUM ('COURT_ORDER', 'REGULATOR_REQUEST', 'LITIGATION_COUNSEL', 'INTERNAL_INVESTIGATION');

-- CreateEnum
CREATE TYPE "AuditLegalHoldStatus" AS ENUM ('PENDING_APPROVAL', 'ACTIVE', 'RELEASE_PENDING', 'RELEASED', 'REJECTED');

-- CreateTable
-- No free-text column exists: the reason is stored only as a SHA-256 commitment.
CREATE TABLE "AuditLegalHold" (
    "id" TEXT NOT NULL,
    "scope" "AuditLegalHoldScope" NOT NULL,
    "organizationId" TEXT,
    "authority" "AuditLegalHoldAuthority" NOT NULL,
    "reasonCommitment" CHAR(64) NOT NULL,
    "rangeStart" TIMESTAMP(3) NOT NULL,
    "rangeEnd" TIMESTAMP(3) NOT NULL,
    "status" "AuditLegalHoldStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "requestedById" TEXT NOT NULL,
    "approvalDeadline" TIMESTAMP(3) NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedById" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "releaseRequestedById" TEXT,
    "releaseRequestedAt" TIMESTAMP(3),
    "releasedById" TEXT,
    "releasedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuditLegalHold_pkey" PRIMARY KEY ("id"),
    -- Defence in depth for invariants the service enforces.
    CONSTRAINT "AuditLegalHold_scope_organization_check" CHECK (("scope" = 'ORGANIZATION') = ("organizationId" IS NOT NULL)),
    CONSTRAINT "AuditLegalHold_range_check" CHECK ("rangeStart" <= "rangeEnd"),
    CONSTRAINT "AuditLegalHold_reasonCommitment_check" CHECK ("reasonCommitment" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "AuditLegalHold_approver_check" CHECK ("approvedById" IS NULL OR "approvedById" <> "requestedById"),
    CONSTRAINT "AuditLegalHold_releaser_check" CHECK ("releasedById" IS NULL OR "releasedById" <> "releaseRequestedById")
);

-- CreateIndex
CREATE INDEX "AuditLegalHold_status_expiresAt_idx" ON "AuditLegalHold"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "AuditLegalHold_organizationId_status_idx" ON "AuditLegalHold"("organizationId", "status");

-- AddForeignKey
ALTER TABLE "AuditLegalHold" ADD CONSTRAINT "AuditLegalHold_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
