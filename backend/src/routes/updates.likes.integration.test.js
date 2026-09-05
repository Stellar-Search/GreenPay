"use strict";

/**
 * Real-Postgres proof for POST /api/updates/:updateId/like and
 * GET /api/updates/:updateId/likes.
 *
 * updates.test.js mocks the pool, so it can assert the SQL text but cannot
 * prove the statement is actually atomic — nor that `update_likes` exists at
 * all, which is the defect this suite exists to pin down (the table was read
 * and written in six places but never created, so both endpoints returned
 * 42P01 as a 500).
 *
 * The toggle is a single data-modifying CTE, so the interesting claims are all
 * concurrency claims: two overlapping likes for the same (update, donor) must
 * collapse into one row without either request failing. That is only
 * observable against a real database with real row locks and a real UNIQUE
 * index, which is why these tests apply schema.sql rather than mocking it.
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

// The like route is rate-limited to 20 likes per donor per minute, which the
// concurrency rounds below deliberately exceed. Rate limiting is orthogonal to
// the persistence race under test and has its own suites, so it is stubbed out
// here exactly as updates.test.js does.
jest.mock("../middleware/rateLimiter", () => ({
  createRateLimiter: () => (req, res, next) => next(),
  createLayeredRateLimiter: () => (req, res, next) => next(),
}));

const pool = require("../db/pool");
const { apiEnvelope, errorHandler } = require("../middleware/apiEnvelope");

jest.setTimeout(30000);

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
    `[updates.likes.integration.test] Skipping — no reachable Postgres at ${
      process.env.DATABASE_URL || `${DEFAULT_DATABASE_URL} (default)`
    }. Run "docker compose up postgres" (or set DATABASE_URL) to exercise these tests.`
  );
}

/**
 * The pg pool holds 10 connections by default. Firing more overlapping
 * requests than that would queue the surplus inside the pool and run them one
 * after another on a freed connection — the requests would look concurrent
 * from the test's side while reaching Postgres serially, quietly turning this
 * into the sequential test it must not be. Eight keeps every request on its
 * own backend with headroom to spare.
 */
const CONCURRENCY = 8;
const ROUNDS = 5;

const DONOR_A = "G" + "1".repeat(55);
const DONOR_B = "G" + "2".repeat(55);
const DONOR_C = "G" + "3".repeat(55);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use("/api/updates", require("./updates"));
  app.use(errorHandler);
  return app;
}

async function createUpdateFixture() {
  const projectId = uuid();
  const updateId = uuid();
  await pool.query(
    `INSERT INTO projects (id, name, description, category, location, wallet_address, goal_xlm)
     VALUES ($1, 'Likes Fixture', 'desc', 'ocean', 'here', 'GFIXTURE', 1)`,
    [projectId]
  );
  await pool.query(
    `INSERT INTO project_updates (id, project_id, title, body)
     VALUES ($1, $2, 'Fixture update', 'body')`,
    [updateId, projectId]
  );
  return { projectId, updateId };
}

// project_updates and update_likes both cascade from projects, so removing the
// project removes every row this suite created.
async function deleteUpdateFixture(projectId) {
  await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
}

/**
 * Reduces responses to the few fields worth asserting on. A supertest Response
 * carries the request, socket and app with it, so handing the raw objects to
 * `expect` makes a failing assertion serialize the entire server — enough to
 * exhaust the heap before the real error is ever printed.
 */
function summarize(responses) {
  return responses
    .filter((r) => r.status !== 200)
    .map((r) => ({ status: r.status, body: r.body }));
}

