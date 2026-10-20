-- Issue #170: user profile and account status APIs.
--
-- Additive only: a nullable profile column and a new authentication audit
-- event type. Existing rows and existing readers are unaffected.

-- A login attempt by a suspended, revoked or deleted account is refused and
-- audited under its own event type rather than folded into SIGNATURE_INVALID.
ALTER TYPE "AuthEventType" ADD VALUE 'ACCOUNT_INACTIVE';

-- The only self-editable profile field. Bounded to 64 characters.
ALTER TABLE "User" ADD COLUMN "displayName" VARCHAR(64);
