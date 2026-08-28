#!/usr/bin/env node
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('🚀 Running Invariant Engine (Minimal Mode)...\n');

const scripts = [
  'check-documented-commands.js',
  'check-env-example.js',
  'check-source-encoding.js',
  'check-translations.js',
  'check-k8s-manifests.py'
];

let failed = false;

for (const script of scripts) {
  const scriptPath = path.join(__dirname, script);
  if (!fs.existsSync(scriptPath)) {
    console.warn(`⚠️  Skipping ${script} (not found)`);
    continue;
  }
  
  console.log(`⏳ Running ${script}...`);
  const isPython = script.endsWith('.py');
  const cmd = isPython ? 'python3' : 'node';
  
  const result = spawnSync(cmd, [scriptPath], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`❌ ${script} failed!`);
    failed = true;
  } else {
    console.log(`✅ ${script} passed.`);
  }
}

if (failed) {
  console.error('\n❌ Invariant checks failed.');
  process.exit(1);
} else {
  console.log('\n✅ All invariants passed.');
  process.exit(0);
}
