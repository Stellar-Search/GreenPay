/**
 * scripts/engine/adapters/python-rule.js
 * 
 * Adapter to run Python checks inside the Invariant Engine.
 */

const { spawnSync } = require('child_process');

function createPythonRule(ruleId, scriptPath) {
  return {
    ruleId,
    execute: async () => {
      const result = spawnSync('python3', [scriptPath, '--json'], { encoding: 'utf-8' });
      
      if (result.error) {
        throw new Error(`Failed to spawn python3: ${result.error.message}`);
      }
      
      // If the script exited cleanly without outputting JSON errors, it passed.
      if (result.status === 0 && !result.stdout.trim()) {
        return [];
      }

      try {
        const output = JSON.parse(result.stdout);
        return output.violations || [];
      } catch (err) {
        // Fallback if the script hasn't been fully migrated to JSON yet
        if (result.status !== 0) {
          return [{
            ruleId,
            file: 'N/A',
            message: `Python script failed with exit code ${result.status}:\n${result.stderr || result.stdout}`,
            isFixable: false
          }];
        }
        return [];
      }
    }
  };
}

module.exports = {
  createPythonRule
};
