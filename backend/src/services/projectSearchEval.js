"use strict";

/**
 * Labelled-query evaluation harness for project search ranking.
 *
 * Each case specifies a query and expected project IDs in priority order.
 * The harness measures nDCG@k and reports regressions when ranking changes.
 */

const LABELLED_QUERIES = Object.freeze([
  {
    id: "reforestation-primary",
    query: "reforestation",
    description: "Reforestation-focused project should outrank passing mention",
    expectedOrder: ["reforest-delta", "general-green"],
  },
  {
    id: "solar-energy",
    query: "solar",
    description: "Solar category project ranks above unrelated",
    expectedOrder: ["solar-farm", "wind-coast"],
  },
  {
    id: "typo-tolerance",
    query: "reforstation",
    description: "Trigram typo tolerance surfaces reforestation project",
    expectedOrder: ["reforest-delta"],
  },
  {
    id: "location-match",
    query: "amazon",
    description: "Location keyword match",
    expectedOrder: ["amazon-canopy"],
  },
  {
    id: "verified-boost",
    query: "water",
    description: "Verified clean water project preferred when text ties",
    expectedOrder: ["clean-water-verified", "clean-water-unverified"],
  },
  {
    id: "wind-category",
    query: "wind turbine",
    description: "Wind energy projects rank for turbine-related queries",
    expectedOrder: ["wind-coast", "solar-farm"],
  },
  {
    id: "carbon-capture-stem",
    query: "capturing carbon",
    description: "English stemming matches carbon capture category projects",
    expectedOrder: ["carbon-direct", "general-green"],
  },
  {
    id: "multilingual-simple",
    query: "agua limpia",
    description: "Simple tokenizer matches Spanish keywords without english stem",
    expectedOrder: ["agua-limpia-es"],
  },
  {
    id: "tag-match",
    query: "mangrove",
    description: "Tag tokens in search_vector surface ocean conservation projects",
    expectedOrder: ["mangrove-coast"],
  },
  {
    id: "combined-filter-rank",
    query: "solar brazil",
    description: "Multi-token query prefers location + category overlap",
    expectedOrder: ["solar-brazil", "solar-farm"],
  },
]);

/**
 * Discounted cumulative gain at k for a ranked result list.
 */
function dcgAtK(relevanceScores, k) {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, relevanceScores.length); i += 1) {
    const rel = relevanceScores[i];
    if (rel <= 0) continue;
    dcg += (2 ** rel - 1) / Math.log2(i + 2);
  }
  return dcg;
}

/**
 * Compute nDCG@k given actual ranked IDs and expected priority list.
 */
function ndcgAtK(actualIds, expectedOrder, k = 5) {
  const relevanceFor = (id) => {
    const idx = expectedOrder.indexOf(id);
    if (idx === -1) return 0;
    return Math.max(1, expectedOrder.length - idx);
  };

  const actualRelevance = actualIds.map(relevanceFor);
  const idealRelevance = expectedOrder
    .map((_, i) => Math.max(1, expectedOrder.length - i))
    .sort((a, b) => b - a);

  const dcg = dcgAtK(actualRelevance, k);
  const idcg = dcgAtK(idealRelevance, k);
  if (idcg === 0) return 1;
  return dcg / idcg;
}

/**
 * Evaluate ranking quality for labelled queries against search results.
 *
 * @param {Function} searchFn - async (query) => [{ id, ... }]
 * @param {object} [options]
 * @returns {Promise<{ cases: object[], meanNdcg: number }>}
 */
async function evaluateRanking(searchFn, options = {}) {
  const k = options.k ?? 5;
  const cases = [];

  for (const labelled of LABELLED_QUERIES) {
    const results = await searchFn(labelled.query);
    const actualIds = results.map((r) => r.id);
    const score = ndcgAtK(actualIds, labelled.expectedOrder, k);

    cases.push({
      id: labelled.id,
      query: labelled.query,
      description: labelled.description,
      expectedOrder: labelled.expectedOrder,
      actualOrder: actualIds.slice(0, k),
      ndcgAtK: Number(score.toFixed(4)),
      pass: score >= (options.minNdcg ?? 0.5),
    });
  }

  const meanNdcg =
    cases.length === 0
      ? 0
      : cases.reduce((sum, c) => sum + c.ndcgAtK, 0) / cases.length;

  return {
    cases,
    meanNdcg: Number(meanNdcg.toFixed(4)),
    k,
  };
}

module.exports = {
  LABELLED_QUERIES,
  dcgAtK,
  ndcgAtK,
  evaluateRanking,
};
