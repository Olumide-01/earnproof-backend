-- migration-safety: compatibility=additive
-- migration-safety: rollback=drop-table-PermissionChangeDiff

-- CreateTable: PermissionChangeDiff
--
-- Versioned semantic diffs for permission changes.
-- Secrets never enter diffs; diffHash provides replay detection.
CREATE TABLE "PermissionChangeDiff" (
  "id"          TEXT         NOT NULL,
  "version"     TEXT         NOT NULL,
  "subjectId"   TEXT         NOT NULL,
  "subjectKind" TEXT         NOT NULL,
  "actorHash"   TEXT         NOT NULL,
  "before"      JSONB        NOT NULL,
  "after"       JSONB        NOT NULL,
  "changes"     JSONB        NOT NULL,
  "diffHash"    TEXT         NOT NULL,
  "auditLogId"  TEXT,
  "changedAt"   TIMESTAMP(3) NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PermissionChangeDiff_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PermissionChangeDiff_diffHash_key"
  ON "PermissionChangeDiff"("diffHash");

CREATE INDEX "PermissionChangeDiff_subjectId_changedAt_idx"
  ON "PermissionChangeDiff"("subjectId", "changedAt");

CREATE INDEX "PermissionChangeDiff_subjectKind_changedAt_idx"
  ON "PermissionChangeDiff"("subjectKind", "changedAt");

CREATE INDEX "PermissionChangeDiff_diffHash_idx"
  ON "PermissionChangeDiff"("diffHash");