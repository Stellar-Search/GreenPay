const fs = require('fs');
const path = require('path');

let baselineSuppression = null;

/**
 * Loads the baseline suppression file once
 */
function loadBaseline() {
  if (baselineSuppression !== null) {
    return baselineSuppression;
  }

  // Look for .greenpay-eslint-baseline.json in the repository root
  // We assume the plugin is executed from the repository root (e.g. frontend/ or backend/ directory)
  // But wait! frontend/ and backend/ are subdirectories.
  // We should resolve the repo root.
  const repoRoot = path.resolve(__dirname, '../../../../');
  const baselinePath = path.join(repoRoot, '.greenpay-eslint-baseline.json');

  try {
    if (fs.existsSync(baselinePath)) {
      const content = fs.readFileSync(baselinePath, 'utf8');
      baselineSuppression = JSON.parse(content);
    } else {
      baselineSuppression = {};
    }
  } catch (error) {
    console.error('[eslint-plugin-greenpay] Failed to load baseline JSON', error);
    baselineSuppression = {};
  }

  return baselineSuppression;
}

/**
 * Normalizes file path to be relative to the repo root
 */
function getRelativePath(absolutePath) {
  const repoRoot = path.resolve(__dirname, '../../../../');
  if (absolutePath.startsWith(repoRoot)) {
    return absolutePath.substring(repoRoot.length + 1); // remove leading slash
  }
  return absolutePath;
}

/**
 * Checks if a specific violation is suppressed in the baseline
 */
function isSuppressed(context, ruleId) {
  const baseline = loadBaseline();
  if (!baseline || Object.keys(baseline).length === 0) {
    return false;
  }

  const filename = context.getFilename();
  if (!filename) return false;

  const relPath = getRelativePath(filename);
  
  if (baseline[relPath] && baseline[relPath][ruleId]) {
    // If the file + rule is in the baseline, we suppress it completely for now
    // A more advanced baseline would check line numbers or hashes
    // Given the prompt requirement to allow adoption without fixing all 98 sites at once,
    // a file-level + rule-level suppression is generally sufficient for a baseline rollout.
    return true;
  }

  return false;
}

/**
 * Wrap context.report to intercept violations
 */
function wrapReport(context, ruleId, reportFn) {
  return function(descriptor) {
    if (isSuppressed(context, ruleId)) {
      return; // Squelched by baseline
    }
    return reportFn.call(context, descriptor);
  };
}

module.exports = {
  loadBaseline,
  isSuppressed,
  wrapReport,
};
