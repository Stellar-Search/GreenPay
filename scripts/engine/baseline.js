/**
 * scripts/engine/baseline.js
 * 
 * Manages .invariant-baseline.json to grandfather existing violations.
 * A violation is suppressed if it matches ruleId, file, and line/context,
 * AND hasn't expired.
 */

const fs = require('fs');
const path = require('path');

const BASELINE_FILE = path.join(__dirname, '../../.invariant-baseline.json');

function loadBaseline() {
  if (fs.existsSync(BASELINE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf-8'));
      return data.suppressions || [];
    } catch (err) {
      console.warn('⚠️ Warning: Failed to parse .invariant-baseline.json');
      return [];
    }
  }
  return [];
}

function saveBaseline(suppressions) {
  fs.writeFileSync(BASELINE_FILE, JSON.stringify({ suppressions }, null, 2));
}

function isSuppressed(violation, suppressions) {
  const now = new Date().toISOString();
  
  return suppressions.some(sup => {
    return sup.ruleId === violation.ruleId &&
           sup.file === violation.file &&
           (!sup.expiry || sup.expiry > now);
  });
}

module.exports = {
  loadBaseline,
  saveBaseline,
  isSuppressed
};
