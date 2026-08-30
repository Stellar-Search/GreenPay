"use strict";

/**
 * Real-Postgres proof that indexerService.handleDonation's outer transaction
 * is genuine: it exercises the actual `pg` pool (no mocked pool.query), so a
 * mid-sequence failure has to roll back for real for these tests to pass.
 *
 * Requires a reachable Postgres — e.g. `docker compose up postgres` — at
 * DATABASE_URL (defaults to the same postgres://postgres:postgres@localhost:5432/greenpay
 * used by docker-compose.yml and CI's `integration` job). When no database is
 * reachable, every test in this file is skipped rather than failed, so it
 * never blocks a plain `npm test` run in an environment without Postgres.
 */

const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { execFileSync } = require("child_process");
const { v4: uuid } = require("uuid");

const pool = require("../db/pool");
const indexerService = require("./indexerService");

jest.setTimeout(20000);

const SCHEMA_PATH = path.join(__dirname, "..", "db", "schema.sql");
const CONNECTIVITY_TIMEOUT_MS = 5000;
const DEFAULT_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/greenpay";

/**
 * Jest registers `test`/`test.skip` synchronously while the file's top-level
 * code runs, before any `beforeAll` executes — so the skip/run decision can't
 * live in a variable that only gets its real value inside `beforeAll` (that
 * pattern silently skips every test unconditionally, DB reachable or not).
 * This runs the connectivity probe in a child process via `execSync`, which
 * blocks the parent until it exits, giving a synchronous answer in time for
 * `describe`/`test` registration below.
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
    `[indexerService.integration.test] Skipping — no reachable Postgres at ${
      process.env.DATABASE_URL || `${DEFAULT_DATABASE_URL} (default)`
    }. Run "docker compose up postgres" (or set DATABASE_URL) to exercise these tests.`
  );
}

const { Keypair } = require("@stellar/stellar-sdk");

const _keyCache = new Map();
function makePublicKey(seed) {
  if (!_keyCache.has(seed)) {
    _keyCache.set(seed, Keypair.random().publicKey());
  }
  return _keyCache.get(seed);
}

function makeTxHash(seed) {
  return createHash("sha256").update(seed).digest("hex");
}

async function seedProject(projectId) {
  await pool.query(
    `INSERT INTO projects (id, name, description, category, location, wallet_address, goal_xlm, raised_xlm, donor_count, status)
     VALUES ($1, 'Integration Test Project', 'Seeded by indexerService.integration.test.js', 'environment', 'Test Location', $2, 1000, 0, 0, 'active')`,
    [projectId, makePublicKey(`wallet-${projectId}`)]
  );
  const result = await pool.query("SELECT updated_at, donor_count FROM projects WHERE id = $1", [projectId]);
  return result.rows[0];
}

async function seedDonationMatch(projectId, matcherAddress) {
  const matchId = uuid();
  await pool.query(
    `INSERT INTO donation_matches (id, project_id, matcher_address, cap_xlm, multiplier, expires_at, matched_xlm)
     VALUES ($1, $2, $3, 1000, 2, NOW() + INTERVAL '1 day', 0)`,
    [matchId, projectId, matcherAddress]
  );
  await pool.query(
    `INSERT INTO match_state (match_id, matched_xlm, cap_xlm, multiplier)
     VALUES ($1, 0, 1000, 2)`,
    [matchId]
  );
  return matchId;
}

async function cleanupProject(projectId, addresses = []) {
  await pool.query("DELETE FROM event_stream WHERE payload->'data'->>'projectId' = $1", [projectId]);
  for (const address of addresses) {
    await pool.query("DELETE FROM profiles WHERE public_key = $1", [address]);
  }
  await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
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

describe("indexerService.handleDonation real-transaction behavior", () => {
  maybeTest("commits the donation's event_stream row and aggregate writes when nothing fails", async () => {
    const projectId = uuid();
    const donorAddress = makePublicKey(`donor-${projectId}`);
    const txHash = makeTxHash(`tx-${projectId}`);
    const before = await seedProject(projectId);

    try {
      await indexerService.handleDonation(projectId, {
        transaction_hash: txHash,
        from: donorAddress,
        amount: "10",
        ledger_attr: 1,
      });

      const eventRows = await pool.query(
        "SELECT * FROM event_stream WHERE event_type = 'DonationRecorded' AND payload->'data'->>'transactionHash' = $1",
        [txHash]
      );
      expect(eventRows.rows).toHaveLength(1);

      const profileRows = await pool.query("SELECT * FROM profiles WHERE public_key = $1", [donorAddress]);
      expect(profileRows.rows).toHaveLength(1);

      const projectRow = await pool.query("SELECT updated_at FROM projects WHERE id = $1", [projectId]);
      expect(projectRow.rows[0].updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    } finally {
      await cleanupProject(projectId, [donorAddress]);
    }
  });

  maybeTest("commits both the donation and its match application together when nothing fails", async () => {
    const projectId = uuid();
    const donorAddress = makePublicKey(`donor-${projectId}`);
    const matcherAddress = makePublicKey(`matcher-${projectId}`);
    const txHash = makeTxHash(`tx-${projectId}`);
    await seedProject(projectId);
    await seedDonationMatch(projectId, matcherAddress);

    try {
      await indexerService.handleDonation(projectId, {
        transaction_hash: txHash,
        from: donorAddress,
        amount: "10",
        ledger_attr: 1,
      });

      const donationRows = await pool.query(
        "SELECT * FROM event_stream WHERE event_type = 'DonationRecorded' AND payload->'data'->>'transactionHash' = $1",
        [txHash]
      );
      expect(donationRows.rows).toHaveLength(1);

      const matchRows = await pool.query(
        "SELECT * FROM event_stream WHERE event_type = 'MatchApplied' AND payload->'data'->>'originalTxHash' = $1",
        [txHash]
      );
      expect(matchRows.rows).toHaveLength(1);

      const donorProfile = await pool.query("SELECT * FROM profiles WHERE public_key = $1", [donorAddress]);
      expect(donorProfile.rows).toHaveLength(1);

      const matcherProfile = await pool.query("SELECT * FROM profiles WHERE public_key = $1", [matcherAddress]);
      expect(matcherProfile.rows).toHaveLength(1);
    } finally {
      await cleanupProject(projectId, [donorAddress, matcherAddress]);
    }
  });

  maybeTest(
    "rolls back the donation's event_stream insert and aggregate writes when the match application fails mid-sequence",
    async () => {
      const projectId = uuid();
      const donorAddress = makePublicKey(`donor-${projectId}`);
      const txHash = makeTxHash(`tx-${projectId}`);
      const before = await seedProject(projectId);
      // An invalid matcher address fails ApplyMatchCommand.validate() — thrown
      // *after* RecordDonationCommand has already written its event_stream row
      // and profiles row on the same checked-out client, inside the still-open
      // BEGIN. If the outer transaction were genuinely atomic, none of that
      // survives; if it's the pre-fix no-op wrapper, the donation writes leak
      // through despite the eventual ROLLBACK.
      await seedDonationMatch(projectId, "not-a-valid-stellar-address");

      try {
        await indexerService.handleDonation(projectId, {
          transaction_hash: txHash,
          from: donorAddress,
          amount: "10",
          ledger_attr: 1,
        });

        const eventRows = await pool.query(
          "SELECT * FROM event_stream WHERE event_type = 'DonationRecorded' AND payload->'data'->>'transactionHash' = $1",
          [txHash]
        );
        expect(eventRows.rows).toHaveLength(0);

        const profileRows = await pool.query("SELECT * FROM profiles WHERE public_key = $1", [donorAddress]);
        expect(profileRows.rows).toHaveLength(0);

        const projectRow = await pool.query("SELECT updated_at, donor_count FROM projects WHERE id = $1", [projectId]);
        expect(projectRow.rows[0].updated_at.getTime()).toBe(before.updated_at.getTime());
        expect(projectRow.rows[0].donor_count).toBe(before.donor_count);
      } finally {
        await cleanupProject(projectId, [donorAddress]);
      }
    }
  );
});
