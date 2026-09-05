/**
 * scripts/engine/core.js
 * 
 * Main Invariant Engine runner.
 */

const { loadBaseline, isSuppressed } = require('./baseline');

async function runEngine(rules, autofix = false) {
  console.log('🚀 Running Invariant Engine...\n');
  
  const suppressions = loadBaseline();
  const allViolations = [];
  let fixedCount = 0;

  for (const rule of rules) {
    console.log(`⏳ Executing rule: ${rule.ruleId}...`);
    try {
      const violations = await rule.execute();
      
      for (const violation of violations) {
        if (isSuppressed(violation, suppressions)) {
          console.log(`  -> 🤫 Suppressed [${violation.ruleId}] in ${violation.file}`);
          continue;
        }

        if (autofix && violation.isFixable && typeof violation.fix === 'function') {
          console.log(`  -> 🔧 Autofixing [${violation.ruleId}] in ${violation.file}`);
          await violation.fix();
          fixedCount++;
        } else {
          allViolations.push(violation);
        }
      }
    } catch (err) {
      console.error(`❌ Rule ${rule.ruleId} crashed:`, err.message);
      allViolations.push({ ruleId: rule.ruleId, file: 'N/A', message: 'Rule crashed' });
    }
  }

  if (allViolations.length > 0) {
    console.error(`\n❌ ${allViolations.length} invariant violations found:\n`);
    allViolations.forEach(v => {
      console.error(`[${v.ruleId}] ${v.file}: ${v.message}`);
    });
    process.exit(1);
  }

  console.log(`\n✅ All invariants passed! ${fixedCount > 0 ? `(Autofixed ${fixedCount} issues)` : ''}`);
  process.exit(0);
}

module.exports = {
  runEngine
};
