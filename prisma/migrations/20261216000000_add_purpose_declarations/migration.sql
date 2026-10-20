-- Add purpose declaration approval state enum
CREATE TYPE "PurposeDeclarationApprovalState" AS ENUM ('PENDING', 'APPROVED', 'REVOKED', 'EXPIRED');

-- Create PurposeDefinition table
CREATE TABLE "PurposeDefinition" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "purposeKey" VARCHAR(128) NOT NULL,
    "version" INTEGER NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "disclosureScope" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivatedAt" TIMESTAMP(3),

    CONSTRAINT "PurposeDefinition_pkey" PRIMARY KEY ("id")
);

-- Create PurposeDeclaration table
CREATE TABLE "PurposeDeclaration" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "purposeDefinitionId" TEXT NOT NULL,
    "verifierOrganizationId" TEXT NOT NULL,
    "approvalState" "PurposeDeclarationApprovalState" NOT NULL DEFAULT 'PENDING',
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurposeDeclaration_pkey" PRIMARY KEY ("id")
);

-- Create DeclarationAuditEntry table
CREATE TABLE "DeclarationAuditEntry" (
    "id" TEXT NOT NULL,
    "declarationId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "event" VARCHAR(32) NOT NULL,
    "actorUserId" TEXT,
    "previousState" "PurposeDeclarationApprovalState",
    "newState" "PurposeDeclarationApprovalState",
    "reason" VARCHAR(500),
    "requestFingerprint" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeclarationAuditEntry_pkey" PRIMARY KEY ("id")
);

-- Create VerificationPolicy table
CREATE TABLE "VerificationPolicy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "requiresPurposeDeclaration" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "config" JSONB,
    "status" "ResourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationPolicy_pkey" PRIMARY KEY ("id")
);

-- Add columns to VerificationEvent table for purpose declaration tracking
ALTER TABLE "VerificationEvent" ADD COLUMN "declarationId" TEXT;
ALTER TABLE "VerificationEvent" ADD COLUMN "declarationVersion" INTEGER;

-- Create indexes for PurposeDefinition
CREATE UNIQUE INDEX "PurposeDefinition_organizationId_purposeKey_version_key" ON "PurposeDefinition"("organizationId", "purposeKey", "version");
CREATE INDEX "PurposeDefinition_organizationId_createdAt_idx" ON "PurposeDefinition"("organizationId", "createdAt");

-- Create indexes for PurposeDeclaration
CREATE UNIQUE INDEX "PurposeDeclaration_organizationId_purposeDefinitionId_verifi_key" ON "PurposeDeclaration"("organizationId", "purposeDefinitionId", "verifierOrganizationId");
CREATE INDEX "PurposeDeclaration_organizationId_approvalState_idx" ON "PurposeDeclaration"("organizationId", "approvalState");
CREATE INDEX "PurposeDeclaration_organizationId_expiresAt_idx" ON "PurposeDeclaration"("organizationId", "expiresAt");
CREATE INDEX "PurposeDeclaration_organizationId_approvalState_expiresAt_idx" ON "PurposeDeclaration"("organizationId", "approvalState", "expiresAt");
CREATE INDEX "PurposeDeclaration_verifierOrganizationId_idx" ON "PurposeDeclaration"("verifierOrganizationId");

-- Create indexes for DeclarationAuditEntry
CREATE INDEX "DeclarationAuditEntry_declarationId_createdAt_idx" ON "DeclarationAuditEntry"("declarationId", "createdAt");
CREATE INDEX "DeclarationAuditEntry_organizationId_event_createdAt_idx" ON "DeclarationAuditEntry"("organizationId", "event", "createdAt");
CREATE INDEX "DeclarationAuditEntry_actorUserId_idx" ON "DeclarationAuditEntry"("actorUserId");

-- Create indexes for VerificationPolicy
CREATE UNIQUE INDEX "VerificationPolicy_organizationId_name_key" ON "VerificationPolicy"("organizationId", "name");
CREATE INDEX "VerificationPolicy_organizationId_status_idx" ON "VerificationPolicy"("organizationId", "status");

-- Create indexes for VerificationEvent additions
CREATE INDEX "VerificationEvent_declarationId_idx" ON "VerificationEvent"("declarationId");

-- Add foreign keys
ALTER TABLE "PurposeDefinition" ADD CONSTRAINT "PurposeDefinition_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurposeDeclaration" ADD CONSTRAINT "PurposeDeclaration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurposeDeclaration" ADD CONSTRAINT "PurposeDeclaration_purposeDefinitionId_fkey" FOREIGN KEY ("purposeDefinitionId") REFERENCES "PurposeDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurposeDeclaration" ADD CONSTRAINT "PurposeDeclaration_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PurposeDeclaration" ADD CONSTRAINT "PurposeDeclaration_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DeclarationAuditEntry" ADD CONSTRAINT "DeclarationAuditEntry_declarationId_fkey" FOREIGN KEY ("declarationId") REFERENCES "PurposeDeclaration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeclarationAuditEntry" ADD CONSTRAINT "DeclarationAuditEntry_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "VerificationPolicy" ADD CONSTRAINT "VerificationPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VerificationEvent" ADD CONSTRAINT "VerificationEvent_declarationId_fkey" FOREIGN KEY ("declarationId") REFERENCES "PurposeDeclaration"("id") ON DELETE SET NULL ON UPDATE CASCADE;
