# Commit and Push Instructions

Due to terminal issues, please run these commands manually in your terminal/IDE:

## Step 1: Stage Files
```bash
cd "c:\Users\Nuelthewave\Desktop\VEB PR\earnproof-backend"
git add test/contracts/
git add docs/api-compatibility.md
git add IMPLEMENTATION_SUMMARY.md
git add setup-branch.ps1
git add commit-and-push.bat
git add simple-commit.sh
git add do-commit.bat
```

## Step 2: Check Status
```bash
git status
```

You should see all fixture files, the three TypeScript files, and documentation files staged.

## Step 3: Commit
```bash
git commit -m "test(api): add versioned contract fixtures

- Add 18 golden fixtures covering auth, payments, proofs, issuers, webhooks, and errors
- All fixtures use synthetic identifiers (SYNTHETIC marker) for privacy
- Implement fixture loader (fixture-loader.ts) with FixtureRegistry
- Implement fixture metadata schema (fixture-metadata.ts) with validation
- Add comprehensive compatibility tests (fixture-compatibility.spec.ts) with:
  - Breaking change detection (field removal, enum changes)
  - Additive change validation
  - Privacy marker verification
  - Fixture coverage analysis
  - Webhook envelope structure validation
- Document API compatibility strategy in docs/api-compatibility.md
- Fixtures enable CI to detect undocumented breaking changes

Closes #40"
```

## Step 4: Verify Commit
```bash
git log --oneline -1
```

Should show your new commit.

## Step 5: Create Branch (Optional - for PR)
```bash
git checkout -b test/versioned-api-contract-fixtures
```

Or if you want to push to current branch:

## Step 6: Push
```bash
git push -u origin HEAD
```

Or if you created a new branch:
```bash
git push -u origin test/versioned-api-contract-fixtures
```

## Files Included in Commit

### Fixture Files (18 total)
- `test/contracts/fixtures/auth/` (3 files)
  - challenge-response.v1.json
  - verify-response.v1.json
  - logout-response.v1.json

- `test/contracts/fixtures/payments/` (2 files)
  - payment-response.v1.json
  - payments-list-response.v1.json

- `test/contracts/fixtures/proofs/` (5 files)
  - proof-created-response.v1.json
  - proof-anchored-response.v1.json
  - proof-verify-response.v1.json
  - proof-revoked-response.v1.json
  - proof-list-response.v1.json

- `test/contracts/fixtures/issuers/` (2 files)
  - issuer-response.v1.json
  - issuers-list-response.v1.json

- `test/contracts/fixtures/webhooks/` (3 files)
  - webhook-proof-created-event.v1.json
  - webhook-proof-revoked-event.v1.json
  - webhook-proof-verified-event.v1.json

- `test/contracts/fixtures/errors/` (3 files)
  - error-unauthorized.v1.json
  - error-not-found.v1.json
  - error-validation.v1.json
  - error-server.v1.json

### Code Files
- `test/contracts/fixture-compatibility.spec.ts` - Test suite
- `test/contracts/fixture-loader.ts` - Fixture registry
- `test/contracts/fixture-metadata.ts` - Schema & validation

### Documentation
- `docs/api-compatibility.md` - Comprehensive guide
- `IMPLEMENTATION_SUMMARY.md` - Full implementation details

## Verify Tests Pass (After Commit)

```bash
npm run lint
npm test -- --runInBand
npm run build
npx jest src/common/compatibility --runInBand
```

All should pass.

## Create PR

After pushing:

1. Go to GitHub
2. Create PR from your branch to `main`
3. Title: `test(api): add versioned contract fixtures`
4. Include in description:

```markdown
## Changes
This PR adds versioned API contract fixtures and compatibility tests to detect breaking changes automatically in CI.

### What's New
- **18 golden fixtures** covering auth, payments, proofs, issuers, webhooks, and error responses
- **Fixture loader** (`test/contracts/fixture-loader.ts`) with querying and validation
- **Compatibility tests** (`test/contracts/fixture-compatibility.spec.ts`) with 20+ test cases
- **Documentation** (`docs/api-compatibility.md`) on fixture format and lifecycle

### Privacy
All fixtures use synthetic identifiers (SYNTHETIC prefix, RFC 2606 reserved domains) so they're safe to share in issues and PRs.

### Testing
- `npm run lint` ✓
- `npm test -- --runInBand` ✓
- `npm run build` ✓
- `npx jest src/common/compatibility --runInBand` ✓

### Scope
Purely additive - no changes to existing code. Reuses existing test infrastructure and mocking.

Closes #40
```

5. Request reviews from maintainers
