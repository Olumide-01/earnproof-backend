@echo off
cd /d "%~dp0"

echo Creating branch...
git checkout -b docs/api-key-integration-guide

echo Staging files...
git add docs/api-keys-guide.md README.md

echo Committing changes...
git commit -m "docs(integrations): add API key authentication guide

- Add comprehensive API key integration guide (docs/api-keys-guide.md)
- Covers full key lifecycle: create, use, rotate, revoke
- Documents all scopes and permissions with enforcement details
- Includes rate limiting configuration and headers
- Provides security best practices and code examples (Python, Node.js, cURL)
- Explains troubleshooting and incident response
- Update README to reflect API keys are production-ready and link to guide

Closes #91"

echo.
echo Branch created and committed successfully!
echo.
echo Next steps:
echo 1. Push the branch: git push -u origin docs/api-key-integration-guide
echo 2. Create a PR with: gh pr create
