"use strict";

const pool = require("../db/pool");
const { eventStore } = require("./eventStore");
const { runLegacyMigration, rebuildReadModels, normalizeDoublePrefixedStreamIds, replayUnprojectedMigratedEvents } = require("./migrate");

async function initializeEventSourcing() {
  console.log("[EventSourcing] Initializing...");

  await ensureEventStoreSchema();
  console.log("[EventSourcing] Event store schema verified");

  // Must run before the legacy migration: it only rewrites rows that still
  // have the historical double-prefixed stream_id, so fixing them first
  // keeps the event store internally consistent before any new rows (from
  // the legacy migration below, or the live write path) are added.
  const normalizationResult = await normalizeDoublePrefixedStreamIds();
  console.log(`[EventSourcing] Stream id normalization: ${JSON.stringify(normalizationResult)}`);

  const replayResult = await replayUnprojectedMigratedEvents();
  console.log(`[EventSourcing] Migrated donation replay: ${JSON.stringify(replayResult)}`);

  const migrationResult = await runLegacyMigration();
  console.log(`[EventSourcing] Legacy migration: ${JSON.stringify(migrationResult)}`);

  await eventStore.startScheduler();
  console.log("[EventSourcing] Event dispatch scheduler started");
}

async function ensureEventStoreSchema() {
  const schemaPath = require("path").join(__dirname, "..", "db", "schema.sql");
  const fs = require("fs");
  const schemaSql = fs.readFileSync(schemaPath, "utf8");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(schemaSql);
    await client.query("COMMIT");
    console.log("[EventSourcing] Schema applied");
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.message && err.message.includes("already exists")) {
      console.log("[EventSourcing] Schema already present");
    } else {
      throw err;
    }
  } finally {
    client.release();
  }
}

async function getEventStoreStatus() {
  const pendingResult = await pool.query("SELECT COUNT(*) AS count FROM event_stream WHERE processed = false");
  const processedResult = await pool.query("SELECT COUNT(*) AS count FROM event_stream WHERE processed = true");
  const migrationResult = await pool.query("SELECT event_count, migrated_at FROM event_store_migration_state WHERE id = 'legacy'");

  return {
    pendingEvents: parseInt(pendingResult.rows[0]?.count || "0", 10),
    processedEvents: parseInt(processedResult.rows[0]?.count || "0", 10),
    legacyMigrated: !!migrationResult.rows[0],
    legacyEventCount: migrationResult.rows[0]?.event_count || 0,
    migratedAt: migrationResult.rows[0]?.migrated_at || null,
    scheduler: eventStore.getSchedulerStats(),
  };
}

async function shutdownEventSourcing() {
  await eventStore.stopScheduler();
  console.log("[EventSourcing] Shutdown complete");
}

module.exports = {
  initializeEventSourcing,
  getEventStoreStatus,
  shutdownEventSourcing,
  eventStore,
};
