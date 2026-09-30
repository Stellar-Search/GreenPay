/**
 * scripts/policy/commit-validator.js
 * 
 * Enforces Conventional Commits formatting and scope constraints.
 */

const VALID_TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'];
const VALID_SCOPES = ['backend', 'frontend', 'contracts', 'mobile', 'extension', 'infra', 'shared', 'deps', 'config'];
const MAX_SUBJECT_LENGTH = 50;

function validateCommitMessage(message) {
  // Allow merge commits and reverts
  if (message.startsWith('Merge ') || message.startsWith('Revert ')) {
    return { valid: true };
  }

  // Regex to parse Conventional Commits: type(scope)?!?: subject
  const commitRegex = /^([a-z]+)(?:\(([^)]+)\))?(!)?:\s+(.*)$/;
  const match = message.match(commitRegex);

  if (!match) {
    return {
      valid: false,
      error: 'Commit message must follow Conventional Commits format.\nExample: "feat(backend): add user authentication"\nYour message: "' + message + '"'
    };
  }

  const [_, type, scope, breaking, subject] = match;

  if (!VALID_TYPES.includes(type)) {
    return {
      valid: false,
      error: `Invalid commit type: "${type}".\nAllowed types: ${VALID_TYPES.join(', ')}`
    };
  }

  if (scope && !VALID_SCOPES.includes(scope)) {
    return {
      valid: false,
      error: `Invalid commit scope: "${scope}".\nAllowed scopes: ${VALID_SCOPES.join(', ')}`
    };
  }

  if (subject.trim().length === 0) {
    return {
      valid: false,
      error: 'Commit subject cannot be empty.'
    };
  }

  if (subject.length > MAX_SUBJECT_LENGTH) {
    return {
      valid: false,
      error: `Commit subject exceeds maximum length of ${MAX_SUBJECT_LENGTH} characters (was ${subject.length}).\nPlease keep the subject concise and add a body for details.`
    };
  }

  return { valid: true };
}

module.exports = {
  validateCommitMessage,
  VALID_TYPES,
  VALID_SCOPES
};
