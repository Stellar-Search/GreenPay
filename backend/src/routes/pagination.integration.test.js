"use strict";

/**
 * Integration & Performance Benchmark Tests for Keyset Pagination.
 *
 * Tests:
 * 1. Mid-pagination mutation safety: inserts and deletes rows between page fetches
 *    and proves zero duplicate rows and zero skipped rows.
 * 2. Deep-page latency benchmark: compares page 1 vs page 50 / 100 latency using
 *    keyset cursors vs OFFSET depth and records measurements.
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { execFileSync } = require("child_process");
const { v4: uuid } = require("uuid");

const pool = require("../db/pool");
const { apiEnvelope, errorHandler } = require("../middleware/apiEnvelope");

jest.setTimeout(30000);

const SCHEMA_PATH = path.join(__dirname, "..", "db", "schema.sql");
const CONNECTIVITY_TIMEOUT_MS = 5000;
const DEFAULT_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/greenpay";

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

const isDbAvailable = checkDbAvailableSync();
const describeIfDb = isDbAvailable ? describe : describe.skip;

// Without this the shared pool keeps the event loop alive and jest hangs after
// the last assertion, which stalls the CI step this suite runs in.
afterAll(async () => {
  if (isDbAvailable) {
    await pool.end();
  }
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use("/api/projects", require("./projects"));
  app.use("/api/donations", require("./donations"));
  app.use("/api/leaderboard", require("./leaderboard"));
  app.use(errorHandler);
  return app;
}

describeIfDb("Keyset Pagination Real-DB Integration & Latency Benchmarks", () => {
  let app;

  beforeAll(async () => {
    const schemaSql = fs.readFileSync(SCHEMA_PATH, "utf8");
    await pool.query(schemaSql);
    app = buildApp();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE donations, projects, donor_stats, profiles CASCADE;");
  });

  afterAll(async () => {
    await pool.query("TRUNCATE TABLE donations, projects, donor_stats, profiles CASCADE;");
  });

  describe("Filtered and localized pages execute against the real schema", () => {
    // The route builds its SQL by string concatenation, and every other suite
    // mocks the pool — so a query that is a perfectly good string but invalid
    // against the actual schema (a predicate qualified with an alias the FROM
    // clause never declares, say) passes every mocked test and fails on the
    // first real request. These cases exist to run each branch of that builder
    // through Postgres, which is the only thing that will reject it.
    const FILTER_CASES = [
      ["no filters", {}],
      ["status", { status: "active" }],
      ["category", { category: "Solar Energy" }],
      ["verified", { verified: "true" }],
      ["search", { search: "Reef" }],
      ["language", { lang: "es" }],
      ["every filter at once", { status: "active", category: "Solar Energy", verified: "true", search: "Reef", lang: "es" }],
    ];

    beforeEach(async () => {
      const rows = [];
      for (let i = 0; i < 6; i++) {
        rows.push(
          pool.query(
            `INSERT INTO projects (id, name, description, category, location, wallet_address, goal_xlm, status, verified, created_at)
             VALUES ($1, $2, 'Reef restoration work', 'Solar Energy', 'Loc', 'wallet', 100, 'active', true, $3)`,
            [uuid(), `Reef Project ${i}`, new Date(Date.now() - i * 1000).toISOString()]
          )
        );
      }
      await Promise.all(rows);
    });

    it.each(FILTER_CASES)("serves page one and a cursor continuation with %s", async (_label, query) => {
      const first = await request(app).get("/api/projects").query({ ...query, limit: 2 });
      expect(first.status).toBe(200);
      expect(first.body.data.length).toBeGreaterThan(0);

      const cursor = first.body.meta.nextCursor;
      expect(cursor).toBeTruthy();

      // The cursor predicate is a separate branch of the same builder, so it
      // has to be exercised against the schema too, not just page one.
      const second = await request(app).get("/api/projects").query({ ...query, limit: 2, cursor });
      expect(second.status).toBe(200);

      const firstIds = first.body.data.map((r) => r.id);
      const secondIds = second.body.data.map((r) => r.id);
      expect(secondIds.filter((id) => firstIds.includes(id))).toEqual([]);
    });

    it("rejects an unsupported language before running any query", async () => {
      const res = await request(app).get("/api/projects").query({ lang: "fr" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("CONTENT_LANGUAGE_INVALID");
    });
  });

  describe("Mid-pagination mutation safety (insert/delete between page fetches)", () => {
    it("asserts no row is duplicated or skipped when rows are inserted and deleted mid-pagination", async () => {
      // 1. Seed initial 10 projects
      const baseTime = Date.now();
      const initialProjects = [];
      for (let i = 0; i < 10; i++) {
        const id = uuid();
        const createdAt = new Date(baseTime - i * 1000).toISOString();
        const name = `Project ${10 - i}`;
        await pool.query(
          `INSERT INTO projects (id, name, description, category, location, wallet_address, goal_xlm, status, created_at)
           VALUES ($1, $2, 'desc', 'Solar Energy', 'Loc', 'wallet', 100, 'active', $3)`,
          [id, name, createdAt]
        );
        initialProjects.push({ id, name, createdAt });
      }

      // Fetch Page 1 (limit: 4)
      const page1Res = await request(app).get("/api/projects").query({ limit: 4 });
      expect(page1Res.status).toBe(200);
      expect(page1Res.body.data).toHaveLength(4);

      const page1Ids = page1Res.body.data.map((p) => p.id);
      const cursor1 = page1Res.body.meta.nextCursor;
      expect(cursor1).toBeDefined();

      // Mid-pagination mutations:
      // Insert a brand new project at top (newest timestamp) -> should NOT push rows onto Page 2
      const newTopId = uuid();
      await pool.query(
        `INSERT INTO projects (id, name, description, category, location, wallet_address, goal_xlm, status, created_at)
         VALUES ($1, 'New Top Project', 'desc', 'Solar Energy', 'Loc', 'wallet', 100, 'active', $2)`,
        [newTopId, new Date(baseTime + 5000).toISOString()]
      );

      // Insert a project right before cursor item in time -> should NOT push rows onto Page 2
      const newMidId = uuid();
      await pool.query(
        `INSERT INTO projects (id, name, description, category, location, wallet_address, goal_xlm, status, created_at)
         VALUES ($1, 'New Mid Project', 'desc', 'Solar Energy', 'Loc', 'wallet', 100, 'active', $2)`,
        [newMidId, new Date(baseTime - 1500).toISOString()]
      );

      // Delete one of the projects that was already fetched in Page 1 -> should NOT skip items on Page 2
      await pool.query("DELETE FROM projects WHERE id = $1", [page1Ids[0]]);

      // Fetch Page 2 using cursor1 from Page 1
      const page2Res = await request(app).get("/api/projects").query({ limit: 4, cursor: cursor1 });
      expect(page2Res.status).toBe(200);

      const page2Ids = page2Res.body.data.map((p) => p.id);
      const cursor2 = page2Res.body.meta.nextCursor;

      // Fetch Page 3 using cursor2 from Page 2
      const page3Res = await request(app).get("/api/projects").query({ limit: 4, cursor: cursor2 });
      expect(page3Res.status).toBe(200);
      const page3Ids = page3Res.body.data.map((p) => p.id);

      // Combine all fetched IDs across pages
      const allFetched = [...page1Ids, ...page2Ids, ...page3Ids];
      const uniqueFetched = new Set(allFetched);

      // Assert NO DUPLICATION
      expect(allFetched.length).toBe(uniqueFetched.size);

      // Assert NO SKIPPING for items that existed at cursor time
      for (let i = 4; i < 10; i++) {
        expect(allFetched).toContain(initialProjects[i].id);
      }
    });
  });

  describe("Deep-page latency: OFFSET baseline vs keyset cursor", () => {
    // The "before" number this replaces is what LIMIT/OFFSET cost at depth:
    // Postgres walks and discards every skipped row, so the same 20-row payload
    // gets steadily more expensive the deeper the page. The keyset query seeks
    // straight to the cursor tuple on idx_projects_created_at_id, so its cost
    // is flat. Both are measured here over one dataset and both are logged.
    const ROWS = 50000;
    const PAGE_SIZE = 20;
    const DEEP_OFFSET = ROWS - PAGE_SIZE * 2;
    const SAMPLES = 7;

    const ORDER = "ORDER BY created_at DESC, id DESC";

    async function medianMs(runQuery) {
      const timings = [];
      // One untimed pass so neither variant pays for a cold cache.
      await runQuery();
      for (let i = 0; i < SAMPLES; i++) {
        const t0 = process.hrtime.bigint();
        await runQuery();
        timings.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
      timings.sort((a, b) => a - b);
      return timings[Math.floor(timings.length / 2)];
    }

    it("records both measurements and holds keyset latency flat with depth", async () => {
      // Bulk-seed in one statement: 50k rows through the HTTP layer would
      // dominate the runtime, and the point of measurement is the query plan.
      await pool.query(
        `INSERT INTO projects (id, name, description, category, location, wallet_address, goal_xlm, status, created_at)
         SELECT gen_random_uuid(), 'Project ' || g, 'desc', 'Solar Energy', 'Loc', 'wallet', 100, 'active',
                NOW() - (g * INTERVAL '1 second')
         FROM generate_series(1, $1) AS g`,
        [ROWS]
      );
      await pool.query("ANALYZE projects");

      // --- before: LIMIT/OFFSET ---
      const offsetShallowMs = await medianMs(() =>
        pool.query(`SELECT * FROM projects ${ORDER} LIMIT $1 OFFSET 0`, [PAGE_SIZE])
      );
      const offsetDeepMs = await medianMs(() =>
        pool.query(`SELECT * FROM projects ${ORDER} LIMIT $1 OFFSET $2`, [PAGE_SIZE, DEEP_OFFSET])
      );

      // --- after: keyset over the same total ordering ---
      const keysetShallowMs = await medianMs(() =>
        pool.query(`SELECT * FROM projects ${ORDER} LIMIT $1`, [PAGE_SIZE])
      );

      // The sort key of the row sitting where the deep OFFSET page begins, so
      // both variants are asked for the identical slice of the table.
      const anchor = await pool.query(
        `SELECT created_at, id FROM projects ${ORDER} LIMIT 1 OFFSET $1`,
        [DEEP_OFFSET - 1]
      );
      const { created_at: anchorCreatedAt, id: anchorId } = anchor.rows[0];

      const keysetDeepMs = await medianMs(() =>
        pool.query(
          `SELECT * FROM projects
           WHERE (created_at, id) < ($1::timestamptz, $2::uuid)
           ${ORDER} LIMIT $3`,
          [anchorCreatedAt, anchorId, PAGE_SIZE]
        )
      );

      console.log(
        `[pagination benchmark] ${ROWS} rows, page size ${PAGE_SIZE}, depth ${DEEP_OFFSET} (medians of ${SAMPLES})\n` +
        `  before  OFFSET  page 1: ${offsetShallowMs.toFixed(2)} ms   deep page: ${offsetDeepMs.toFixed(2)} ms   ` +
        `(x${(offsetDeepMs / offsetShallowMs).toFixed(1)} deeper-page penalty)\n` +
        `  after   keyset  page 1: ${keysetShallowMs.toFixed(2)} ms   deep page: ${keysetDeepMs.toFixed(2)} ms   ` +
        `(x${(keysetDeepMs / keysetShallowMs).toFixed(1)} deeper-page penalty)`
      );

      // The claim under test is that depth stopped mattering, so it is asserted
      // as a ratio against this same run's shallow page rather than a wall-clock
      // budget, which would only measure how busy the runner is. The slack is
      // wide because these are sub-millisecond timings on a shared runner; the
      // OFFSET plan blows past it by an order of magnitude.
      expect(keysetDeepMs).toBeLessThan(Math.max(keysetShallowMs * 4, 25));

      // And the keyset deep page must actually beat the OFFSET deep page it
      // replaced — otherwise the rewrite bought nothing.
      expect(keysetDeepMs).toBeLessThan(offsetDeepMs);

      // The two variants must agree on which rows the deep page contains;
      // a faster query returning a different slice would not be a fix.
      const offsetRows = await pool.query(
        `SELECT id FROM projects ${ORDER} LIMIT $1 OFFSET $2`,
        [PAGE_SIZE, DEEP_OFFSET]
      );
      const keysetRows = await pool.query(
        `SELECT id FROM projects
         WHERE (created_at, id) < ($1::timestamptz, $2::uuid)
         ${ORDER} LIMIT $3`,
        [anchorCreatedAt, anchorId, PAGE_SIZE]
      );
      expect(keysetRows.rows.map((r) => r.id)).toEqual(offsetRows.rows.map((r) => r.id));
    });

    it("serves a deep page over HTTP without offset in the request", async () => {
      const baseTime = Date.now();
      const values = [];
      // 250 rows so the tenth page of 20 still has a page after it and must
      // hand back a cursor; a walk that ends exactly at the last row would not
      // distinguish "no more pages" from "cursor missing".
      for (let i = 0; i < 250; i++) {
        values.push(`(gen_random_uuid(), 'Project ${i}', 'desc', 'Solar Energy', 'Loc', 'wallet', 100, 'active', to_timestamp(${(baseTime - i * 100) / 1000}))`);
      }
      await pool.query(
        `INSERT INTO projects (id, name, description, category, location, wallet_address, goal_xlm, status, created_at)
         VALUES ${values.join(",")}`
      );

      let cursor;
      const seen = new Set();
      for (let page = 0; page < 10; page++) {
        const res = await request(app).get("/api/projects").query(
          cursor ? { limit: PAGE_SIZE, cursor } : { limit: PAGE_SIZE }
        );
        expect(res.status).toBe(200);
        for (const row of res.body.data) {
          expect(seen.has(row.id)).toBe(false);
          seen.add(row.id);
        }
        cursor = res.body.meta.nextCursor;
        expect(cursor).toBeTruthy();
      }

      // Ten pages walked with nothing but cursors — no offset was ever sent.
      expect(seen.size).toBe(PAGE_SIZE * 10);
    });
  });
});
