#!/usr/bin/env python3
import subprocess
import sys
import os

os.chdir(r'c:\Users\Nuelthewave\Desktop\Veridatum Pr\earnproof-backend')

try:
    # Configure git
    subprocess.run(['git', 'config', '--local', 'user.name', 'Kiro Agent'], check=True)
    subprocess.run(['git', 'config', '--local', 'user.email', 'kiro@veridatum.com'], check=True)
    
    # Create branch
    subprocess.run(['git', 'checkout', '-b', 'feat/issue-334-offline-verification-bundles'], check=True)
    
    # Stage all changes
    subprocess.run(['git', 'add', '-A'], check=True)
    
    # Commit
    commit_msg = """feat: implement bounded offline verification bundles (#334)

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
- Idempotent generation via (organizationId, bundleId) unique constraint
"""
    
    subprocess.run(['git', 'commit', '-m', commit_msg], check=True)
    
    # Push
    subprocess.run(['git', 'push', '-u', 'origin', 'feat/issue-334-offline-verification-bundles'], check=True)
    
    print("\n✅ Commit and push complete!")
    print("Branch: feat/issue-334-offline-verification-bundles")
    
except subprocess.CalledProcessError as e:
    print(f"❌ Error: {e}")
    sys.exit(1)
