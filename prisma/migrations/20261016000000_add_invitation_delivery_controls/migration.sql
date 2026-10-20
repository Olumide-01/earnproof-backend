-- CreateEnum for InvitationDeliveryOutcome
CREATE TYPE "InvitationDeliveryOutcome" AS ENUM ('SENT', 'BOUNCED', 'COMPLAINT', 'SUPPRESSED', 'RATE_LIMITED', 'FAILED');

-- CreateEnum for InvitationOverrideReason
CREATE TYPE "InvitationOverrideReason" AS ENUM ('COMPLIANCE_REVIEW', 'CUSTOMER_REQUEST', 'FRAUD_INVESTIGATION', 'TECHNICAL_RECOVERY', 'POLICY_EXCEPTION');

-- CreateTable InvitationDeliverySuppression
-- Hashed email suppression entries to prevent delivery to bounced/complained addresses.
-- Stores salted SHA-256 hashes to prevent enumeration while enabling deduplication.
-- Tenant-scoped: one organization cannot see another's suppression list.
CREATE TABLE "InvitationDeliverySuppression" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "recipientEmailHash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceOutcome" "InvitationDeliveryOutcome",
    "suppressedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "note" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvitationDeliverySuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable InvitationDeliveryOutcomeRecord
-- Per-tenant invitation delivery outcome tracking.
-- Records delivery attempts and their outcomes for audit and abuse detection.
CREATE TABLE "InvitationDeliveryOutcomeRecord" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "recipientEmailHash" TEXT NOT NULL,
    "outcome" "InvitationDeliveryOutcome" NOT NULL,
    "statusCode" INTEGER,
    "failureReason" VARCHAR(200),
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvitationDeliveryOutcomeRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable InvitationResendCooldown
-- Per-recipient resend cooldown to prevent delivery storms.
-- Resets when cooldown period expires or when an override is applied.
CREATE TABLE "InvitationResendCooldown" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "recipientEmailHash" TEXT NOT NULL,
    "lastSentAt" TIMESTAMP(3) NOT NULL,
    "availableAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvitationResendCooldown_pkey" PRIMARY KEY ("id")
);