async function countLikes(updateId, donorAddress) {
  const result = donorAddress
    ? await pool.query(
      "SELECT COUNT(*)::int AS count FROM update_likes WHERE update_id = $1 AND donor_address = $2",
      [updateId, donorAddress]
    )
    : await pool.query("SELECT COUNT(*)::int AS count FROM update_likes WHERE update_id = $1", [
      updateId,
    ]);
  return result.rows[0].count;
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

describe("update likes real-Postgres behavior", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  maybeTest("the update_likes table schema.sql creates is the one the routes query", async () => {
    // The reported defect was that this table simply did not exist, so assert
    // its shape directly rather than inferring it from a passing request.
    const table = await pool.query("SELECT to_regclass('public.update_likes') AS name");
    expect(table.rows[0].name).toBe("update_likes");

    const constraints = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'public.update_likes'::regclass`
    );
    const defs = constraints.rows.map((r) => r.def);
    expect(defs).toEqual(
      expect.arrayContaining([
        "UNIQUE (update_id, donor_address)",
        "FOREIGN KEY (update_id) REFERENCES project_updates(id) ON DELETE CASCADE",
      ])
    );
  });

  maybeTest("a like is persisted and reported back, and the row is really there", async () => {
    const { projectId, updateId } = await createUpdateFixture();
    try {
      const res = await request(app)
        .post(`/api/updates/${updateId}/like`)
        .send({ donorAddress: DONOR_A });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ liked: true, likeCount: 1 });
      expect(await countLikes(updateId)).toBe(1);
    } finally {
      await deleteUpdateFixture(projectId);
    }
  });

  maybeTest("the endpoint toggles: a second like from the same donor removes the row", async () => {
    const { projectId, updateId } = await createUpdateFixture();
    try {
      await request(app).post(`/api/updates/${updateId}/like`).send({ donorAddress: DONOR_A });

      const second = await request(app)
        .post(`/api/updates/${updateId}/like`)
        .send({ donorAddress: DONOR_A });

      expect(second.status).toBe(200);
      expect(second.body.data).toEqual({ liked: false, likeCount: 0 });
      expect(await countLikes(updateId)).toBe(0);
    } finally {
      await deleteUpdateFixture(projectId);
    }
  });

  maybeTest("toggling an update the donor never liked creates the like rather than failing", async () => {
    const { projectId, updateId } = await createUpdateFixture();
    try {
      // No prior row for this donor: the DELETE half matches nothing, which
      // must be an ordinary no-op and not an error.
      const res = await request(app)
        .post(`/api/updates/${updateId}/like`)
        .send({ donorAddress: DONOR_C });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ liked: true, likeCount: 1 });
      expect(await countLikes(updateId, DONOR_C)).toBe(1);
    } finally {
      await deleteUpdateFixture(projectId);
    }
  });

  maybeTest("GET reports the count and this donor's own like state", async () => {
    const { projectId, updateId } = await createUpdateFixture();
    try {
      await request(app).post(`/api/updates/${updateId}/like`).send({ donorAddress: DONOR_A });

      const anonymous = await request(app).get(`/api/updates/${updateId}/likes`);
      expect(anonymous.status).toBe(200);
      expect(anonymous.body.data).toEqual({ likeCount: 1, liked: false });

      const liker = await request(app)
        .get(`/api/updates/${updateId}/likes`)
        .query({ donorAddress: DONOR_A });
      expect(liker.body.data).toEqual({ likeCount: 1, liked: true });

      const other = await request(app)
        .get(`/api/updates/${updateId}/likes`)
        .query({ donorAddress: DONOR_B });
      expect(other.body.data).toEqual({ likeCount: 1, liked: false });
    } finally {
      await deleteUpdateFixture(projectId);
    }
  });

  maybeTest("the count tracks a sequence of likes and unlikes by distinct donors", async () => {
    const { projectId, updateId } = await createUpdateFixture();
    const like = (donorAddress) =>
      request(app).post(`/api/updates/${updateId}/like`).send({ donorAddress });
    try {
      expect((await like(DONOR_A)).body.data.likeCount).toBe(1);
      expect((await like(DONOR_B)).body.data.likeCount).toBe(2);
      expect((await like(DONOR_C)).body.data.likeCount).toBe(3);

      // DONOR_B toggles back off.
      expect((await like(DONOR_B)).body.data).toEqual({ liked: false, likeCount: 2 });

      // ...and on again.
      expect((await like(DONOR_B)).body.data).toEqual({ liked: true, likeCount: 3 });

      expect(await countLikes(updateId)).toBe(3);

      const view = await request(app).get(`/api/updates/${updateId}/likes`);
      expect(view.body.data.likeCount).toBe(3);
    } finally {
      await deleteUpdateFixture(projectId);
    }
  });

  /**
   * The race this issue exists to close.
   *
   * The original implementation read `SELECT id FROM update_likes ...` and then
   * decided, in JavaScript, whether to INSERT or DELETE. Overlapping requests
   * for the same (update, donor) all observed "no row", all proceeded to the
   * INSERT branch, and collided on the UNIQUE index — one won and the rest came
   * back as 23505, which the error handler renders as a 500.
   *
   * These requests are genuinely overlapping rather than sequentially awaited:
   * every `request(app)` is a separate HTTP connection to its own ephemeral
   * server, they are started together by Promise.all without any intervening
   * await, and — because CONCURRENCY stays under the pool's connection limit —
   * each one occupies its own pg backend. They are therefore in flight against
   * Postgres at the same time, contending on real row locks.
   *
   * Interleaving is still decided by the OS scheduler, so a single round could
   * in principle serialize by luck; the rounds loop makes that vanishingly
   * unlikely rather than relying on one throw of the dice.
   */
  maybeTest(
    "concurrent likes for the same donor never duplicate the row and never fail a request",
    async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const { projectId, updateId } = await createUpdateFixture();
        try {
          const responses = await Promise.all(
            Array.from({ length: CONCURRENCY }, () =>
              request(app).post(`/api/updates/${updateId}/like`).send({ donorAddress: DONOR_A })
            )
          );

          // Nothing may fail. Under the old read-then-write code the losers of
          // the INSERT race surfaced here as 500s carrying code "23505".
          expect(summarize(responses)).toEqual([]);

          // The core invariant: one claimed address, at most one row — never a
          // duplicate, no matter how the toggles interleaved.
          const rows = await countLikes(updateId, DONOR_A);
          expect(rows).toBeLessThanOrEqual(1);

          // Whatever the final state, the endpoint must still describe it
          // truthfully to the next reader.
          const view = await request(app)
            .get(`/api/updates/${updateId}/likes`)
            .query({ donorAddress: DONOR_A });
          expect(view.status).toBe(200);
          expect(view.body.data).toEqual({ likeCount: rows, liked: rows === 1 });
        } finally {
          await deleteUpdateFixture(projectId);
        }
      }
    }
  );

  /**
   * The same overlap, but with every request carrying a different donor
   * address, so no two requests contend for the same row. Here the outcome is
   * fully determined — CONCURRENCY distinct likes must produce exactly
   * CONCURRENCY rows — which pins down the count path in a way the
   * same-donor race above deliberately cannot.
   */
  maybeTest("concurrent likes from distinct donors all persist and the count is exact", async () => {
    const { projectId, updateId } = await createUpdateFixture();
    try {
      const donors = Array.from({ length: CONCURRENCY }, (_, i) => `G${String(i).padStart(55, "0")}`);

      const responses = await Promise.all(
        donors.map((donorAddress) =>
          request(app).post(`/api/updates/${updateId}/like`).send({ donorAddress })
        )
      );

      expect(summarize(responses)).toEqual([]);
      expect(responses.map((r) => r.body?.data?.liked)).toEqual(
        Array.from({ length: CONCURRENCY }, () => true)
      );
      expect(await countLikes(updateId)).toBe(CONCURRENCY);

      const view = await request(app).get(`/api/updates/${updateId}/likes`);
      expect(view.body.data.likeCount).toBe(CONCURRENCY);
    } finally {
      await deleteUpdateFixture(projectId);
    }
  });
});
