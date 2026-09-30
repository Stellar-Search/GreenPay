"use strict";

/**
 * Backfill `search_vector` for existing projects after schema migration.
 *
 * Usage:
 *   node backend/scripts/backfill-project-search.js [--batch=500] [--dry-run]
 */

const { Pool } = require("pg");

const DEFAULT_BATCH = 500;

function parseArgs(argv) {
  const opts = { batch: DEFAULT_BATCH, dryRun: false };
  for (const arg of argv) {
    if (arg.startsWith("--batch=")) {
      opts.batch = Number.parseInt(arg.split("=")[1], 10) || DEFAULT_BATCH;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    }
  }
  return opts;
}

/**
 * Count projects missing a populated search_vector.
 */
async function countPending(pool) {
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM projects
    WHERE search_vector IS NULL
       OR search_vector = ''::tsvector
  `);
  return rows[0]?.count ?? 0;
}

/**
 * Update one batch of projects using the same weighting as the live trigger.
 */
async function backfillBatch(pool, batchSize, dryRun) {
  const selectSql = `
    SELECT id
    FROM projects
    WHERE search_vector IS NULL OR search_vector = ''::tsvector
    ORDER BY created_at ASC
    LIMIT $1
  `;
  const { rows } = await pool.query(selectSql, [batchSize]);
  if (rows.length === 0) {
    return { updated: 0, ids: [] };
  }

  const ids = rows.map((r) => r.id);
  if (dryRun) {
    return { updated: ids.length, ids };
  }

  const updateSql = `
    UPDATE projects p
    SET search_vector =
      setweight(to_tsvector('english', coalesce(p.name, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(p.description, '')), 'B') ||
      setweight(to_tsvector('simple', coalesce(p.category, '')), 'C') ||
      setweight(to_tsvector('simple', coalesce(p.location, '')), 'C') ||
      setweight(to_tsvector('simple', coalesce(array_to_string(p.tags, ' '), '')), 'D')
    WHERE p.id = ANY($1::uuid[])
  `;
  await pool.query(updateSql, [ids]);
  return { updated: ids.length, ids };
}

/**
 * Run backfill until no pending rows remain or batch returns zero.
 */
async function runBackfill(pool, options) {
  const summary = { totalUpdated: 0, batches: 0, dryRun: options.dryRun };
  let pending = await countPending(pool);

  while (pending > 0) {
    const { updated } = await backfillBatch(pool, options.batch, options.dryRun);
    if (updated === 0) break;
    summary.totalUpdated += updated;
    summary.batches += 1;
    if (options.dryRun) break;
    pending = await countPending(pool);
  }

  summary.remaining = await countPending(pool);
  return summary;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const before = await countPending(pool);
    console.log(`Projects pending backfill: ${before}`);

    const summary = await runBackfill(pool, opts);
    console.log(JSON.stringify(summary, null, 2));

    if (summary.remaining > 0 && !opts.dryRun) {
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
  countPending,
  backfillBatch,
  runBackfill,
  parseArgs,
};
