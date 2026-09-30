const { validateCommitMessage } = require('./commit-validator');
const { validateBranchName } = require('./branch-validator');

console.log("=== Testing Branch Validator ===");
const branches = [
  "main", // Valid
  "feature/123-add-login", // Valid
  "fix/456-bug", // Valid
  "chore/update-deps", // Valid
  "claude-fix", // Invalid (CLAUDE.md policy)
  "gpt-branch", // Invalid (CLAUDE.md policy)
  "feature/add-login", // Invalid (missing issue number)
  "random-branch" // Invalid (missing prefix)
];

branches.forEach(b => {
  const res = validateBranchName(b);
  console.log(`[${res.valid ? 'PASS' : 'FAIL'}] ${b}`);
  if (!res.valid) console.log(`   -> ${res.error.split('\n')[0]}`);
});

console.log("\n=== Testing Commit Validator ===");
const commits = [
  "feat(backend): add authentication", // Valid
  "fix(frontend): resolve UI glitch", // Valid
  "docs: update readme", // Valid
  "Merge branch 'main'", // Valid
  "Revert \"feat: something\"", // Valid
  "update: something", // Invalid (bad type)
  "feat(random): add something", // Invalid (bad scope)
  "feat(backend): ", // Invalid (empty subject)
  "feat(backend): this is a very very very very very very very long commit message that exceeds the maximum limit of fifty characters" // Invalid (too long)
];

commits.forEach(c => {
  const res = validateCommitMessage(c);
  console.log(`[${res.valid ? 'PASS' : 'FAIL'}] ${c}`);
  if (!res.valid) console.log(`   -> ${res.error.split('\n')[0]}`);
});
