"use strict";

/**
 * Tunable ranking signals for project search.
 *
 * Weights are explicit configuration — not hardcoded in SQL — so product can
 * adjust discovery without rewriting queries. Override via env JSON:
 *   PROJECT_SEARCH_RANKING='{"verifiedBoost":0.2}'
 */
const DEFAULT_RANKING = Object.freeze({
  /** ts_rank_cd + trigram similarity combined text score */
  textRelevance: 1.0,
  /** Boost for admin-verified projects */
  verifiedBoost: 0.15,
  /** Boost scaled by raised_xlm / goal_xlm (capped at 1) */
  fundingProgressBoost: 0.1,
  /** Boost scaled by log(donor_count + 1) / log(101) */
  donorCountBoost: 0.05,
  /** Trigram similarity multiplier on project name (typo tolerance) */
  trigramWeight: 0.3,
});

function loadRankingConfig() {
  const raw = (process.env.PROJECT_SEARCH_RANKING || "").trim();
  if (!raw) return { ...DEFAULT_RANKING };

  try {
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_RANKING, ...parsed };
  } catch {
    return { ...DEFAULT_RANKING };
  }
}

/** Documented latency budget for search at ~1k projects (milliseconds). */
const SEARCH_LATENCY_BUDGET_MS = 150;

module.exports = {
  DEFAULT_RANKING,
  SEARCH_LATENCY_BUDGET_MS,
  loadRankingConfig,
};
