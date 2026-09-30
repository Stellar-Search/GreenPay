"use strict";

/**
 * Latency benchmark for project search against Postgres.
 *
 * Usage:
 *   node backend/scripts/benchmark-project-search.js [--iterations=50] [--search=reforestation]
 */

const { Pool } = require("pg");
const { searchProjects } = require("../src/services/projectSearch");

const DEFAULT_ITERATIONS = 50;
const LATENCY_BUDGET_MS = 150;

function parseArgs(argv) {
  const opts = {
    iterations: DEFAULT_ITERATIONS,
    search: "",
    limit: 50,
  };

  for (const arg of argv) {
    if (arg.startsWith("--iterations=")) {
      opts.iterations = Number.parseInt(arg.split("=")[1], 10) || DEFAULT_ITERATIONS;
    } else if (arg.startsWith("--search=")) {
      opts.search = arg.slice("--search=".length);
    } else if (arg.startsWith("--limit=")) {
      opts.limit = Number.parseInt(arg.split("=")[1], 10) || 50;
    }
  }
  return opts;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/**
 * Run repeated search queries and collect latency statistics.
 */
async function runBenchmark(pool, options) {
  const latencies = [];

  for (let i = 0; i < options.iterations; i += 1) {
    const start = performance.now();
    await searchProjects(pool, {
      search: options.search,
      limit: options.limit,
    });
    latencies.push(performance.now() - start);
  }

  latencies.sort((a, b) => a - b);
  const sum = latencies.reduce((acc, v) => acc + v, 0);

  return {
    iterations: options.iterations,
    search: options.search || null,
    limit: options.limit,
    minMs: latencies[0],
    maxMs: latencies[latencies.length - 1],
    meanMs: sum / latencies.length,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
    overBudgetCount: latencies.filter((ms) => ms > LATENCY_BUDGET_MS).length,
    latencyBudgetMs: LATENCY_BUDGET_MS,
  };
}

function formatReport(stats) {
  const lines = [
    "Project search benchmark",
    "========================",
    `Iterations: ${stats.iterations}`,
    `Search term: ${stats.search ?? "(none)"}`,
    `Limit: ${stats.limit}`,
    "",
    `Min:    ${stats.minMs.toFixed(2)} ms`,
    `Mean:   ${stats.meanMs.toFixed(2)} ms`,
    `p50:    ${stats.p50Ms.toFixed(2)} ms`,
    `p95:    ${stats.p95Ms.toFixed(2)} ms`,
    `p99:    ${stats.p99Ms.toFixed(2)} ms`,
    `Max:    ${stats.maxMs.toFixed(2)} ms`,
    "",
    `Budget: ${stats.latencyBudgetMs} ms`,
    `Over budget: ${stats.overBudgetCount}/${stats.iterations}`,
  ];
  return lines.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const stats = await runBenchmark(pool, opts);
    console.log(formatReport(stats));
    if (stats.p95Ms > LATENCY_BUDGET_MS) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  runBenchmark,
  percentile,
  LATENCY_BUDGET_MS,
  parseArgs,
};
