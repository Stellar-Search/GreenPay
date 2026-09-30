#!/usr/bin/env node
/**
 * scripts/policy/enforcer.js
 * 
 * Central entry point for Git hooks driven by Husky.
 * Usage:
 *   node scripts/policy/enforcer.js commit-msg <COMMIT_MSG_FILE>
 *   node scripts/policy/enforcer.js pre-push
 */

const fs = require('fs');
const { execSync } = require('child_process');
const { validateCommitMessage } = require('./commit-validator');
const { validateBranchName } = require('./branch-validator');

const hookType = process.argv[2];

function exitWithError(message) {
  console.error('\n' + message + '\n');
  process.exit(1);
}

if (hookType === 'commit-msg') {
  const msgFile = process.argv[3];
  if (!msgFile) {
    exitWithError('❌ ERROR: Missing commit message file argument.');
  }
  
  const msg = fs.readFileSync(msgFile, 'utf-8').trim();
  const result = validateCommitMessage(msg);
  
  if (!result.valid) {
    exitWithError(`❌ COMMIT VALIDATION FAILED\n\n${result.error}`);
  }
  
} else if (hookType === 'pre-push') {
  // Get the current branch name from git
  let branchName = 'unknown';
  try {
    branchName = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
  } catch (err) {
    console.warn('⚠️ Could not determine branch name, skipping branch validation.');
    process.exit(0);
  }
  
  const result = validateBranchName(branchName);
  if (!result.valid) {
    exitWithError(`❌ BRANCH VALIDATION FAILED\n\n${result.error}`);
  }
} else {
  console.error(`⚠️ Unknown hook type: ${hookType}`);
  process.exit(0); // Soft fail on unknown hook
}

process.exit(0);
