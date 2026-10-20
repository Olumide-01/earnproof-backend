-- Privacy-safe, aggregated CSP violation reporting (issue #336).

CREATE TYPE "CspDirective" AS ENUM (
  'DEFAULT_SRC',
  'SCRIPT_SRC',
  'STYLE_SRC',
  'IMG_SRC',
  'CONNECT_SRC',
  'FONT_SRC',
  'FRAME_SRC',
  'OBJECT_SRC',
  'MEDIA_SRC',
  'WORKER_SRC',
  'MANIFEST_SRC',
  'BASE_URI',
  'FORM_ACTION',
  'FRAME_ANCESTORS',
  'UPGRADE_INSECURE_REQUESTS',
  'OTHER'
);

CREATE TYPE "CspRouteCategory" AS ENUM (
  'AUTH',
  'DASHBOARD',
  'PROOFS',
  'PAYMENTS',
  'SETTINGS',
  'PUBLIC',
  'OTHER'
);

CREATE TYPE "CspDisposition" AS ENUM ('ENFORCE', 'REPORT');

CREATE TABLE "CspViolationSummary" (
  "id" TEXT NOT NULL,
  "directive" "CspDirective" NOT NULL,
  "routeCategory" "CspRouteCategory" NOT NULL,
  "release" TEXT NOT NULL,
  "disposition" "CspDisposition" NOT NULL,
  "count" BIGINT NOT NULL DEFAULT 0,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CspViolationSummary_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CspViolationSummary_directive_routeCategory_release_dispo_key"
  ON "CspViolationSummary"("directive", "routeCategory", "release", "disposition");
CREATE INDEX "CspViolationSummary_lastSeenAt_idx" ON "CspViolationSummary"("lastSeenAt");
