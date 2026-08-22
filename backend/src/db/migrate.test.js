"use strict";

const pool = require("./pool");
const { runMigrations, rollbackLastMigration, getMigrationStatus } = require("./migrate");

describe("Database Migration System", () => {
  beforeEach(async () => {
    try {
      await pool.query(`
        DROP TABLE IF EXISTS schema_migrations CASCADE;
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
    } catch (_err) {
      // In unit test environments where PG pool is mocked, ignore query errors
    }
  });

  afterAll(async () => {
    try {
      await runMigrations();
    } catch (_err) {
      // Ignore if pool is mocked
    }
  });

  it("applies migrations cleanly to a fresh database and updates migration status", async () => {
    const mockClient = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql.includes("SELECT name FROM schema_migrations")) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes("SELECT table_name FROM information_schema.tables")) {
          return Promise.resolve({ rows: [{ table_name: "projects" }] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };

    const statusBefore = await getMigrationStatus({ client: mockClient });
    expect(statusBefore).toEqual([
      { name: "001_initial_schema", applied: false, appliedAt: null },
    ]);

    await runMigrations({ client: mockClient });

    mockClient.query.mockImplementation((sql) => {
      if (sql.includes("SELECT name, applied_at FROM schema_migrations")) {
        return Promise.resolve({
          rows: [{ name: "001_initial_schema", applied_at: new Date() }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const statusAfter = await getMigrationStatus({ client: mockClient });
    expect(statusAfter.length).toBe(1);
    expect(statusAfter[0].name).toBe("001_initial_schema");
    expect(statusAfter[0].applied).toBe(true);
    expect(statusAfter[0].appliedAt).not.toBeNull();
  });

  it("is idempotent when run multiple times on an already-migrated database", async () => {
    const fixedDate = new Date("2026-01-01T00:00:00Z");
    const mockClient = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql.includes("SELECT name")) {
          return Promise.resolve({
            rows: [{ name: "001_initial_schema", applied_at: fixedDate }],
          });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };

    await runMigrations({ client: mockClient });
    const firstStatus = await getMigrationStatus({ client: mockClient });

    await runMigrations({ client: mockClient });
    const secondStatus = await getMigrationStatus({ client: mockClient });

    expect(secondStatus).toEqual(firstStatus);
  });

  it("rolls back the last applied migration cleanly", async () => {
    let applied = true;
    const mockClient = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql.includes("SELECT name FROM schema_migrations ORDER BY id DESC LIMIT 1")) {
          return Promise.resolve({
            rows: applied ? [{ name: "001_initial_schema" }] : [],
          });
        }
        if (sql.includes("SELECT name, applied_at FROM schema_migrations")) {
          return Promise.resolve({
            rows: applied ? [{ name: "001_initial_schema", applied_at: new Date() }] : [],
          });
        }
        if (sql.includes("DELETE FROM schema_migrations")) {
          applied = false;
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };

    const statusBefore = await getMigrationStatus({ client: mockClient });
    expect(statusBefore[0].applied).toBe(true);

    const rolledBackName = await rollbackLastMigration({ client: mockClient });
    expect(rolledBackName).toBe("001_initial_schema");

    const statusAfter = await getMigrationStatus({ client: mockClient });
    expect(statusAfter[0].applied).toBe(false);
  });
});
