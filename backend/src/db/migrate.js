"use strict";

const fs = require("fs");
const path = require("path");
const pool = require("./pool");
const { seedProjects, seedProjectUpdates, seedJobs } = require("../services/store");

const MIGRATION_LOCK_ID = 746291;

function getMigrationFiles() {
  const migrationsDir = path.join(__dirname, "migrations");
  if (!fs.existsSync(migrationsDir)) {
    return [];
  }

  return fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".js") && !file.endsWith(".test.js"))
    .sort()
    .map((file) => {
      const filePath = path.join(migrationsDir, file);
      // eslint-disable-next-line security/detect-non-literal-require
      const migration = require(filePath);
      return {
        fileName: file,
        name: migration.name || file,
        up: migration.up,
        down: migration.down,
      };
    });
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

async function runMigrations(options = {}) {
  const client = options.client || (await pool.connect());
  const shouldRelease = !options.client;

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
    await ensureMigrationTable(client);

    const appliedRes = await client.query("SELECT name FROM schema_migrations");
    const appliedNames = new Set(appliedRes.rows.map((r) => r.name));

    const migrationFiles = getMigrationFiles();
    for (const migration of migrationFiles) {
      if (!appliedNames.has(migration.name)) {
        console.log(`[DB] Applying migration: ${migration.name}`);
        await migration.up(client);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [migration.name]);
      }
    }

    for (const project of seedProjects) {
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

    for (const update of seedProjectUpdates) {
      await client.query(
        `INSERT INTO project_updates (id, project_id, title, body, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [update.id, update.projectId, update.title, update.body, update.createdAt],
      );
    }

    for (const job of seedJobs) {
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

    await client.query("COMMIT");
    console.log("[DB] Migration and seeding complete");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    if (shouldRelease) {
      client.release();
    }
  }
}

async function rollbackLastMigration(options = {}) {
  const client = options.client || (await pool.connect());
  const shouldRelease = !options.client;

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
    await ensureMigrationTable(client);

    const lastRes = await client.query("SELECT name FROM schema_migrations ORDER BY id DESC LIMIT 1");
    if (lastRes.rows.length === 0) {
      await client.query("COMMIT");
      console.log("[DB] No migrations to rollback");
      return null;
    }

    const lastName = lastRes.rows[0].name;
    const migrationFiles = getMigrationFiles();
    const migration = migrationFiles.find((m) => m.name === lastName);

    if (!migration) {
      throw new Error(`Migration file not found for applied migration: ${lastName}`);
    }

    console.log(`[DB] Rolling back migration: ${lastName}`);
    await migration.down(client);
    await client.query("DELETE FROM schema_migrations WHERE name = $1", [lastName]);

    await client.query("COMMIT");
    console.log(`[DB] Rollback of ${lastName} complete`);
    return lastName;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    if (shouldRelease) {
      client.release();
    }
  }
}

async function getMigrationStatus(options = {}) {
  const client = options.client || (await pool.connect());
  const shouldRelease = !options.client;

  try {
    await ensureMigrationTable(client);
    const res = await client.query("SELECT name, applied_at FROM schema_migrations ORDER BY id ASC");
    const appliedMap = new Map(res.rows.map((r) => [r.name, r.applied_at]));

    const migrationFiles = getMigrationFiles();
    return migrationFiles.map((m) => ({
      name: m.name,
      applied: appliedMap.has(m.name),
      appliedAt: appliedMap.get(m.name) || null,
    }));
  } finally {
    if (shouldRelease) {
      client.release();
    }
  }
}

module.exports = {
  runMigrations,
  rollbackLastMigration,
  getMigrationStatus,
  ensureMigrationTable,
  MIGRATION_LOCK_ID,
};
