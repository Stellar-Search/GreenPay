"use strict";

const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { execFileSync } = require("child_process");
const { Keypair } = require("@stellar/stellar-sdk");
const { v4: uuid } = require("uuid");
const express = require("express");
const request = require("supertest");
const pool = require("../db/pool");
const cache = require("./cache");
const { apiEnvelope, errorHandler } = require("../middleware/apiEnvelope");
const indexerService = require("./indexerService");
const {
  queueDonationAssessment,
  processIntegrityQueueBatch,
  refreshIntegrityWatchlist,
  observeNativePayment,
} = require("./donationIntegrity");

jest.setTimeout(30000);

const SCHEMA_PATH = path.join(__dirname, "..", "db", "schema.sql");
const CONNECTIVITY_TIMEOUT_MS = 5000;
const DEFAULT_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/greenpay";

function checkDbAvailableSync() {
  const databaseUrl = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
  const probe = `
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: ${JSON.stringify(databaseUrl)}, connectionTimeoutMillis: ${CONNECTIVITY_TIMEOUT_MS} });
    pool.query("SELECT 1").then(() => { pool.end(); process.exit(0); }).catch(() => process.exit(1));
  `;
  try {
    execFileSync(process.execPath, ["-e", probe], {
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

function txHash(seed) {
  return createHash("sha256").update(seed).digest("hex");
}

async function seedProject(walletAddress) {
  const projectId = uuid();
  await pool.query(
    `INSERT INTO projects (
       id, name, description, category, location, wallet_address,
       goal_xlm, raised_xlm, donor_count, status
     ) VALUES ($1, 'Integrity fixture', 'Integrity fixture', 'environment',
       'Test', $2, 1000, 0, 0, 'active')`,
    [projectId, walletAddress],
  );
  await refreshIntegrityWatchlist();
  return projectId;
}

async function cleanup(projectId, addresses = []) {
  await pool.query("DELETE FROM event_stream WHERE payload->'data'->>'projectId' = $1", [projectId]);
  await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
  if (addresses.length) await pool.query("DELETE FROM profiles WHERE public_key = ANY($1::text[])", [addresses]);
}

function buildSurfaceApp() {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use("/api/leaderboard", require("../routes/leaderboard"));
  app.use("/api/impact", require("../routes/impact"));
  app.use(errorHandler);
  return app;
}

beforeAll(async () => {
  if (!dbAvailable) return;
  await pool.query(fs.readFileSync(SCHEMA_PATH, "utf8"));
});

afterAll(async () => {
  if (dbAvailable) await pool.end();
});

describe("donation integrity with real PostgreSQL", () => {
  maybeTest("detects a project-controlled wallet donation observed by the on-chain indexer", async () => {
    const projectWallet = Keypair.random().publicKey();
    const projectId = await seedProject(projectWallet);
    const hash = txHash(`self-${projectId}`);
    try {
      const handled = await indexerService.handleDonation(projectId, {
        id: `op-${hash}`,
        transaction_hash: hash,
        from: projectWallet,
        to: projectWallet,
        amount: "12.0000000",
        ledger_attr: 100,
        integrity_source: "indexer_horizon",
      });
      expect(handled).toBe(true);
      expect(await processIntegrityQueueBatch()).toBe(1);

      const result = await pool.query(
        `SELECT a.review_status, a.confidence_score,
                a.exclude_from_leaderboard, s.signal_type
           FROM donation_integrity_assessments a
           JOIN donation_integrity_signals s ON s.assessment_id = a.id
          WHERE a.transaction_hash = $1`,
        [hash],
      );
      expect(result.rows).toEqual([
        expect.objectContaining({
          review_status: "pending_review",
          exclude_from_leaderboard: false,
          signal_type: "self_donation",
        }),
      ]);
      expect(Number(result.rows[0].confidence_score)).toBeGreaterThanOrEqual(0.95);
    } finally {
      await cleanup(projectId, [projectWallet]);
    }
  });

  maybeTest("surfaces direct circular flow and rapid repeated-pair signals with confidence", async () => {
    const projectWallet = Keypair.random().publicKey();
    const donor = Keypair.random().publicKey();
    const projectId = await seedProject(projectWallet);
    const hashes = [0, 1, 2].map((index) => txHash(`repeat-${projectId}-${index}`));
    try {
      await observeNativePayment({
        id: `outbound-${projectId}`,
        transaction_hash: txHash(`outbound-${projectId}`),
        from: projectWallet,
        to: donor,
        amount: "30.0000000",
        ledger_attr: 200,
      });
      for (let index = 0; index < hashes.length; index += 1) {
        await indexerService.handleDonation(projectId, {
          id: `inbound-${index}-${projectId}`,
          transaction_hash: hashes[index],
          from: donor,
          to: projectWallet,
          amount: "10.0000000",
          ledger_attr: 201 + index,
          integrity_source: "indexer_horizon",
        });
      }
      expect(await processIntegrityQueueBatch()).toBe(3);

      const result = await pool.query(
        `SELECT a.transaction_hash, a.confidence_score,
                array_agg(s.signal_type ORDER BY s.signal_type) AS signal_types
           FROM donation_integrity_assessments a
           JOIN donation_integrity_signals s ON s.assessment_id = a.id
          WHERE a.transaction_hash = ANY($1::text[])
          GROUP BY a.id
          ORDER BY a.observed_at ASC`,
        [hashes],
      );
      expect(result.rows).toHaveLength(3);
      expect(result.rows[0].signal_types).toContain("circular_flow");
      expect(result.rows[2].signal_types).toEqual(expect.arrayContaining(["circular_flow", "rapid_repeat_pair"]));
      expect(Number(result.rows[2].confidence_score)).toBeGreaterThan(Number(result.rows[0].confidence_score));
    } finally {
      await cleanup(projectId, [donor]);
    }
  });

  maybeTest("processes a realistic 100-observation burst inside the documented ten-second CI budget", async () => {
    const projectWallet = Keypair.random().publicKey();
    const projectId = await seedProject(projectWallet);
    try {
      for (let index = 0; index < 100; index += 1) {
        await queueDonationAssessment(pool, {
          transactionHash: txHash(`volume-${projectId}-${index}`),
          projectId,
          donorAddress: Keypair.random().publicKey(),
          destinationAddress: projectWallet,
          amountXlm: "1.0000000",
          observedSource: "indexer_horizon",
          ledger: 1000 + index,
        });
      }
      const started = Date.now();
      const processed = await processIntegrityQueueBatch({ limit: 100 });
      const elapsedMs = Date.now() - started;
      expect(processed).toBe(100);
      expect(elapsedMs).toBeLessThan(10_000);
    } finally {
      await cleanup(projectId);
    }
  });

  maybeTest("keeps gross accounting but excludes a human-confirmed donation from each donor-facing surface", async () => {
    const projectWallet = Keypair.random().publicKey();
    const donor = Keypair.random().publicKey();
    const projectId = await seedProject(projectWallet);
    const hash = txHash(`surface-${projectId}`);
    const cleanHash = txHash(`surface-clean-${projectId}`);
    const cleanAmount = "999999999.0000000";
    const app = buildSurfaceApp();
    try {
      await indexerService.handleDonation(projectId, {
        transaction_hash: cleanHash,
        from: donor,
        to: projectWallet,
        amount: cleanAmount,
        ledger_attr: 499,
        integrity_source: "indexer_horizon",
      });
      await indexerService.handleDonation(projectId, {
        transaction_hash: hash,
        from: donor,
        to: projectWallet,
        amount: "25.0000000",
        ledger_attr: 500,
        integrity_source: "indexer_horizon",
      });
      expect(await processIntegrityQueueBatch()).toBe(2);
      await pool.query(
        `INSERT INTO donor_stats (public_key, total_donated_xlm, projects_supported, badges)
         VALUES ($1, '1000000024.0000000', 1, '[]'::jsonb)
         ON CONFLICT (public_key) DO UPDATE SET
           total_donated_xlm = EXCLUDED.total_donated_xlm,
           projects_supported = EXCLUDED.projects_supported`,
        [donor],
      );
      await pool.query("UPDATE projects SET raised_xlm = '1000000024.0000000' WHERE id = $1", [projectId]);
      await pool.query(
        `UPDATE donation_integrity_assessments
            SET review_status = 'confirmed',
                exclude_from_leaderboard = TRUE,
                exclude_from_displayed_totals = TRUE,
                exclude_from_impact_figures = TRUE,
                decided_by = 'fixture-reviewer',
                decision_reason = 'Labelled integration fixture confirmed by human review',
                decided_at = NOW()
          WHERE transaction_hash = $1`,
        [hash],
      );
      await pool.query(
        "UPDATE donation_integrity_settings SET enforcement_enabled = TRUE, updated_at = NOW() WHERE id = 'global'",
      );
      cache.clear();

      const leaderboard = await request(app).get("/api/leaderboard").query({ period: "all", limit: 200 });
      expect({ status: leaderboard.status, error: leaderboard.body.error }).toEqual({ status: 200, error: undefined });
      const entry = leaderboard.body.data.find((row) => row.publicKey === donor);
      expect(entry).toBeDefined();
      expect(entry.totalDonatedXLM).toBe(cleanAmount);

      const projectImpact = await request(app).get(`/api/impact/project/${projectId}`);
      expect(projectImpact.body.data.totalDonationsXLM).toBe(cleanAmount);

      const gross = await pool.query(
        `SELECT raised_xlm,
                (SELECT COUNT(*) FROM event_stream
                  WHERE event_type = 'DonationRecorded'
                    AND payload->'data'->>'transactionHash' = $2)::int AS event_count
           FROM projects WHERE id = $1`,
        [projectId, hash],
      );
      expect(gross.rows[0].raised_xlm).toBe("1000000024.0000000");
      expect(gross.rows[0].event_count).toBe(1);
    } finally {
      cache.clear();
      await pool.query(
        "UPDATE donation_integrity_settings SET enforcement_enabled = FALSE, updated_at = NOW() WHERE id = 'global'",
      );
      await cleanup(projectId, [donor]);
    }
  });
});
