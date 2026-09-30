"use strict";

const {
  ProjectSearchAnalytics,
  snapshotFromMeta,
  SLOW_QUERY_MS,
} = require("./projectSearchAnalytics");

describe("projectSearchAnalytics", () => {
  const sampleMeta = {
    total: 12,
    search: "forest",
    latencyMs: 42,
    facets: {
      category: { Reforestation: 5, "Solar Energy": 3 },
      status: { active: 10 },
      location: { Brazil: 4 },
      fundingProgress: { under25: 2 },
    },
  };

  it("snapshotFromMeta captures latency and filter context", () => {
    const snap = snapshotFromMeta(sampleMeta, { category: "Reforestation" });
    expect(snap).toMatchObject({
      total: 12,
      latencyMs: 42,
      slow: false,
      searchPresent: true,
      filters: { category: "Reforestation" },
    });
  });

  it("flags slow queries above budget", () => {
    const snap = snapshotFromMeta({ ...sampleMeta, latencyMs: SLOW_QUERY_MS + 1 });
    expect(snap.slow).toBe(true);
  });

  it("ProjectSearchAnalytics aggregates mean latency and rates", () => {
    const analytics = new ProjectSearchAnalytics(10);
    analytics.record(sampleMeta, { category: "Reforestation" });
    analytics.record({ ...sampleMeta, search: null, latencyMs: 200 }, {});

    const summary = analytics.getSummary();
    expect(summary.count).toBe(2);
    expect(summary.meanLatencyMs).toBe(121);
    expect(summary.slowQueryRate).toBe(0.5);
    expect(summary.textSearchRate).toBe(0.5);
    expect(summary.topCategories[0]).toEqual({ category: "Reforestation", count: 1 });
  });

  it("reset clears recorded entries", () => {
    const analytics = new ProjectSearchAnalytics();
    analytics.record(sampleMeta, {});
    analytics.reset();
    expect(analytics.getSummary().count).toBe(0);
  });
});
