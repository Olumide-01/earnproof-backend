# Create PR for controller test coverage (Issue #93)

Write-Host "Creating test/controller-coverage branch..." -ForegroundColor Green
git checkout -b test/controller-coverage

Write-Host "Staging modified test files..." -ForegroundColor Green
git add src/credentials/credentials.controller.spec.ts
git add src/trusted-sources/trusted-sources.controller.spec.ts
git add src/api-keys/integration-auth.controller.spec.ts

Write-Host "Committing changes..." -ForegroundColor Green
git commit -m "test(api): add controller test coverage"

Write-Host "Pushing to remote..." -ForegroundColor Green
git push -u origin test/controller-coverage

Write-Host ""
Write-Host "Branch created and pushed successfully!" -ForegroundColor Green
Write-Host "Create PR at: https://github.com/veridatum-labs/earnproof-backend/compare/main...test/controller-coverage" -ForegroundColor Cyan
