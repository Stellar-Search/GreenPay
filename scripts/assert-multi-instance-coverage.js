#!/usr/bin/env node
/**
 * scripts/assert-multi-instance-coverage.js
 *
 * Fails the build if the multi-replica realtime suite did not actually run.
 *
 * The suite skips itself when no Redis is reachable, so that `npm test` still
 * works on a developer machine with nothing else installed. That is convenient
 * locally and dangerous in CI: a missing service, a renamed env var, or a
 * health-check change would silently retire the only test proving that an event
 * emitted by one backend process reaches clients connected to another — and a
 * skipped test reports as a green build.
 *
 * The bug this all exists to prevent survived for exactly that reason: nothing
 * errored, and no test failed. A guarantee that can quietly stop being checked
 * is not a guarantee, so this asserts the suite ran, passed, and spawned more
 * than one process.
 */
"use strict";

const path = require("path");
const { spawnSync } = require("child_process");

const BACKEND_DIR = path.join(__dirname, "..", "backend");
const SUITE = "test/realtime.multiInstance.test.js";

// The suite proves cross-replica delivery, so a single instance can never
// satisfy it. Named here so the requirement is explicit rather than implied.
const MINIMUM_INSTANCES = 2;

function main() {
  const result = spawnSync(
    "npx",
    ["jest", SUITE, "--runInBand", "--json", "--testLocationInResults"],
    { cwd: BACKEND_DIR, encoding: "utf8", env: process.env, maxBuffer: 32 * 1024 * 1024 },
  );

  const report = parseReport(result.stdout);
  if (!report) {
    fail("could not parse the jest report", result.stderr || result.stdout);
  }

  const suite = (report.testResults || []).find((entry) => entry.name.endsWith(path.normalize(SUITE)));
  if (!suite) {
    fail(`jest did not run ${SUITE}`, result.stderr);
  }

  const assertions = suite.assertionResults || [];
  const skipped = assertions.filter((a) => a.status === "pending" || a.status === "skipped");
  const passed = assertions.filter((a) => a.status === "passed");
  const failed = assertions.filter((a) => a.status === "failed");

  if (assertions.length === 0 || skipped.length === assertions.length) {
    fail(
      "the multi-replica realtime suite was skipped, so cross-replica delivery is unproven.\n" +
      "  It skips when no Redis is reachable. In CI that means the redis service is missing,\n" +
      "  unhealthy, or REDIS_URL does not point at it.",
      `REDIS_URL=${process.env.REDIS_URL || "(unset)"}`,
    );
  }

  if (failed.length > 0) {
    fail(
      `${failed.length} multi-replica test(s) failed`,
      failed.map((a) => `  ✗ ${a.fullName}`).join("\n"),
    );
  }

  // The suite asserts distinct pids itself; this confirms that assertion is
  // among the tests that ran, so the guard cannot pass on a suite that was
  // gutted down to trivial cases.
  const provesMultipleProcesses = passed.some((a) => /separate processes/i.test(a.fullName));
  if (!provesMultipleProcesses) {
    fail(
      `no passing test asserted that at least ${MINIMUM_INSTANCES} separate backend processes were started`,
      passed.map((a) => `  ✓ ${a.fullName}`).join("\n"),
    );
  }

  console.log(
    `✅ multi-replica realtime coverage ran: ${passed.length} passed, ${skipped.length} skipped ` +
    `(≥${MINIMUM_INSTANCES} backend processes proven).`,
  );
}

/**
 * Jest writes its JSON report to stdout, but anything the tests log lands there
 * too, so the report is found rather than assumed to be the whole stream.
 */
function parseReport(stdout) {
  if (!stdout) return null;
  const start = stdout.indexOf('{"numFailedTestSuites"');
  const candidate = start === -1 ? stdout.trim() : stdout.slice(start);
  try {
    return JSON.parse(candidate);
  } catch {
    for (const line of stdout.split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.testResults) return parsed;
      } catch {
        // not the report line
      }
    }
    return null;
  }
}

function fail(message, detail) {
  console.error(`❌ ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

main();
