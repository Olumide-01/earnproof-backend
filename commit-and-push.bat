@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

echo.
echo ============================================
echo Starting git operations...
echo ============================================
echo.

REM Check current branch
echo [1/6] Checking current branch...
git branch -v
if errorlevel 1 (
    echo ERROR: Could not get branch info
    exit /b 1
)

echo.
echo [2/6] Checking if branch exists...
git rev-parse --verify docs/api-key-integration-guide 2>nul
if errorlevel 1 (
    echo Branch does not exist, creating...
    git checkout -b docs/api-key-integration-guide
    if errorlevel 1 (
        echo ERROR: Could not create branch
        exit /b 1
    )
) else (
    echo Branch exists, switching to it...
    git checkout docs/api-key-integration-guide
    if errorlevel 1 (
        echo ERROR: Could not switch to branch
        exit /b 1
    )
)

echo.
echo [3/6] Staging files...
git add docs/api-keys-guide.md README.md
if errorlevel 1 (
    echo ERROR: Could not stage files
    exit /b 1
)
echo Files staged successfully

echo.
echo [4/6] Showing staged changes...
git diff --cached --stat

echo.
echo [5/6] Creating commit...
git commit -m "docs(integrations): add API key authentication guide

- Add comprehensive API key integration guide (docs/api-keys-guide.md)
- Covers full key lifecycle: create, use, rotate, revoke
- Documents all scopes and permissions with enforcement details
- Includes rate limiting configuration and headers
- Provides security best practices and code examples (Python, Node.js, cURL)
- Explains troubleshooting and incident response
- Update README to reflect API keys are production-ready

Closes #91"

if errorlevel 1 (
    echo ERROR: Could not create commit
    exit /b 1
)
echo Commit created successfully

echo.
echo [6/6] Pushing to remote...
git push -u origin docs/api-key-integration-guide
if errorlevel 1 (
    echo ERROR: Could not push
    exit /b 1
)
echo Push successful!

echo.
echo ============================================
echo All operations completed successfully!
echo ============================================
echo.
echo Showing final log:
git log -1 --oneline
echo.
echo Branch pushed to remote. PR ready to create.
pause
