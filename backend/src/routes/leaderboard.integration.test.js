"use strict";

/**
 * Real-Postgres proof that GET /api/leaderboard's rank, tie-break, and total
 * math are correct — a mocked pool (leaderboard.test.js) can exercise the SQL
 * text but can't prove ROW_NUMBER() actually produces absolute, non-repeating
 * ranks across pages or that ties resolve deterministically by public_key.
 *
 * Requires a reachable Postgres — e.g. `docker compose up postgres` — at
 * DATABASE_URL (defaults to the same postgres://postgres:postgres@localhost:5432/greenpay
 * used by docker-compose.yml and CI's `integration` job). When no database is
 * reachable, every test in this file is skipped rather than failed, so it
 * never blocks a plain `npm test` run in an environment without Postgres.
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { execFileSync } = require("child_process");
const { v4: uuid } = require("uuid");
const { createHash } = require("crypto");

const pool = require("../db/pool");
const { apiEnvelope, errorHandler } = require("../middleware/apiEnvelope");

jest.setTimeout(20000);

const SCHEMA_PATH = path.join(__dirname, "..", "db", "schema.sql");
const CONNECTIVITY_TIMEOUT_MS = 5000;
const DEFAULT_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/greenpay";

/**
 * Jest registers `test`/`test.skip` synchronously while the file's top-level
 * code runs, before any `beforeAll` executes — so the skip/run decision can't
 * live in a variable that only gets its real value inside `beforeAll` (that
 * pattern silently skips every test unconditionally, DB reachable or not).
 * This runs the connectivity probe in a child process via `execFileSync`,
 * which blocks the parent until it exits, giving a synchronous answer in
 * time for `describe`/`test` registration below.
 */
function checkDbAvailableSync() {
  const databaseUrl = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
  const probeScript = `
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: ${JSON.stringify(databaseUrl)}, connectionTimeoutMillis: ${CONNECTIVITY_TIMEOUT_MS} });
    pool.query("SELECT 1")
      .then(() => { pool.end(); process.exit(0); })
      .catch(() => { process.exit(1); });
  `;
  try {
    execFileSync(process.execPath, ["-e", probeScript], {
      stdio: "ignore",
      timeout: CONNECTIVITY_TIMEOUT_MS + 2000,
      cwd: __dirname,
    });
    return true;
  } catch {
    return false;
  }
}

const dbAvailable = checkDbAvailableSync();
const maybeTest = dbAvailable ? test : test.skip;

if (!dbAvailable) {
  // eslint-disable-next-line no-console
  console.warn(
    `[leaderboard.integration.test] Skipping — no reachable Postgres at ${
      process.env.DATABASE_URL || `${DEFAULT_DATABASE_URL} (default)`
    }. Run "docker compose up postgres" (or set DATABASE_URL) to exercise these tests.`
  );
}

// Astronomically large relative to any realistic (or other test's) donation
// total, so these rows are guaranteed to sort at the very top of the
// leaderboard regardless of whatever else exists in the table.
const TIE_TOTAL = "999999999.0000000";
const BELOW_TIE_TOTAL = "999999998.0000000";

const { Keypair } = require("@stellar/stellar-sdk");
const _sortedKeys = Array.from({ length: 10 }, () => Keypair.random().publicKey()).sort();
const KEY_TIE_LOW = _sortedKeys[0]; // sorts before KEY_TIE_HIGH on the tie-break
const KEY_TIE_HIGH = _sortedKeys[1];
const KEY_THIRD = _sortedKeys[2];

const KEY_IN_WINDOW = _sortedKeys[3];
const KEY_OUT_OF_WINDOW = _sortedKeys[4];
const KEY_OTHER = _sortedKeys[5];

function makeTxHash(seed) {
  return createHash("sha256").update(seed).digest("hex");
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use("/api/leaderboard", require("./leaderboard"));
  app.use(errorHandler);
  return app;
}

async function insertProfile(publicKey, displayName) {
  await pool.query(
    `INSERT INTO profiles (public_key, display_name) VALUES ($1, $2)
     ON CONFLICT (public_key) DO NOTHING`,
    [publicKey, displayName]
  );
}

async function deleteDonorStatsFixture(publicKeys) {
  await pool.query("DELETE FROM donor_stats WHERE public_key = ANY($1)", [publicKeys]);
  await pool.query("DELETE FROM profiles WHERE public_key = ANY($1)", [publicKeys]);
}

beforeAll(async () => {
  if (!dbAvailable) return;
  const schemaSql = fs.readFileSync(SCHEMA_PATH, "utf8");
  await pool.query(schemaSql);
});

afterAll(async () => {
  if (dbAvailable) {
    await pool.end();
  }
});

