#!/usr/bin/env node

/**
 * CI script to check for missing translations across all locales.
 *
 * This script runs in CI and fails if any key is missing from any locale.
 */

const fs = require("fs");
const path = require("path");

const LOCALE_DIR = path.resolve(__dirname, "../shared/locales");

function loadJson(file) {
  const content = fs.readFileSync(file, "utf-8");
  return JSON.parse(content);
}

function flatten(obj, prefix = "") {
  const result = {};
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof obj[key] === "object" && obj[key] !== null && !Array.isArray(obj[key])) {
      Object.assign(result, flatten(obj[key], fullKey));
    } else {
      result[fullKey] = obj[key];
    }
  }
  return result;
}

function main() {
  const files = fs.readdirSync(LOCALE_DIR).filter(f => f.endsWith(".json"));
  const locales = {};

  for (const file of files) {
    const locale = path.basename(file, ".json");
    const data = loadJson(path.join(LOCALE_DIR, file));
    locales[locale] = flatten(data);
  }

  const keys = new Set();
  for (const locale of Object.keys(locales)) {
    for (const key of Object.keys(locales[locale])) {
      keys.add(key);
    }
  }

  const missing = {};
  let hasMissing = false;

  for (const locale of Object.keys(locales)) {
    const missingKeys = [];
    for (const key of keys) {
      if (!(key in locales[locale])) {
        missingKeys.push(key);
      }
    }
    if (missingKeys.length > 0) {
      missing[locale] = missingKeys;
      hasMissing = true;
    }
  }

  if (hasMissing) {
    console.error("❌ Missing translations detected:");
    for (const [locale, keys] of Object.entries(missing)) {
      console.error(`\n${locale}:`);
      for (const key of keys) {
        console.error(`  - ${key}`);
      }
    }
    process.exit(1);
  }

  console.log("✅ All translations are present in all locales!");
  process.exit(0);
}

main();
