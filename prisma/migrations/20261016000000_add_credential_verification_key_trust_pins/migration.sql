-- CreateEnum CredentialVerificationKeyTrustPinStatus
CREATE TYPE "CredentialVerificationKeyTrustPinStatus" AS ENUM ('ACTIVE', 'RETIRED', 'REVOKED');

-- CreateTable CredentialVerificationKeyTrustPin
-- Persistent trust pins for credential verification keys.
-- Pins explicitly authorize which issuer verification keys are trusted within a network.
-- Requirements:
-- - Private keys are never accepted; only public key material is pinned
-- - A pin is scoped to a single issuer and network; cannot cross issuers or networks
-- - Compromised pins fail closed: marked REVOKED immediately
-- - Trust decisions are immutable snapshots at pin time; live key state never mutates them
CREATE TABLE "CredentialVerificationKeyTrustPin" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "issuerId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "trustedKeySnapshot" JSONB NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "status" "CredentialVerificationKeyTrustPinStatus" NOT NULL DEFAULT 'ACTIVE',
    "decisionMetadata" JSONB,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "revocationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CredentialVerificationKeyTrustPin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: Composite unique constraint for active pins per issuer/network/key
CREATE UNIQUE INDEX "active_trust_pin_per_key" ON "CredentialVerificationKeyTrustPin"("organizationId", "issuerId", "network", "keyId", "status") WHERE "status" = 'ACTIVE';

-- CreateIndex: Organization and status lookup
CREATE INDEX "CredentialVerificationKeyTrustPin_organizationId_status_idx" ON "CredentialVerificationKeyTrustPin"("organizationId", "status");

-- CreateIndex: Issuer, network, and status lookup
CREATE INDEX "CredentialVerificationKeyTrustPin_issuerId_network_status_idx" ON "CredentialVerificationKeyTrustPin"("issuerId", "network", "status");

-- CreateIndex: Expiration and status lookup
CREATE INDEX "CredentialVerificationKeyTrustPin_expiresAt_status_idx" ON "CredentialVerificationKeyTrustPin"("expiresAt", "status");

-- CreateIndex: Creation time for audit
CREATE INDEX "CredentialVerificationKeyTrustPin_createdAt_idx" ON "CredentialVerificationKeyTrustPin"("createdAt");

-- CreateIndex: Revocation metadata for forensics
CREATE INDEX "CredentialVerificationKeyTrustPin_revokedAt_status_idx" ON "CredentialVerificationKeyTrustPin"("revokedAt", "status");

-- AddForeignKey: Trust pin references Organization
ALTER TABLE "CredentialVerificationKeyTrustPin" ADD CONSTRAINT "CredentialVerificationKeyTrustPin_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: Trust pin references Issuer
ALTER TABLE "CredentialVerificationKeyTrustPin" ADD CONSTRAINT "CredentialVerificationKeyTrustPin_issuerId_fkey" FOREIGN KEY ("issuerId") REFERENCES "Issuer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
