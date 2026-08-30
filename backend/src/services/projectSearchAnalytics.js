"use strict";

/**
 * Lightweight search analytics: aggregate facet usage and slow-query signals.
 *
 * Intended for admin dashboards or periodic log aggregation — not hot-path middleware.
 */

const SLOW_QUERY_MS = 150;

/**
 * Build a snapshot from a single search response meta object.
 */
function snapshotFromMeta(meta, filters = {}) {
  if (!meta || typeof meta !== "object") {
    return null;
  }

  return {
    timestamp: new Date().toISOString(),
    total: meta.total ?? 0,
    latencyMs: meta.latencyMs ?? 0,
    slow: (meta.latencyMs ?? 0) > SLOW_QUERY_MS,
    searchPresent: Boolean(meta.search && meta.search.length > 0),
    filters: {
      category: filters.category ?? null,
      status: filters.status ?? null,
      verified: filters.verified ?? null,
    },
    facetCardinality: {
      category: Object.keys(meta.facets?.category ?? {}).length,
      status: Object.keys(meta.facets?.status ?? {}).length,
      location: Object.keys(meta.facets?.location ?? {}).length,
      fundingProgress: Object.keys(meta.facets?.fundingProgress ?? {}).length,
    },
  };
}

/**
 * In-memory rolling window for development and unit tests.
 */
class ProjectSearchAnalytics {
  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries;
    this.entries = [];
  }

  record(meta, filters) {
    const snap = snapshotFromMeta(meta, filters);
    if (!snap) return;
    this.entries.push(snap);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  getSummary() {
    if (this.entries.length === 0) {
      return {
        count: 0,
        meanLatencyMs: 0,
        slowQueryRate: 0,
        textSearchRate: 0,
        topCategories: [],
      };
    }

    const latencies = this.entries.map((e) => e.latencyMs);
    const meanLatencyMs =
      latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const slowCount = this.entries.filter((e) => e.slow).length;
    const textCount = this.entries.filter((e) => e.searchPresent).length;

    const categoryHits = {};
    for (const entry of this.entries) {
      const cat = entry.filters.category;
      if (cat) {
        categoryHits[cat] = (categoryHits[cat] ?? 0) + 1;
      }
    }

    const topCategories = Object.entries(categoryHits)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([category, count]) => ({ category, count }));

    return {
      count: this.entries.length,
      meanLatencyMs: Math.round(meanLatencyMs * 100) / 100,
      slowQueryRate: slowCount / this.entries.length,
      textSearchRate: textCount / this.entries.length,
      topCategories,
    };
  }

  reset() {
    this.entries = [];
  }
}

module.exports = {
  SLOW_QUERY_MS,
  snapshotFromMeta,
  ProjectSearchAnalytics,
};
