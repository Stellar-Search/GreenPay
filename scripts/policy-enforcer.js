#!/usr/bin/env node
const fs = require('fs');

const type = process.argv[2];

if (type === 'commit-msg') {
  const msgFile = process.argv[3];
  if (!msgFile) process.exit(0);
  
  const msg = fs.readFileSync(msgFile, 'utf-8').trim();
  
  // Basic conventional commit validation
  const conventionalRegex = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9\-]+\))?:\s.+/;
  if (!conventionalRegex.test(msg) && !msg.startsWith('Merge ') && !msg.startsWith('Revert ')) {
    console.error(`\n❌ ERROR: Invalid commit message format.`);
    console.error(`Commit message must follow Conventional Commits format (e.g. "feat: add something").`);
    console.error(`Your message: "${msg}"\n`);
    process.exit(1);
  }
} else if (type === 'pre-push') {
  // Basic branch naming rule against CLAUDE.md guidelines (e.g., no model names like "claude")
  const branchName = require('child_process').execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
  if (branchName.toLowerCase().includes('claude') || branchName.toLowerCase().includes('gpt')) {
    console.error(`\n❌ ERROR: Branch name violates naming policy (no model names allowed).`);
    process.exit(1);
  }
}

process.exit(0);
