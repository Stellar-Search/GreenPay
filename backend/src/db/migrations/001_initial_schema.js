"use strict";

const fs = require("fs");
const path = require("path");

const schemaSql = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");

module.exports = {
  id: 1,
  name: "001_initial_schema",
  async up(client) {
    await client.query(schemaSql);
  },
  async down(client) {
    await client.query(`
      DROP TABLE IF EXISTS ai_summary_job_failures CASCADE;
      DROP TABLE IF EXISTS event_store_migration_state CASCADE;
      DROP TABLE IF EXISTS indexer_state CASCADE;
      DROP TABLE IF EXISTS match_state CASCADE;
      DROP TABLE IF EXISTS donor_stats CASCADE;
      DROP TABLE IF EXISTS event_stream CASCADE;
      DROP TABLE IF EXISTS project_follows CASCADE;
      DROP TABLE IF EXISTS admin_audit_log CASCADE;
      DROP TABLE IF EXISTS device_tokens CASCADE;
      DROP TABLE IF EXISTS donation_matches CASCADE;
      DROP TABLE IF EXISTS project_ratings CASCADE;
      DROP TABLE IF EXISTS project_milestones CASCADE;
      DROP TABLE IF EXISTS project_campaigns CASCADE;
      DROP TABLE IF EXISTS jobs CASCADE;
      DROP TABLE IF EXISTS project_subscriptions CASCADE;
      DROP TABLE IF EXISTS project_updates CASCADE;
      DROP TABLE IF EXISTS profiles CASCADE;
      DROP TABLE IF EXISTS donations CASCADE;
      DROP TABLE IF EXISTS projects CASCADE;
    `);
  },
};
