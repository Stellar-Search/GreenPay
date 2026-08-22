#!/usr/bin/env node
/**
 * scripts/check-documented-commands.js
 *
 * Guards `docs/getting-started.md` §7 (Subproject reference) against drift.
 *
 * The doc tells contributors which command to run to lint, test and build each
 * of the six subprojects. This script asserts those entry points still exist:
 * every npm script named below must be present in the relevant package.json,
 * every Makefile.contracts target must still be declared, and every path the
 * doc points at must still be there.
 *
 * It deliberately does NOT execute the commands — that needs Node, Rust and Go
 * toolchains plus a database, which is what the real CI jobs are for. This is
 * the cheap check: if someone renames `test:e2e` or drops a Makefile target,
 * the doc stops being true and this fails.
 *
 * Usage: node scripts/check-documented-commands.js
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DOC = "docs/getting-started.md";

// npm scripts that docs/getting-started.md §7 tells contributors to run.
const NPM_SCRIPTS = {
  backend: ["dev", "start", "lint", "test", "test:local-chain", "docs"],
  frontend: ["dev", "build", "start", "lint", "type-check", "test", "test:e2e"],
  mobile: ["start", "test"],
  extension: ["dev", "build", "build:firefox", "test"],
};

// Targets documented for `make -f Makefile.contracts <target>`.
const MAKE_TARGETS = ["help", "build", "test", "lint", "fmt-check", "fmt-fix", "audit"];

// Files the doc refers to by path.
const REQUIRED_PATHS = [
  "Makefile.contracts",
  "docker-compose.yml",
  "scripts/setup-dev.sh",
  "backend/.eslintrc.json",
  "backend/.env.example",
  "frontend/.eslintrc.json",
  "frontend/.env.example",
  "frontend/playwright.config.ts",
  "contracts/Cargo.toml",
  "contracts/rust-toolchain.toml",
  "extension/tsconfig.json",
  "scheduler/go.mod",
];

const failures = [];

for (const [subproject, scripts] of Object.entries(NPM_SCRIPTS)) {
  const manifest = path.join(ROOT, subproject, "package.json");
  if (!fs.existsSync(manifest)) {
    failures.push(`${subproject}/package.json is missing`);
    continue;
  }
  const declared = JSON.parse(fs.readFileSync(manifest, "utf8")).scripts || {};
  for (const script of scripts) {
    if (!declared[script]) {
      failures.push(
        `${subproject}/package.json has no "${script}" script, but ${DOC} documents ` +
          `\`npm run ${script}\` for ${subproject}/`
      );
    }
  }
}

const makefile = path.join(ROOT, "Makefile.contracts");
if (!fs.existsSync(makefile)) {
  failures.push("Makefile.contracts is missing");
} else {
  const contents = fs.readFileSync(makefile, "utf8");
  for (const target of MAKE_TARGETS) {
    const declared = new RegExp(`^${target}:`, "m").test(contents);
    if (!declared) {
      failures.push(
        `Makefile.contracts has no "${target}" target, but ${DOC} documents ` +
          `\`make -f Makefile.contracts ${target}\``
      );
    }
  }
}

for (const relative of REQUIRED_PATHS) {
  if (!fs.existsSync(path.join(ROOT, relative))) {
    failures.push(`${relative} is missing, but ${DOC} refers to it`);
  }
}

if (failures.length > 0) {
  console.error(`✖ ${DOC} is out of date with the repo:\n`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  console.error(
    `\nUpdate ${DOC} §7 (and this script's lists) so the documented commands ` +
      "match what the tooling actually provides."
  );
  process.exit(1);
}

console.log(
  `✅ ${DOC} §7 is consistent with the repo — ` +
    `${Object.values(NPM_SCRIPTS).flat().length} npm scripts, ` +
    `${MAKE_TARGETS.length} make targets and ` +
    `${REQUIRED_PATHS.length} paths verified.`
);
