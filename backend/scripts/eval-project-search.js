#!/usr/bin/env node
"use strict";

/**
 * Run labelled-query ranking evaluation against live Postgres search.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/eval-project-search.js
 */

require("dotenv").config();

const pool = require("../src/db/pool");
const { searchProjects } = require("../src/services/projectSearch");
const { DEFAULT_RANKING } = require("../src/config/searchRanking");
const { evaluateRanking } = require("../src/services/projectSearchEval");

async function main() {
  const report = await evaluateRanking(async (query) => {
    const { rows } = await searchProjects(pool, { search: query, limit: 10 }, DEFAULT_RANKING);
    return rows.map((r) => ({ id: r.id }));
  }, { minNdcg: 0.4, k: 5 });

  console.log(JSON.stringify(report, null, 2));

  const failed = report.cases.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.error(`Ranking evaluation failed for ${failed.length} labelled queries.`);
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end());
