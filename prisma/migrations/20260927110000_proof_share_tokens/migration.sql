-- #197: time-limited proof sharing tokens.

CREATE TYPE "ProofShareScope" AS ENUM ('VERIFY_STATUS', 'VERIFY_CREDENTIAL');

CREATE TABLE "ProofShareToken" (
    "id"             TEXT NOT NULL,
    "proofId"        TEXT NOT NULL,
    "ownerId"        TEXT NOT NULL,
    "tokenHash"      TEXT NOT NULL,
    "scope"          "ProofShareScope" NOT NULL,
    "label"          TEXT,
    "maxUses"        INTEGER,
    "useCount"       INTEGER NOT NULL DEFAULT 0,
    "expiresAt"      TIMESTAMP(3) NOT NULL,
    "revokedAt"      TIMESTAMP(3),
    "supersededAt"   TIMESTAMP(3),
    "supersededById" TEXT,
    "lastUsedAt"     TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProofShareToken_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProofShareToken_maxUses_check" CHECK ("maxUses" IS NULL OR "maxUses" > 0),
    CONSTRAINT "ProofShareToken_useCount_check" CHECK ("useCount" >= 0 AND ("maxUses" IS NULL OR "useCount" <= "maxUses"))
);

ALTER TABLE "ProofShareToken"
    ADD CONSTRAINT "ProofShareToken_proofId_fkey"
    FOREIGN KEY ("proofId") REFERENCES "Proof"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ProofShareToken_tokenHash_key" ON "ProofShareToken"("tokenHash");
CREATE INDEX "ProofShareToken_proofId_ownerId_idx" ON "ProofShareToken"("proofId", "ownerId");
CREATE INDEX "ProofShareToken_ownerId_idx" ON "ProofShareToken"("ownerId");
CREATE INDEX "ProofShareToken_expiresAt_idx" ON "ProofShareToken"("expiresAt");

-- At most one live (neither revoked nor superseded) token per proof and scope.
-- Issuing a new token supersedes the previous one inside the same transaction;
-- this index makes two concurrent issuances unable to both leave a live token.
CREATE UNIQUE INDEX "ProofShareToken_live_proof_scope_key"
    ON "ProofShareToken"("proofId", "scope")
    WHERE "revokedAt" IS NULL AND "supersededAt" IS NULL;

-- Scope and identity are immutable after issuance. Only lifecycle columns
-- (useCount, lastUsedAt, revokedAt, supersededAt, supersededById) may change,
-- and a revocation or supersession can never be undone.
CREATE FUNCTION "proof_share_token_immutable"() RETURNS trigger AS $$
BEGIN
    IF NEW."proofId"   IS DISTINCT FROM OLD."proofId"
    OR NEW."ownerId"   IS DISTINCT FROM OLD."ownerId"
    OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
    OR NEW."scope"     IS DISTINCT FROM OLD."scope"
    OR NEW."label"     IS DISTINCT FROM OLD."label"
    OR NEW."maxUses"   IS DISTINCT FROM OLD."maxUses"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'ProofShareToken issuance fields are immutable';
    END IF;
    IF (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt")
    OR (OLD."supersededAt" IS NOT NULL AND NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt") THEN
        RAISE EXCEPTION 'ProofShareToken revocation and supersession are terminal';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ProofShareToken_immutable"
    BEFORE UPDATE ON "ProofShareToken"
    FOR EACH ROW EXECUTE FUNCTION "proof_share_token_immutable"();

-- Privacy-safe usage attribution on verification events: the token row id only.
ALTER TABLE "VerificationEventLog" ADD COLUMN "shareTokenId" TEXT;
CREATE INDEX "VerificationEventLog_shareTokenId_idx" ON "VerificationEventLog"("shareTokenId");