describe("GET /api/leaderboard real-Postgres behavior", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  maybeTest(
    "period=all: rank is absolute across pages and ties break deterministically by public_key",
    async () => {
      const keys = [KEY_TIE_LOW, KEY_TIE_HIGH, KEY_THIRD];

      try {
        for (const key of keys) {
          await insertProfile(key, `Donor ${key.slice(0, 4)}`);
        }
        await pool.query(
          `INSERT INTO donor_stats (public_key, total_donated_xlm, projects_supported, badges) VALUES
             ($1, $4::numeric, 1, '[]'::jsonb),
             ($2, $4::numeric, 1, '[]'::jsonb),
             ($3, $5::numeric, 1, '[]'::jsonb)`,
          [KEY_TIE_LOW, KEY_TIE_HIGH, KEY_THIRD, TIE_TOTAL, BELOW_TIE_TOTAL]
        );

        const expectedTotalRes = await pool.query("SELECT COUNT(*) AS total FROM donor_stats");
        const expectedTotal = expectedTotalRes.rows[0].total;

        const page1 = await request(app).get("/api/leaderboard").query({ period: "all", limit: 2, offset: 0 });
        expect(page1.status).toBe(200);
        expect(page1.body.meta.pagination).toMatchObject({ total: Number(expectedTotal), limit: 2, offset: 0 });
        expect(page1.body.data).toEqual([
          expect.objectContaining({ rank: 1, publicKey: KEY_TIE_LOW }),
          expect.objectContaining({ rank: 2, publicKey: KEY_TIE_HIGH }),
        ]);

        const page2 = await request(app).get("/api/leaderboard").query({ period: "all", limit: 2, offset: 2 });
        expect(page2.status).toBe(200);
        expect(page2.body.meta.pagination).toMatchObject({ total: Number(expectedTotal), limit: 2, offset: 2 });
        expect(page2.body.data[0]).toMatchObject({ rank: 3, publicKey: KEY_THIRD });
      } finally {
        await deleteDonorStatsFixture(keys);
      }
    }
  );

  maybeTest(
    "period=month: excludes donations outside the window but still ranks, tie-breaks, and counts every profile",
    async () => {
      const projectId = uuid();
      const keys = [KEY_IN_WINDOW, KEY_OUT_OF_WINDOW];

      try {
        await pool.query(
          `INSERT INTO projects (id, name, description, category, location, wallet_address, goal_xlm, raised_xlm, donor_count, status)
           VALUES ($1, 'Leaderboard Integration Test Project', 'Seeded by leaderboard.integration.test.js', 'environment', 'Test Location', $2, 1000, 0, 0, 'active')`,
          [projectId, KEY_OTHER]
        );

        for (const key of keys) {
          await insertProfile(key, `Donor ${key.slice(0, 4)}`);
        }

        await pool.query(
          `INSERT INTO donations (id, project_id, donor_address, amount_xlm, amount, currency, transaction_hash, idempotency_key, status, created_at)
           VALUES ($1, $2, $3, $5::numeric, $5::numeric, 'XLM', $4, $4, 'committed', NOW())`,
          [uuid(), projectId, KEY_IN_WINDOW, makeTxHash(`in-window-${projectId}`), TIE_TOTAL]
        );
        await pool.query(
          `INSERT INTO donations (id, project_id, donor_address, amount_xlm, amount, currency, transaction_hash, idempotency_key, status, created_at)
           VALUES ($1, $2, $3, $5::numeric, $5::numeric, 'XLM', $4, $4, 'committed', NOW() - INTERVAL '60 days')`,
          [uuid(), projectId, KEY_OUT_OF_WINDOW, makeTxHash(`out-of-window-${projectId}`), TIE_TOTAL]
        );

        const expectedTotalRes = await pool.query("SELECT COUNT(*) AS total FROM profiles");
        const expectedTotal = expectedTotalRes.rows[0].total;

        const res = await request(app).get("/api/leaderboard").query({ period: "month", limit: 200, offset: 0 });
        expect(res.status).toBe(200);
        expect(res.body.meta.pagination).toMatchObject({ total: Number(expectedTotal), limit: 200, offset: 0 });

        const inWindowEntry = res.body.data.find((e) => e.publicKey === KEY_IN_WINDOW);
        const outOfWindowEntry = res.body.data.find((e) => e.publicKey === KEY_OUT_OF_WINDOW);

        expect(inWindowEntry.totalDonatedXLM).toBe(TIE_TOTAL);
        expect(outOfWindowEntry.totalDonatedXLM).toBe("0");
        expect(inWindowEntry.rank).toBeLessThan(outOfWindowEntry.rank);
      } finally {
        await pool.query("DELETE FROM donations WHERE project_id = $1", [projectId]);
        await deleteDonorStatsFixture(keys);
        await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
      }
    }
  );
});
