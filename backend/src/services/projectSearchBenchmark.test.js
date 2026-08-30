"use strict";

const {
  percentile,
  parseArgs,
  LATENCY_BUDGET_MS,
} = require("../../scripts/benchmark-project-search");

describe("benchmark-project-search helpers", () => {
  it("parseArgs reads iterations and search term", () => {
    const opts = parseArgs(["--iterations=25", "--search=solar", "--limit=20"]);
    expect(opts.iterations).toBe(25);
    expect(opts.search).toBe("solar");
    expect(opts.limit).toBe(20);
  });

  it("percentile returns median for odd-length arrays", () => {
    expect(percentile([10, 20, 30], 50)).toBe(20);
  });

  it("percentile returns high tail value at p99", () => {
    const sorted = [1, 2, 3, 4, 100];
    expect(percentile(sorted, 99)).toBe(100);
  });

  it("exports latency budget constant", () => {
    expect(LATENCY_BUDGET_MS).toBe(150);
  });
});
