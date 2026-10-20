-- Short-lived, action-bound recent-auth assertion store.
-- Consumed (single-use) on successful destructive operation.
CREATE TABLE "RecentAuthAssertion" (
  "id"          TEXT         NOT NULL,
  "tokenHash"   TEXT         NOT NULL,
  "userId"      TEXT         NOT NULL,
  "action"      TEXT         NOT NULL,
  "resourceId"  TEXT         NOT NULL,
  "originHash"  TEXT         NOT NULL,
  "network"     TEXT         NOT NULL,
  "expiresAt"   TIMESTAMP(3) NOT NULL,
  "usedAt"      TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RecentAuthAssertion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RecentAuthAssertion_tokenHash_key"          ON "RecentAuthAssertion"("tokenHash");
CREATE INDEX "RecentAuthAssertion_userId_action_usedAt_idx"      ON "RecentAuthAssertion"("userId", "action", "usedAt");
CREATE INDEX "RecentAuthAssertion_expiresAt_idx"                 ON "RecentAuthAssertion"("expiresAt");