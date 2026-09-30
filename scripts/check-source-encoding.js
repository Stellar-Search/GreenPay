#!/usr/bin/env node
/**
 * scripts/check-source-encoding.js
 *
 * Fails when a tracked source file is not valid UTF-8, or contains NUL bytes.
 *
 * A donate-screen test file was once committed as UTF-8 for 494 lines and then
 * UTF-16LE for the remainder, the result of appending through a Windows
 * redirect. Babel could not parse it, so the entire suite errored out and the
 * production bugs it covered stayed hidden. Nothing detected that, because the
 * file still looked like text in a diff.
 */
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");

const EXTS = [
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".json", ".md", ".yml", ".yaml", ".rs", ".go",
  ".sh", ".sql", ".css", ".html", ".toml",
];

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { maxBuffer: 64 * 1024 * 1024 })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const problems = [];

for (const file of trackedFiles()) {
  if (!EXTS.some((e) => file.endsWith(e))) continue;

  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    continue; // deleted or unreadable in this checkout
  }

  const nul = buf.indexOf(0);
  if (nul !== -1) {
    const line = buf.subarray(0, nul).toString("latin1").split("\n").length;
    problems.push(`${file}:${line}  contains a NUL byte (likely UTF-16 content)`);
    continue;
  }

  try {
    decoder.decode(buf);
  } catch {
    problems.push(`${file}  is not valid UTF-8`);
  }
}

if (problems.length > 0) {
  console.error("Source files must be UTF-8 without NUL bytes:\n");
  for (const p of problems) console.error(`  ${p}`);
  console.error(`\n${problems.length} file(s) failed.`);
  process.exit(1);
}

console.log(`Encoding check passed (${trackedFiles().length} tracked files scanned).`);
