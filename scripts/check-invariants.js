#!/usr/bin/env node
/**
 * scripts/check-invariants.js
 * 
 * Unified Invariant Engine entry point.
 */

const path = require('path');
const { runEngine } = require('./engine/core');
const { createPythonRule } = require('./engine/adapters/python-rule');
const { spawnSync } = require('child_process');

const isAutofix = process.argv.includes('--fix');

// Wrap legacy Node scripts in the standard rule interface
function createLegacyNodeRule(ruleId, scriptName) {
  return {
    ruleId,
    execute: async () => {
      const scriptPath = path.join(__dirname, scriptName);
      const result = spawnSync('node', [scriptPath], { encoding: 'utf-8' });
      
      if (result.status !== 0) {
        return [{
          ruleId,
          file: 'N/A',
          message: `Legacy check failed:\n${result.stderr || result.stdout}`,
          isFixable: false
        }];
      }
      return [];
    }
  };
}

const rules = [
  createLegacyNodeRule('documented-commands', 'check-documented-commands.js'),
  createLegacyNodeRule('env-example', 'check-env-example.js'),
  createLegacyNodeRule('source-encoding', 'check-source-encoding.js'),
  createLegacyNodeRule('translations', 'check-translations.js'),
  createPythonRule('k8s-manifests', path.join(__dirname, 'check-k8s-manifests.py'))
];

// Run the engine
runEngine(rules, isAutofix).catch(err => {
  console.error("Engine failed critically:", err);
  process.exit(1);
});
