"use strict";

const fs = require("fs");
const path = require("path");
const pool = require("./pool");
const { seedProjects, seedProjectUpdates, seedJobs } = require("../services/store");

/**
 * Demo projects exist so a fresh local database has something to render. They
 * are not real fundraising projects, and their wallet addresses belong to
 * nobody, so inserting them into a production database would publish
 * donatable projects that can never receive funds.
 *
 * Seeding is therefore opt-out in development and opt-in anywhere else: set
 * SEED_DEMO_DATA=true to force it on, or false to suppress it locally.
 */
function shouldSeedDemoData() {
  const explicit = (process.env.SEED_DEMO_DATA || "").trim().toLowerCase();
  if (explicit === "true" || explicit === "1") return true;
  if (explicit === "false" || explicit === "0") return false;
  return process.env.NODE_ENV !== "production";
}

async function runMigrations() {
  const client = await pool.connect();
  const seedDemoData = shouldSeedDemoData();

  try {
    await client.query("BEGIN");

    const schemaPath = path.join(__dirname, "schema.sql");
    const schemaSql = fs.readFileSync(schemaPath, "utf8");
    await client.query(schemaSql);

    for (const project of seedDemoData ? seedProjects : []) {
      await client.query(
        `INSERT INTO projects (
          id, name, description, category, location, wallet_address, goal_xlm,
          raised_xlm, donor_count, co2_offset_kg, status, verified, on_chain_verified,
          tags, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13,
          $14, $15, $16
        )
        ON CONFLICT (id) DO NOTHING`,
        [
          project.id,
          project.name,
          project.description,
          project.category,
          project.location,
          project.walletAddress,
          project.goalXLM,
          project.raisedXLM,
          project.donorCount,
          project.co2OffsetKg,
          project.status,
          project.verified,
          project.onChainVerified,
          project.tags,
          project.createdAt,
          project.updatedAt,
        ],
      );
    }

    for (const update of seedDemoData ? seedProjectUpdates : []) {
      await client.query(
        `INSERT INTO project_updates (
           id, project_id, title, body, created_at, moderation_status, published_at
         )
         VALUES ($1, $2, $3, $4, $5, 'published', $5)
         ON CONFLICT (id) DO NOTHING`,
        [update.id, update.projectId, update.title, update.body, update.createdAt],
      );
    }

    for (const job of seedDemoData ? seedJobs : []) {
      await client.query(
        `INSERT INTO jobs (
          id, title, description, client_public_key, freelancer_public_key,
          amount_escrow_xlm, status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (id) DO NOTHING`,
        [
          job.id,
          job.title,
          job.description,
          job.clientPublicKey,
          job.freelancerPublicKey,
          job.amountEscrowXlm,
          job.status,
          job.createdAt,
          job.updatedAt,
        ],
      );
    }

    // schema.sql runs before demo projects are inserted on a fresh database,
    // so repeat the idempotent legacy treatment after seeding.  Existing
    // values remain operator-stated evidence records and are never promoted to
    // independent verification or allocated in proportion to a donation.
    await client.query(
      `INSERT INTO impact_claims (
        id, project_id, methodology_id, claim_type, quantity, unit,
        uncertainty_low, uncertainty_high, confidence_percent,
        measurement_period_start, measurement_period_end,
        baseline_description, asserting_party, asserting_party_type, status,
        asserted_at, migrated_from_legacy, migration_note
      )
      SELECT
        md5('legacy-impact-claim:' || p.id::text)::uuid,
        p.id,
        '00000000-0000-4000-8000-000000000001',
        'offset', p.co2_offset_kg, 'kg_co2e', 0, p.co2_offset_kg * 2, NULL,
        p.created_at::date, GREATEST(p.created_at::date, p.updated_at::date),
        'No baseline was recorded for this legacy operator assertion.',
        'Project operator (legacy import)', 'platform_migration', 'operator_stated',
        p.updated_at, TRUE,
        'Imported from projects.co2_offset_kg; unsourced, unverified, and never allocated to donors.'
      FROM projects p
      WHERE p.co2_offset_kg > 0
      ON CONFLICT (id) DO NOTHING`,
    );

    await client.query("COMMIT");
    console.log(
      seedDemoData
        ? "[DB] Migration complete (demo data seeded)"
        : "[DB] Migration complete (demo data skipped)",
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { runMigrations, shouldSeedDemoData };
