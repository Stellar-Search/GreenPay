/**
 * scripts/policy/branch-validator.js
 * 
 * Enforces branch naming conventions.
 */

const VALID_PREFIXES = ['feature/', 'fix/', 'chore/', 'hotfix/', 'release/', 'docs/'];

function validateBranchName(branchName) {
  // Skip standard main/master branches
  if (branchName === 'main' || branchName === 'master' || branchName === 'develop') {
    return { valid: true };
  }

  // Enforce prefix
  const hasValidPrefix = VALID_PREFIXES.some(prefix => branchName.startsWith(prefix));
  if (!hasValidPrefix) {
    return {
      valid: false,
      error: `Branch name "${branchName}" must start with one of the allowed prefixes: ${VALID_PREFIXES.join(', ')}`
    };
  }

  // Enforce issue number for feature/fix branches (e.g. feature/123-description)
  // This expects the format prefix/NUMBER-description
  const namePart = branchName.substring(branchName.indexOf('/') + 1);
  
  if (branchName.startsWith('feature/') || branchName.startsWith('fix/')) {
    const issueRegex = /^[0-9]+-[a-z0-9-]+$/;
    if (!issueRegex.test(namePart)) {
      return {
        valid: false,
        error: `Branch name "${branchName}" must include an issue number.\nExample: "feature/123-add-login"`
      };
    }
  }

  // Enforce CLAUDE.md naming guidelines (no AI model names)
  if (branchName.toLowerCase().includes('claude') || branchName.toLowerCase().includes('gpt')) {
    return {
      valid: false,
      error: `Branch name "${branchName}" violates CLAUDE.md naming policy (no AI model names allowed).`
    };
  }

  return { valid: true };
}

module.exports = {
  validateBranchName,
  VALID_PREFIXES
};
