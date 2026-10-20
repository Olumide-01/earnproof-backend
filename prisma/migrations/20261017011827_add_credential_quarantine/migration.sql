-- Issue #324: Credential quarantine and release workflow
-- Isolate malformed, unknown-key, policy-conflicting, or suspicious imported credentials
-- before they can be used in normal verification. Provides a safe path to release, reject, or expire them.

-- Create enum for quarantine reason codes
CREATE TYPE "CredentialQuarantineReasonCode" AS ENUM (
  'MALFORMED',
  'UNKNOWN_KEY',
  'POLICY_CONFLICT',
  'TRUST_NOT_ESTABLISHED',
  'SUSPICIOUS'
);

-- Create enum for quarantine state machine
CREATE TYPE "CredentialQuarantineState" AS ENUM (
  'QUARANTINED',
  'RELEASED',
  'REJECTED',
  'EXPIRED'
);

-- Create CredentialQuarantine table: bounded metadata only, never raw credential content
CREATE TABLE "CredentialQuarantine" (
  -- Identity & Scope
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,  -- Denormalized for tenant queries

  -- Quarantine Reason & State
  "reason" "CredentialQuarantineReasonCode" NOT NULL,
  "state" "CredentialQuarantineState" NOT NULL DEFAULT 'QUARANTINED',

  -- Bounded Metadata (safe allowlist only; never raw credential)
  "contentHash" TEXT NOT NULL,           -- SHA-256(canonical credential)
  "contentSize" INTEGER NOT NULL,        -- Byte size of original credential
  "schemaType" VARCHAR(100) NOT NULL,    -- "EarnProofMinimumIncomeCredential"
  "schemaVersion" VARCHAR(64) NOT NULL,  -- "earnproof.minimum-income.v1"

  -- Issuer metadata (from credential, not live lookup)
  "issuerIdentifier" VARCHAR(255) NOT NULL,   -- Issuer name or DID (safe to log)
  "issuerPolicyVersion" INTEGER,              -- Issuer policy version at intake time (nullable)

  -- Credential metadata (from parsed credential, verified safe)
  "credentialProofType" VARCHAR(64),             -- "MINIMUM_INCOME", "RECURRING_INCOME", etc.
  "credentialExpiresAt" TIMESTAMP(3),            -- expiresAt from credential claim (nullable)
  "credentialIssuedAt" TIMESTAMP(3),             -- issuedAt from credential claim (nullable)

  -- Key metadata (if trust pin was involved)
  "keyId" VARCHAR(255),            -- Key identifier from proof block
  "keyType" VARCHAR(64),           -- "Ed25519" or "HMAC-SHA256"
  "network" VARCHAR(64),           -- "public" or "testnet" (from Ed25519 proofs)

  -- Evidence & Freshness
  "evidenceRefreshedAt" TIMESTAMP(3),               -- When trust evidence was last fetched
  "evidenceFreshUntil" TIMESTAMP(3),                -- When evidence is no longer usable for release
  "evidenceRefreshReason" VARCHAR(255),             -- Optional note on refresh

  -- Release Decision Metadata (filled when state != QUARANTINED)
  "decidedByUserId" TEXT,                    -- User who made the decision (REFERENCES User.id)
  "decidedAt" TIMESTAMP(3),                  -- When the decision was made
  "decisionReason" VARCHAR(1024),             -- Free-form reason for rejection/release (optional)

  -- Audit & Concurrency
  "importedByUserId" TEXT NOT NULL,           -- User who imported/triggered quarantine
  "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  "expiresAt" TIMESTAMP(3) NOT NULL,      -- Absolute deadline for quarantine (auto-expire to EXPIRED)
  "revision" INTEGER NOT NULL DEFAULT 1, -- Optimistic concurrency control (incremented on each state change)

  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Foreign key constraints
  CONSTRAINT "CredentialQuarantine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CredentialQuarantine_importedByUserId_fkey" FOREIGN KEY ("importedByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CredentialQuarantine_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- Create indexes for efficient querying
CREATE INDEX "CredentialQuarantine_organizationId_state_idx" ON "CredentialQuarantine"("organizationId", "state");
CREATE INDEX "CredentialQuarantine_organizationId_createdAt_idx" ON "CredentialQuarantine"("organizationId", "createdAt");
CREATE INDEX "CredentialQuarantine_organizationId_expiresAt_state_idx" ON "CredentialQuarantine"("organizationId", "expiresAt", "state");
CREATE INDEX "CredentialQuarantine_contentHash_idx" ON "CredentialQuarantine"("contentHash");  -- For deduplication check
CREATE INDEX "CredentialQuarantine_state_expiresAt_idx" ON "CredentialQuarantine"("state", "expiresAt");  -- For expiry job
CREATE INDEX "CredentialQuarantine_decidedByUserId_idx" ON "CredentialQuarantine"("decidedByUserId");

-- Unique constraint: prevent duplicate active quarantines for same credential per org
-- Only QUARANTINED records are part of this constraint; RELEASED/REJECTED/EXPIRED are historical
CREATE UNIQUE INDEX "CredentialQuarantine_org_hash_state_unique" ON "CredentialQuarantine"(
  "organizationId",
  "contentHash"
) WHERE "state" = 'QUARANTINED';

-- Create CredentialQuarantineAudit table: immutable audit trail
CREATE TABLE "CredentialQuarantineAudit" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "quarantineId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,

  -- Event
  "event" VARCHAR(64) NOT NULL,    -- "QUARANTINED", "RELEASED", "REJECTED", "EXPIRED", "EVIDENCE_REFRESHED"
  "actor" TEXT NOT NULL,           -- User ID who triggered the event
  "actorRole" "UserRole" NOT NULL, -- ADMIN, WORKER, ISSUER, DEVELOPER

  -- Event Details
  "previousState" "CredentialQuarantineState",
  "newState" "CredentialQuarantineState",
  "changeReason" VARCHAR(512),            -- Why the state changed

  -- Evidence refresh details (if event = EVIDENCE_REFRESHED)
  "evidenceResult" VARCHAR(255),            -- "FRESH", "STALE", "FETCH_FAILED", "VALIDATION_PASSED", etc.

  -- Approval linkage (if event = RELEASED or REJECTED)
  "approvalRequestId" TEXT,                 -- Link to approval request (if four-eyes used)

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Foreign key constraints
  CONSTRAINT "CredentialQuarantineAudit_quarantineId_fkey" FOREIGN KEY ("quarantineId") REFERENCES "CredentialQuarantine" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CredentialQuarantineAudit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CredentialQuarantineAudit_actor_fkey" FOREIGN KEY ("actor") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Create indexes for efficient querying
CREATE INDEX "CredentialQuarantineAudit_quarantineId_createdAt_idx" ON "CredentialQuarantineAudit"("quarantineId", "createdAt");
CREATE INDEX "CredentialQuarantineAudit_organizationId_event_createdAt_idx" ON "CredentialQuarantineAudit"("organizationId", "event", "createdAt");
CREATE INDEX "CredentialQuarantineAudit_actor_createdAt_idx" ON "CredentialQuarantineAudit"("actor", "createdAt");
CREATE INDEX "CredentialQuarantineAudit_event_idx" ON "CredentialQuarantineAudit"("event");

