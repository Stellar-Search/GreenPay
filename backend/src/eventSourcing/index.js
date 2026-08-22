"use strict";

const pool = require("../db/pool");
const { eventStore } = require("./eventStore");
const { runLegacyMigration, rebuildReadModels } = require("./migrate");
const { runMigrations } = require("../db/migrate");

async function initializeEventSourcing() {
  console.log("[EventSourcing] Initializing...");

  await ensureEventStoreSchema();
  console.log("[EventSourcing] Event store schema verified");

  const migrationResult = await runLegacyMigration();
  console.log(`[EventSourcing] Legacy migration: ${JSON.stringify(migrationResult)}`);

  await eventStore.startScheduler();
  console.log("[EventSourcing] Event dispatch scheduler started");
}

async function ensureEventStoreSchema() {
  await runMigrations();
  console.log("[EventSourcing] Schema applied");
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
