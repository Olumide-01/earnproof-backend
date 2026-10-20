#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');

const repoPath = path.join('c:', 'Users', 'Nuelthewave', 'Desktop', 'VEB PR', 'earnproof-backend');

function runCmd(cmd, description) {
  console.log(`\n[*] ${description}`);
  console.log(`    Running: ${cmd}`);
  try {
    const output = execSync(cmd, { 
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    console.log(`    SUCCESS:`);
    console.log(output.trim());
    return true;
  } catch (error) {
    console.log(`    ERROR: ${error.message}`);
    if (error.stdout) console.log(error.stdout.toString());
    if (error.stderr) console.log(error.stderr.toString());
    return false;
  }
}

console.log('='.repeat(60));
console.log('Git Commit and Push Operations');
console.log('='.repeat(60));

// Step 1: Status
runCmd('git status --short', 'Step 1: Check current status');

// Step 2: Switch/create branch
runCmd('git checkout -b docs/api-key-integration-guide 2>nul || git checkout docs/api-key-integration-guide', 
       'Step 2: Create/switch to branch');

// Step 3: Stage files
if (!runCmd('git add docs/api-keys-guide.md README.md', 'Step 3: Stage files')) {
  process.exit(1);
}

// Step 4: Check staged
runCmd('git diff --cached --name-only', 'Step 4: Check staged files');

// Step 5: Commit
const commitMsg = `docs(integrations): add API key authentication guide

- Add comprehensive API key integration guide (docs/api-keys-guide.md)
- Covers full key lifecycle: create, use, rotate, revoke
- Documents all scopes and permissions with enforcement details
- Includes rate limiting configuration and headers
- Provides security best practices and code examples (Python, Node.js, cURL)
- Explains troubleshooting and incident response
- Update README to reflect API keys are production-ready

Closes #91`;

const commitCmd = `git commit -m "${commitMsg.replace(/"/g, '\\"')}"`;
if (!runCmd(commitCmd, 'Step 5: Create commit')) {
  process.exit(1);
}

// Step 6: Show commit
runCmd('git log -1 --oneline', 'Step 6: Show commit');

// Step 7: Push
if (!runCmd('git push -u origin docs/api-key-integration-guide', 'Step 7: Push to remote')) {
  process.exit(1);
}

console.log('\n' + '='.repeat(60));
console.log('SUCCESS: All operations completed!');
console.log('='.repeat(60));
console.log('\nPR is ready. Reference issue #91');
