"use strict";

jest.mock("../db/pool", () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

const pool = require("../db/pool");
const { LEGACY_DONATION_MIGRATED, MigratedDonationEvent, fromPayload } = require("./events");
const { dispatchToProjections } = require("./projections");
const { runLegacyMigration, verifyMigration, replayUnprojectedMigratedEvents } = require("./migrate");

function makeClient() {
  return {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: jest.fn(),
  };
}

describe("Legacy Migration Mismatches Fix", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe("Goal 1: Canonical Constant Sharing", () => {
    it("defines and exports LEGACY_DONATION_MIGRATED as MigratedDonation", () => {
      expect(LEGACY_DONATION_MIGRATED).toBe("MigratedDonation");
    });

    it("uses LEGACY_DONATION_MIGRATED as static EVENT_TYPE on MigratedDonationEvent", () => {
      expect(MigratedDonationEvent.EVENT_TYPE).toBe(LEGACY_DONATION_MIGRATED);
    });

    it("deserializes payload with LEGACY_DONATION_MIGRATED into MigratedDonationEvent", () => {
      const payload = {
        aggregateId: "don-123",
        aggregateType: "MigratedDonation",
        eventType: LEGACY_DONATION_MIGRATED,
        version: 1,
        actor: "system",
        originalId: "orig-123",
        data: {
          projectId: "proj-1",
          donorAddress: "GABC",
          amountXlm: 100,
          currency: "XLM",
          transactionHash: "tx-hash-1",
        },
      };
      const event = fromPayload(payload);
      expect(event).toBeInstanceOf(MigratedDonationEvent);
      expect(event.eventType).toBe(LEGACY_DONATION_MIGRATED);
    });
  });

  describe("Goal 2: Subscriber Registry & Warning on Missing Subscribers", () => {
    it("logs a console.warn when dispatching an event type with no subscribers", async () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      const client = makeClient();
      const dummyEvent = { eventType: "UnregisteredEvent", data: {} };

      await dispatchToProjections(client, dummyEvent);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("No subscribers registered for event type \"UnregisteredEvent\"")
      );
      warnSpy.mockRestore();
    });

    it("does not log a warning when dispatching a registered event like LEGACY_DONATION_MIGRATED", async () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      const client = makeClient();
      const event = new MigratedDonationEvent({
        originalId: "orig-1",
        donationId: "don-1",
        version: 1,
        actor: "system",
        projectId: "proj-1",
        donorAddress: "GABC",
        amountXlm: 50,
        currency: "XLM",
        transactionHash: "tx-1",
      });

      await dispatchToProjections(client, event);

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("Goal 3: Migration Verification Integrity", () => {
    it("verifyMigration uses canonical event type and performs total checks", async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === "string") {
          if (sql.includes("COUNT(DISTINCT (payload->'data'->>'transactionHash'))")) {
            return Promise.resolve({ rows: [{ count: "10" }] });
          }
          if (sql.includes("SUM((payload->'data'->>'amountXlm')::numeric)")) {
            return Promise.resolve({ rows: [{ total: "500" }] });
          }
          if (sql.includes("FROM donations WHERE currency = 'XLM'")) {
            return Promise.resolve({ rows: [{ total: "500" }] });
          }
          if (sql.includes("COUNT(DISTINCT (payload->'data'->>'donorAddress'))")) {
            return Promise.resolve({ rows: [{ count: "5" }] });
          }
          if (sql.includes("COUNT(DISTINCT donor_address)")) {
            return Promise.resolve({ rows: [{ count: "5" }] });
          }
          if (sql.includes("isMatch' = 'true'")) {
            return Promise.resolve({ rows: [{ count: "2" }] });
          }
          if (sql.includes("SUM(matched_xlm::numeric)")) {
            return Promise.resolve({ rows: [{ total: "100" }] });
          }
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const result = await verifyMigration(10, 10);

      expect(result.uniqueTxHashesMatch).toBe(true);
      expect(result.xlmTotalMatch).toBe(true);
      expect(result.uniqueDonorsMatch).toBe(true);

      const firstCallSql = pool.query.mock.calls[0][0];
      expect(firstCallSql).toContain("event_type IN ('DonationRecorded', $1)");
      expect(pool.query.mock.calls[0][1]).toEqual([LEGACY_DONATION_MIGRATED]);
    });

    it("runLegacyMigration throws an error if verification count checks fail", async () => {
      const client = makeClient();
      pool.connect.mockResolvedValue(client);

      pool.query.mockImplementation((sql) => {
        if (typeof sql === "string") {
          if (sql.includes("FROM donations WHERE currency = 'XLM'")) {
            return Promise.resolve({ rows: [{ total: "100" }] }); // legacy total 100
          }
          if (sql.includes("SUM((payload->'data'->>'amountXlm')::numeric)")) {
            return Promise.resolve({ rows: [{ total: "0" }] }); // event total 0 -> mismatch!
          }
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      await expect(runLegacyMigration()).rejects.toThrow("Migration verification failed");
    });
  });

  describe("Goal 4: Idempotent Replay Mechanism", () => {
    it("skips replay if already performed", async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === "string" && sql.includes("migrated-donation-replay")) {
          return Promise.resolve({ rows: [{ id: "migrated-donation-replay" }] });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const result = await replayUnprojectedMigratedEvents();

      expect(result).toEqual({ status: "already_migrated", eventsReplayed: 0 });
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it("updates legacy event type strings, resets processed status, and records replay state", async () => {
      pool.query.mockResolvedValue({ rows: [] }); // Not done yet

      const client = makeClient();
      client.query.mockImplementation((sql) => {
        if (typeof sql === "string") {
          if (sql.includes("UPDATE event_stream") && sql.includes("SET event_type")) {
            return Promise.resolve({ rows: [], rowCount: 5 });
          }
          if (sql.includes("SET processed = false")) {
            return Promise.resolve({ rows: [], rowCount: 5 });
          }
          if (sql.includes("event_store_migration_state")) {
            return Promise.resolve({ rows: [], rowCount: 1 });
          }
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      pool.connect.mockResolvedValue(client);

      const result = await replayUnprojectedMigratedEvents();

      expect(result).toEqual({ status: "completed", eventsReplayed: 5 });

      const clientCalls = client.query.mock.calls;
      const eventTypeUpdate = clientCalls.find(([sql]) => sql.includes("SET event_type = $1"));
      expect(eventTypeUpdate[0]).toContain("WHERE event_type = 'LegacyDonationMigrated'");
      expect(eventTypeUpdate[1]).toEqual([LEGACY_DONATION_MIGRATED]);

      const resetProcessed = clientCalls.find(([sql]) => sql.includes("SET processed = false"));
      expect(resetProcessed[0]).toContain("WHERE (aggregate_type = 'MigratedDonation' OR event_type = $1)");
      expect(resetProcessed[1]).toEqual([LEGACY_DONATION_MIGRATED]);

      const insertState = clientCalls.find(([sql]) => sql.includes("migrated-donation-replay"));
      expect(insertState[0]).toContain("INSERT INTO event_store_migration_state");
    });
  });
});