-- CreateTable InvitationResendAttemptWindow
-- Per-recipient, per-hour resend attempts counter for rate limiting.
-- Resets on hourly boundary. Used to enforce per-recipient limits.
CREATE TABLE "InvitationResendAttemptWindow" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "recipientEmailHash" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvitationResendAttemptWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable InvitationDeliveryQuota
-- Per-tenant invitation delivery quota tracking (e.g., invitations per day).
-- Fixed-window counter; resets daily.
CREATE TABLE "InvitationDeliveryQuota" (
    "organizationId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "limit" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvitationDeliveryQuota_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable InvitationDeliveryOverride
-- Authorized override of suppression or rate limits.
-- Requires recent authorization (recent signed assertion). Single-use.
-- Reviewed and audited; only ADMIN+ can create.
CREATE TABLE "InvitationDeliveryOverride" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "recipientEmailHash" TEXT NOT NULL,
    "overrideType" TEXT NOT NULL,
    "reason" "InvitationOverrideReason" NOT NULL,
    "authorizedById" TEXT NOT NULL,
    "authorizedAt" TIMESTAMP(3) NOT NULL,
    "assertionTokenHash" TEXT NOT NULL,
    "description" VARCHAR(1000),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvitationDeliveryOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable InvitationDeliveryAuditEvent
-- Audit trail for invitation delivery control changes.
-- Links to Organization AuditLog via chainKey for tamper detection.
CREATE TABLE "InvitationDeliveryAuditEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "recipientEmailHash" TEXT,
    "actorId" TEXT NOT NULL,
    "overrideReason" TEXT,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvitationDeliveryAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateUniqueIndex for InvitationDeliverySuppression per organization + email
CREATE UNIQUE INDEX "InvitationDeliverySuppression_organizationId_recipientEmailHash_key" ON "InvitationDeliverySuppression"("organizationId", "recipientEmailHash");

-- CreateIndex for InvitationDeliverySuppression expiration cleanup
CREATE INDEX "InvitationDeliverySuppression_organizationId_expiresAt_idx" ON "InvitationDeliverySuppression"("organizationId", "expiresAt");

-- CreateIndex for InvitationDeliverySuppression timeline
CREATE INDEX "InvitationDeliverySuppression_suppressedAt_idx" ON "InvitationDeliverySuppression"("suppressedAt");

-- CreateIndex for InvitationDeliveryOutcomeRecord organization and recipient queries
CREATE INDEX "InvitationDeliveryOutcomeRecord_organizationId_recipientEmailHash_createdAt_idx" ON "InvitationDeliveryOutcomeRecord"("organizationId", "recipientEmailHash", "createdAt");

-- CreateIndex for InvitationDeliveryOutcomeRecord organization and outcome queries
CREATE INDEX "InvitationDeliveryOutcomeRecord_organizationId_outcome_attemptedAt_idx" ON "InvitationDeliveryOutcomeRecord"("organizationId", "outcome", "attemptedAt");

-- CreateIndex for InvitationDeliveryOutcomeRecord expiration cleanup
CREATE INDEX "InvitationDeliveryOutcomeRecord_expiresAt_idx" ON "InvitationDeliveryOutcomeRecord"("expiresAt");

-- CreateUniqueIndex for InvitationResendCooldown per organization + email
CREATE UNIQUE INDEX "InvitationResendCooldown_organizationId_recipientEmailHash_key" ON "InvitationResendCooldown"("organizationId", "recipientEmailHash");

-- CreateIndex for InvitationResendCooldown availability queries
CREATE INDEX "InvitationResendCooldown_organizationId_availableAt_idx" ON "InvitationResendCooldown"("organizationId", "availableAt");

-- CreateUniqueIndex for InvitationResendAttemptWindow per organization + email + window
CREATE UNIQUE INDEX "InvitationResendAttemptWindow_organizationId_recipientEmailHash_windowStart_key" ON "InvitationResendAttemptWindow"("organizationId", "recipientEmailHash", "windowStart");

-- CreateIndex for InvitationResendAttemptWindow window cleanup
CREATE INDEX "InvitationResendAttemptWindow_organizationId_windowStart_idx" ON "InvitationResendAttemptWindow"("organizationId", "windowStart");

-- CreateIndex for InvitationDeliveryQuota window queries
CREATE INDEX "InvitationDeliveryQuota_organizationId_windowStart_idx" ON "InvitationDeliveryQuota"("organizationId", "windowStart");

-- CreateIndex for InvitationDeliveryOverride organization and recipient queries
CREATE INDEX "InvitationDeliveryOverride_organizationId_recipientEmailHash_idx" ON "InvitationDeliveryOverride"("organizationId", "recipientEmailHash");

-- CreateIndex for InvitationDeliveryOverride organization and override type queries
CREATE INDEX "InvitationDeliveryOverride_organizationId_overrideType_expiresAt_idx" ON "InvitationDeliveryOverride"("organizationId", "overrideType", "expiresAt");

-- CreateIndex for InvitationDeliveryOverride authorized actor timeline
CREATE INDEX "InvitationDeliveryOverride_authorizedById_createdAt_idx" ON "InvitationDeliveryOverride"("authorizedById", "createdAt");

-- CreateIndex for InvitationDeliveryOverride expiration cleanup
CREATE INDEX "InvitationDeliveryOverride_expiresAt_idx" ON "InvitationDeliveryOverride"("expiresAt");

-- CreateIndex for InvitationDeliveryAuditEvent organization and action queries
CREATE INDEX "InvitationDeliveryAuditEvent_organizationId_action_occurredAt_idx" ON "InvitationDeliveryAuditEvent"("organizationId", "action", "occurredAt");

-- CreateIndex for InvitationDeliveryAuditEvent actor timeline
CREATE INDEX "InvitationDeliveryAuditEvent_actorId_occurredAt_idx" ON "InvitationDeliveryAuditEvent"("actorId", "occurredAt");

-- AddForeignKey for InvitationDeliverySuppression to Organization
ALTER TABLE "InvitationDeliverySuppression" ADD CONSTRAINT "InvitationDeliverySuppression_organizationId_fkey" 
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey for InvitationDeliveryOutcomeRecord to Organization
ALTER TABLE "InvitationDeliveryOutcomeRecord" ADD CONSTRAINT "InvitationDeliveryOutcomeRecord_organizationId_fkey" 
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey for InvitationResendCooldown to Organization
ALTER TABLE "InvitationResendCooldown" ADD CONSTRAINT "InvitationResendCooldown_organizationId_fkey" 
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey for InvitationResendAttemptWindow to Organization
ALTER TABLE "InvitationResendAttemptWindow" ADD CONSTRAINT "InvitationResendAttemptWindow_organizationId_fkey" 
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey for InvitationDeliveryQuota to Organization
ALTER TABLE "InvitationDeliveryQuota" ADD CONSTRAINT "InvitationDeliveryQuota_organizationId_fkey" 
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey for InvitationDeliveryOverride to Organization
ALTER TABLE "InvitationDeliveryOverride" ADD CONSTRAINT "InvitationDeliveryOverride_organizationId_fkey" 
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey for InvitationDeliveryAuditEvent to Organization
ALTER TABLE "InvitationDeliveryAuditEvent" ADD CONSTRAINT "InvitationDeliveryAuditEvent_organizationId_fkey" 
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
