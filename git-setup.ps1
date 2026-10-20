#!/usr/bin/env pwsh

Set-Location $PSScriptRoot

# Create branch
git checkout -b docs/api-key-integration-guide

# Stage files
git add docs/api-keys-guide.md README.md

# Commit with message
git commit -m "docs(integrations): add API key authentication guide

- Add comprehensive API key integration guide (docs/api-keys-guide.md)
- Covers full key lifecycle: create, use, rotate, revoke
- Documents all scopes and permissions with enforcement details
- Includes rate limiting configuration and headers
- Provides security best practices and code examples (Python, Node.js, cURL)
- Explains troubleshooting and incident response
- Update README to reflect API keys are production-ready and link to guide

Closes #91"

# Show the log
git log -1 --pretty=format:'%H %s' | Write-Host

Write-Host "Branch created and committed successfully!"
Write-Host ""
Write-Host "Next steps:"
Write-Host "1. Push the branch: git push -u origin docs/api-key-integration-guide"
Write-Host "2. Create a PR with: gh pr create --title 'docs(integrations): add API key authentication guide' --body 'Closes #91'"
