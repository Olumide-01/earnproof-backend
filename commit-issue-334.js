const { execSync } = require('child_process');
const path = require('path');

const repoPath = 'c:\\Users\\Nuelthewave\\Desktop\\Veridatum Pr\\earnproof-backend';

try {
  process.chdir(repoPath);
  
  console.log('🔧 Configuring git...');
  execSync('git config --local user.name "Kiro Agent"', { stdio: 'inherit' });
  execSync('git config --local user.email "kiro@veridatum.com"', { stdio: 'inherit' });
  
  console.log('\n📦 Creating branch...');
  execSync('git checkout -b feat/issue-334-offline-verification-bundles', { stdio: 'inherit' });
  
  console.log('\n📝 Staging files...');
  execSync('git add -A', { stdio: 'inherit' });
  
  const commitMsg = `feat: implement bounded offline verification bundles (#334)

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
- Idempotent generation via (organizationId, bundleId) unique constraint`;

  console.log('\n✍️  Committing...');
  execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { stdio: 'inherit' });
  
  console.log('\n🚀 Pushing...');
  execSync('git push -u origin feat/issue-334-offline-verification-bundles', { stdio: 'inherit' });
  
  console.log('\n✅ Commit and push complete!');
  console.log('Branch: feat/issue-334-offline-verification-bundles');
  
} catch (error) {
  console.error('❌ Error:', error.message);
  process.exit(1);
}
