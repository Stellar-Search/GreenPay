"use strict";

const express = require("express");
const request = require("supertest");
const { apiEnvelope, errorHandler } = require("../middleware/apiEnvelope");
const { decodeCursor } = require("../utils/pagination");

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));
jest.mock("../services/donationIntegrity", () => ({
  queueDonationAssessment: jest.fn().mockResolvedValue({}),
}));

const pool = require("../db/pool");

/** searchProjects runs one listing query plus six facet aggregations. */
function mockProjectListingQueries(listingRows) {
  pool.query
    .mockResolvedValueOnce({ rows: listingRows })
    .mockResolvedValueOnce({ rows: [{ count: listingRows.length }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use("/api/projects", require("./projects"));
  app.use("/api/donations", require("./donations"));
  app.use("/api/admin", require("./admin"));
  app.use(errorHandler);
  return app;
}

describe("Keyset Pagination & Cursor Stability", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  describe("Cursor Encoding & Error Handling", () => {
    it("returns HTTP 400 with INVALID_CURSOR for malformed cursors", async () => {
      const res = await request(app)
        .get("/api/projects")
        .query({ cursor: "v1.not_valid_json_base64!!!" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("INVALID_CURSOR");
    });

    it("returns HTTP 400 with UNSUPPORTED_CURSOR_VERSION for unsupported cursor version", async () => {
      const res = await request(app)
        .get("/api/projects")
        .query({ cursor: "v2.eyJmb28iOiJiYXIifQ" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("UNSUPPORTED_CURSOR_VERSION");
    });

    it("returns nextCursor in response envelope meta when hasMore is true", async () => {
      mockProjectListingQueries([
        { id: "11111111-1111-1111-1111-111111111111", name: "P1", description: "D1", category: "Solar Energy", location: "L1", wallet_address: "W1", goal_xlm: "100", raised_xlm: "50", donor_count: 1, co2_offset_kg: 10, status: "active", verified: true, on_chain_verified: false, tags: [], created_at: "2026-08-26T12:00:00.000Z", updated_at: "2026-08-26T12:00:00.000Z" },
        { id: "22222222-2222-2222-2222-222222222222", name: "P2", description: "D2", category: "Solar Energy", location: "L2", wallet_address: "W2", goal_xlm: "200", raised_xlm: "100", donor_count: 2, co2_offset_kg: 20, status: "active", verified: true, on_chain_verified: false, tags: [], created_at: "2026-08-26T11:00:00.000Z", updated_at: "2026-08-26T11:00:00.000Z" },
        { id: "33333333-3333-3333-3333-333333333333", name: "P3", description: "D3", category: "Solar Energy", location: "L3", wallet_address: "W3", goal_xlm: "300", raised_xlm: "150", donor_count: 3, co2_offset_kg: 30, status: "active", verified: true, on_chain_verified: false, tags: [], created_at: "2026-08-26T10:00:00.000Z", updated_at: "2026-08-26T10:00:00.000Z" },
      ]);

      const res = await request(app).get("/api/projects").query({ limit: 2 });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.meta.hasMore).toBe(true);
      expect(res.body.meta.nextCursor).toBeDefined();

      const decoded = decodeCursor(res.body.meta.nextCursor);
      expect(decoded).toEqual({
        createdAt: "2026-08-26T11:00:00.000Z",
        id: "22222222-2222-2222-2222-222222222222",
      });
    });
  });

  describe("Keyset Total Ordering Guarantees", () => {
    it("includes id tiebreaker in project queries", async () => {
      mockProjectListingQueries([]);

      await request(app).get("/api/projects");

      const sql = pool.query.mock.calls[0][0];
      // The alias is optional: the list query joins for localization and so
      // qualifies its columns, but the tiebreaker is what is under test.
      expect(sql).toMatch(/ORDER BY (?:p\.)?created_at DESC, (?:p\.)?id DESC/);
    });

    it("includes id tiebreaker in donation messages queries", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await request(app).get("/api/donations/project/11111111-1111-1111-1111-111111111111/messages");

      const sql = pool.query.mock.calls[0][0];
      expect(sql).toMatch(/ORDER BY amount DESC, created_at DESC, id DESC/);
    });
  });
});
