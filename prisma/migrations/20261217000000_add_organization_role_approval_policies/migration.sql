-- Issue #298: versioned organization role approval policies.
-- Additive only. Organizations without a row keep the platform default policy
-- (reported as version 0), so no backfill is required.

-- CreateEnum
CREATE TYPE "RoleApprovalPolicyStatus" AS ENUM ('ACTIVE', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "OrganizationRoleApprovalPolicy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "RoleApprovalPolicyStatus" NOT NULL DEFAULT 'ACTIVE',
    "protectedRoles" JSONB NOT NULL,
    "approverRoles" JSONB NOT NULL,
    "requiredApprovals" INTEGER NOT NULL,
    "approvalExpiryMinutes" INTEGER NOT NULL,
    "ownerChangesRequireOwnerApproval" BOOLEAN NOT NULL,
    "supersedesId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationRoleApprovalPolicy_pkey" PRIMARY KEY ("id"),
    -- Defence in depth for the platform minimums the service enforces.
    CONSTRAINT "OrganizationRoleApprovalPolicy_version_check" CHECK ("version" >= 1),
    CONSTRAINT "OrganizationRoleApprovalPolicy_requiredApprovals_check" CHECK ("requiredApprovals" BETWEEN 1 AND 5),
    CONSTRAINT "OrganizationRoleApprovalPolicy_approvalExpiryMinutes_check" CHECK ("approvalExpiryMinutes" BETWEEN 15 AND 10080)
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationRoleApprovalPolicy_supersedesId_key" ON "OrganizationRoleApprovalPolicy"("supersedesId");

-- CreateIndex
CREATE INDEX "OrganizationRoleApprovalPolicy_organizationId_status_idx" ON "OrganizationRoleApprovalPolicy"("organizationId", "status");

-- CreateIndex
-- Two concurrent updates from the same base version race on this index; the
-- loser fails and is reported as a stale update.
CREATE UNIQUE INDEX "OrganizationRoleApprovalPolicy_organizationId_version_key" ON "OrganizationRoleApprovalPolicy"("organizationId", "version");

-- AddForeignKey
ALTER TABLE "OrganizationRoleApprovalPolicy" ADD CONSTRAINT "OrganizationRoleApprovalPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
