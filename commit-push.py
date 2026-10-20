#!/usr/bin/env python3
import subprocess
import sys
import os

os.chdir(r'c:\Users\Nuelthewave\Desktop\VEB PR\earnproof-backend')

def run_cmd(cmd, description):
    print(f"\n[*] {description}")
    print(f"    Running: {cmd}")
    try:
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            print(f"    ERROR: {result.stderr}")
            return False
        print(f"    SUCCESS: {result.stdout.strip()}")
        return True
    except Exception as e:
        print(f"    EXCEPTION: {e}")
        return False

print("=" * 60)
print("Git Commit and Push Operations")
print("=" * 60)

# Step 1: Check current status
run_cmd("git status --short", "Step 1: Check current status")

# Step 2: Check if branch exists, create if not
run_cmd("git rev-parse --verify docs/api-key-integration-guide 2>nul || git checkout -b docs/api-key-integration-guide", 
        "Step 2: Create/switch to branch")

# Step 3: Stage files
if not run_cmd("git add docs/api-keys-guide.md README.md", "Step 3: Stage files"):
    sys.exit(1)

# Step 4: Check staged changes
run_cmd("git diff --cached --name-only", "Step 4: Check staged files")

# Step 5: Commit
commit_msg = """docs(integrations): add API key authentication guide

- Add comprehensive API key integration guide (docs/api-keys-guide.md)
- Covers full key lifecycle: create, use, rotate, revoke
- Documents all scopes and permissions with enforcement details
- Includes rate limiting configuration and headers
- Provides security best practices and code examples (Python, Node.js, cURL)
- Explains troubleshooting and incident response
- Update README to reflect API keys are production-ready

Closes #91"""

cmd = f'git commit -m "{commit_msg}"'
if not run_cmd(cmd, "Step 5: Create commit"):
    sys.exit(1)

# Step 6: Show commit
run_cmd("git log -1 --oneline", "Step 6: Show commit")

# Step 7: Push
if not run_cmd("git push -u origin docs/api-key-integration-guide", "Step 7: Push to remote"):
    sys.exit(1)

print("\n" + "=" * 60)
print("SUCCESS: All operations completed!")
print("=" * 60)
print("\nNext: Create PR on GitHub with issue #91 reference")
