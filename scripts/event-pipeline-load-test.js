#!/usr/bin/env node
"use strict";

/**
 * Event-sourcing pipeline load test.
 *
 * Replays donation spikes through the real event store and projection code
 * (backend/src/eventSourcing) against an in-memory `event_stream` on a virtual
 * clock, and reports ingestion-to-projection catch-up latency, peak backlog and
 * sustained projection throughput. Unlike scripts/load-test.js (k6, HTTP layer)
 * this exercises the asynchronous half of the pipeline, which no HTTP metric
 * covers: the API can accept donations far faster than projections apply them.
 *
 * Usage:
 *   node scripts/event-pipeline-load-test.js
 *   node scripts/event-pipeline-load-test.js --rates 100,200,400 --seconds 120
 *   node scripts/event-pipeline-load-test.js --latency 3 --format markdown
 *
 * Options:
 *   --rates <list>    donation arrival rates per second (default 50,100,150,200,400,800)
 *   --seconds <n>     spike duration in seconds (default 60)
 *   --latency <ms>    simulated statement round trip (default 1.2; use the p50 of
 *                     `pg_stat_statements` on the target database)
 *   --mode <m>        static | adaptive | both (default both)
 *   --max-minutes <n> declare the backlog unbounded past this virtual time (default 30)
 *   --format <f>      table | markdown | json (default table)
 *
 * Exit code is 1 if any scenario failed to drain within --max-minutes.
 */

const path = require("path");

const HARNESS = path.join(__dirname, "..", "backend", "src", "eventSourcing", "loadHarness.js");
let runBurstScenario;
try {
  ({ runBurstScenario } = require(HARNESS));
} catch (err) {
  console.error("Failed to load the harness. Run `npm install` in backend/ first.");
  console.error(err.message);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    rates: [50, 100, 150, 200, 400, 800],
    seconds: 60,
    latency: 1.2,
    mode: "both",
    maxMinutes: 30,
    format: "table",
  };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    switch (flag) {
    case "--rates":
      args.rates = value.split(",").map((r) => Number.parseFloat(r.trim())).filter((r) => r > 0);
      break;
    case "--seconds":
      args.seconds = Number.parseFloat(value);
      break;
    case "--latency":
      args.latency = Number.parseFloat(value);
      break;
    case "--mode":
      args.mode = value;
      break;
    case "--max-minutes":
      args.maxMinutes = Number.parseFloat(value);
      break;
    case "--format":
      args.format = value;
      break;
    default:
      throw new Error(`Unknown option ${flag}`);
    }
  }
  if (!["static", "adaptive", "both"].includes(args.mode)) {
    throw new Error(`--mode must be static, adaptive or both (got ${args.mode})`);
  }
  if (!["table", "markdown", "json"].includes(args.format)) {
    throw new Error(`--format must be table, markdown or json (got ${args.format})`);
  }
  return args;
}

function formatMs(value) {
  if (value === null || value === undefined) return "n/a";
  if (value >= 1000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.round(value)} ms`;
}

function toRow(result) {
  return {
    Mode: result.label,
    "Rate/s": result.config.arrivalRatePerSec,
    Donations: result.config.donations,
    Drained: result.drained ? "yes" : "NO",
    "Catch-up": result.drained ? formatMs(result.catchUpMs) : "unbounded",
    "p95 lag": formatMs(result.lagMs.p95),
    "Max lag": formatMs(result.lagMs.max),
    "Peak backlog": result.peakBacklog,
    "Throughput/s": result.sustainedThroughputPerSec,
  };
}

function printMarkdown(rows) {
  const headers = Object.keys(rows[0]);
  console.log(`| ${headers.join(" | ")} |`);
  console.log(`|${headers.map(() => "---").join("|")}|`);
  for (const row of rows) {
    console.log(`| ${headers.map((h) => String(row[h])).join(" | ")} |`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const modes = args.mode === "both" ? [false, true] : [args.mode === "adaptive"];

  console.log(
    `Event-sourcing pipeline load test: ${args.seconds}s spikes, ` +
      `${args.latency} ms simulated statement latency, ` +
      `rates ${args.rates.join(", ")}/s`
  );
  console.log("");

  const results = [];
  for (const rate of args.rates) {
    for (const adaptive of modes) {
      const result = await runBurstScenario({
        donations: Math.round(rate * args.seconds),
        spikeDurationMs: args.seconds * 1000,
        adaptive,
        queryLatencyMs: args.latency,
        maxVirtualMs: args.maxMinutes * 60 * 1000,
      });
      results.push(result);
    }
  }

  if (args.format === "json") {
    console.log(JSON.stringify(results, null, 2));
  } else if (args.format === "markdown") {
    printMarkdown(results.map(toRow));
  } else {
    console.table(results.map(toRow));
  }

  const stuck = results.filter((r) => !r.drained);
  if (stuck.length > 0) {
    console.error("");
    console.error(
      `${stuck.length} scenario(s) did not drain within ${args.maxMinutes} minutes: ` +
        stuck.map((r) => `${r.label}@${r.config.arrivalRatePerSec}/s`).join(", ")
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
