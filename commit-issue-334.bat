@echo off
setlocal enabledelayedexpansion

cd /d "c:\Users\Nuelthewave\Desktop\Veridatum Pr\earnproof-backend"

REM Create and switch to feature branch
git checkout -b feat/issue-334-offline-verification-bundles

REM Stage all files
git add -A

REM Commit
git commit -m "feat: implement bounded offline verification bundles (#334)

- Add OfflineBundle Prisma model with idempotency constraint
- Implement OfflineBundleService: generate, verify, validate, signing logic
- Create OfflineBundlesController: POST /api/v1/proofs/bundles endpoint
- Add 12 new ApiErrorCode enum values for bundle-specific errors
- Add BUNDLES_CREATE scope to ApiKeyScope enum
- Create comprehensive test suite (30+ cases: positive, negative, boundary, auth, tamper, regression)
- Add offline-verification-bundles.md documentation
- Bundle format: versioned, HMAC-SHA256 signed, scoped via allowlist
- Expiry boundary: now >= expiresAt -> expired (inclusive)
- Freshness boundary: age > maxFreshnessSeconds -> stale (exclusive on limit)
- No private keys/secrets/PII in bundles (allowlist-based)
- Idempotent generation via (organizationId, bundleId) unique constraint"

REM Push to remote
git push -u origin feat/issue-334-offline-verification-bundles

echo.
echo Commit and push complete!
echo Branch: feat/issue-334-offline-verification-bundles
