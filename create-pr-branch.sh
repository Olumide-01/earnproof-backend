#!/bin/bash
# Create PR for controller test coverage (Issue #93)

set -e

echo "Creating test/controller-coverage branch..."
git checkout -b test/controller-coverage

echo "Staging modified test files..."
git add src/credentials/credentials.controller.spec.ts
git add src/trusted-sources/trusted-sources.controller.spec.ts
git add src/api-keys/integration-auth.controller.spec.ts

echo "Committing changes..."
git commit -m "test(api): add controller test coverage"

echo "Pushing to remote..."
git push -u origin test/controller-coverage

echo "Branch created and pushed successfully!"
echo ""
echo "Create PR at: https://github.com/veridatum-labs/earnproof-backend/compare/main...test/controller-coverage"
