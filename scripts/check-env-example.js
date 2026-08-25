#!/usr/bin/env node

/**
 * scripts/check-env-example.js
 *
 * CI check: asserts .env.example documents every variable in the env schema.
 *
 * This script is run in CI to catch cases where:
 * 1. A new env var is added to the schema but .env.example is not updated
 * 2. A schema var name is changed but .env.example is not updated
 * 3. An env var is removed from the schema but .env.example is not cleaned up (warning only)
 *
 * Exit codes:
 *   0 = success, schema and .env.example are in sync
 *   1 = failure, schema vars missing from .env.example (must fix)
 *   2 = warning, .env.example has vars not in schema (should clean up)
 *
 * Usage:
 *   node scripts/check-env-example.js
 *   node scripts/check-env-example.js --backend  # check backend .env.example
 *   node scripts/check-env-example.js --frontend # check frontend .env.example
 */

"use strict";

const fs = require("fs");
const path = require("path");

// Determine which .env.example(s) to check
const args = process.argv.slice(2);
const checkBackend = !args.length || args.includes("--backend");
const checkFrontend = args.includes("--frontend");

const checks = [];

if (checkBackend) {
  const backendSchemaPath = path.join(__dirname, "../backend/src/config/env.js");
  const backendExamplePath = path.join(__dirname, "../backend/.env.example");

  // Import the schema from env.js
  // Note: We can't require() because the schema module imports other dependencies.
  // Instead, we parse the schema object directly from the source code.
  const schemaVars = extractSchemaFromSource(backendSchemaPath);
  const exampleVars = parseEnvExample(backendExamplePath);

  checks.push({
    name: "backend/.env.example",
    schema: schemaVars,
    example: exampleVars,
  });
}

if (checkFrontend) {
  // Frontend uses different conventions (NEXT_PUBLIC_ prefix)
  // For now, we only check backend since frontend env vars are build-time only
  console.log("[env-check] Frontend env checking not yet implemented");
}

let hasErrors = false;
let hasWarnings = false;

for (const check of checks) {
  console.log(`\n[env-check] Checking ${check.name}...\n`);

  // Check 1: Schema vars missing from .env.example
  const missing = [];
  for (const varName of check.schema) {
    if (!check.example.has(varName)) {
      missing.push(varName);
    }
  }

  if (missing.length > 0) {
    console.error(
      `  ✗ Missing from ${check.name} (${missing.length} variable(s)):`
    );
    missing.forEach((v) => console.error(`    - ${v}`));
    hasErrors = true;
  }

  // Check 2: .env.example vars not in schema (warning)
  const extra = [];
  for (const varName of check.example) {
    if (!check.schema.has(varName)) {
      extra.push(varName);
    }
  }

  if (extra.length > 0) {
    console.warn(
      `  ⚠ Extra in ${check.name}, not in schema (${extra.length} variable(s)):`
    );
    extra.forEach((v) => console.warn(`    - ${v}`));
    hasWarnings = true;
  }

  if (missing.length === 0 && extra.length === 0) {
    console.log(`  ✓ ${check.name} is in sync with env schema`);
  }
}

console.log("");

if (hasErrors) {
  console.error("[env-check] Errors found. Add missing vars to .env.example");
  process.exit(1);
}

if (hasWarnings) {
  console.warn(
    "[env-check] Warnings found. Consider removing extra vars from .env.example"
  );
  process.exit(0); // Don't fail CI on warnings
}

console.log("[env-check] All checks passed ✓");
process.exit(0);

/**
 * Extract schema variable names from backend/src/config/env.js by parsing
 * the source code as a string. This avoids importing the module and triggering
 * its validation logic.
 *
 * @param {string} filePath
 * @returns {Set<string>} Set of variable names in the schema
 */
function extractSchemaFromSource(filePath) {
  const source = fs.readFileSync(filePath, "utf8");

  // Simple regex to find all keys in the schema object literal
  // Matches lines like:   NODE_ENV: {
  const schemaKeyRegex = /^\s+([A-Z_]+):\s*\{/gm;

  const vars = new Set();
  let match;
  while ((match = schemaKeyRegex.exec(source)) !== null) {
    vars.add(match[1]);
  }

  return vars;
}

/**
 * Parse .env.example and extract all variable names (keys before '=').
 *
 * @param {string} filePath
 * @returns {Set<string>} Set of variable names in .env.example
 */
function parseEnvExample(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");

  const vars = new Set();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // A commented assignment (`# VAR=default`) is how this file documents
    // optional settings: it names the variable and shows its default without
    // forcing a value. Treat it as documented. A prose comment is skipped.
    const candidate = line.startsWith("#") ? line.replace(/^#+\s*/, "") : line;

    const match = candidate.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
    if (match) {
      vars.add(match[1]);
    }
  }

  return vars;
}
