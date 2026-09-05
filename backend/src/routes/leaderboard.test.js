"use strict";
const express = require("express");
const request = require("supertest");
const { apiEnvelope, errorHandler } = require("../middleware/apiEnvelope");

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

const pool = require("../db/pool");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use("/api/leaderboard", require("./leaderboard"));
  app.use(errorHandler);
  return app;
}

describe("GET /api/leaderboard", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  describe("query validation", () => {
    it.each([
      ["limit=0", { limit: 0 }],
      ["limit=201", { limit: 201 }],
      ["offset=-1", { offset: -1 }],
      ["offset=10001", { offset: 10001 }],
      ["period=lifetime", { period: "lifetime" }],
    ])("returns 400 for %s", async (_label, query) => {
      const res = await request(app).get("/api/leaderboard").query(query);
      expect(res.status).toBe(400);
      expect(pool.query).not.toHaveBeenCalled();
    });

    it("accepts a request with no query params, defaulting period to all", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total: "0" }] });

      const res = await request(app).get("/api/leaderboard");

      expect(res.status).toBe(200);
      expect(pool.query.mock.calls[0][0]).toMatch(/FROM donor_stats/);
    });
  });

  describe("period=all", () => {
    it("reads from donor_stats and returns rank, entries, and pagination meta", async () => {
      pool.query
        .mockResolvedValueOnce({
          rows: [
            {
              public_key: "GDONOR1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
              display_name: "Alice",
              badges: [{ tier: "tree" }],
              total_donated_xlm: "150.0000000",
              projects_supported: 3,
              rank: "1",
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ total: "42" }] });

      const res = await request(app).get("/api/leaderboard").query({ period: "all", limit: 10, offset: 0 });

      expect(res.status).toBe(200);
      expect(res.body.meta.pagination).toMatchObject({ total: 42, limit: 10, offset: 0, hasMore: false, isTotalExact: true });
      expect(res.body.data).toEqual([
        {
          rank: 1,
          publicKey: "GDONOR1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          displayName: "Alice",
          totalDonatedXLM: "150.0000000",
          projectsSupported: 3,
          topBadge: "tree",
        },
      ]);

      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toMatch(/FROM donor_stats/);
      expect(sql).toMatch(/GREATEST\(ds\.total_donated_xlm - COALESCE\(ia\.excluded_xlm, 0\), 0\)/);
      expect(sql).toMatch(/exclude_from_leaderboard = TRUE/);
      expect(params).toEqual([11]);
      expect(pool.query.mock.calls[1][0]).toMatch(/FROM donor_stats/);
    });

    it("passes limit and offset through to the query for absolute-position pagination when offset is given", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total: "0" }] });

      await request(app).get("/api/leaderboard").query({ period: "all", limit: 20, offset: 40 });

      expect(pool.query.mock.calls[0][1]).toEqual([21, 40]);
    });

    it("supports opaque versioned cursor for keyset pagination", async () => {
      const { encodeCursor } = require("../utils/pagination");
      const cursor = encodeCursor({ totalDonatedXlm: "150.0000000", publicKey: "GDONOR1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });

      pool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total: "42" }] });

      const res = await request(app).get("/api/leaderboard").query({ period: "all", limit: 10, cursor });

      expect(res.status).toBe(200);
      expect(pool.query.mock.calls[0][0]).toMatch(/total_donated_xlm < \$1::numeric OR \(total_donated_xlm = \$1::numeric AND public_key > \$2\)/);
    });
  });

  describe("period=month and period=year", () => {
    it.each(["month", "year"])("joins donations with the same rank/tiebreak treatment for period=%s", async (period) => {
      pool.query
        .mockResolvedValueOnce({
          rows: [
            {
              public_key: "GDONOR2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
              display_name: null,
              badges: [],
              total_donated_xlm: "0",
              projects_supported: 0,
              rank: "2",
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ total: "7" }] });

      const res = await request(app).get("/api/leaderboard").query({ period, limit: 5, offset: 5 });

      expect(res.status).toBe(200);
      expect(res.body.meta.pagination).toMatchObject({ total: 7, limit: 5, offset: 5, hasMore: false, isTotalExact: true });
      expect(res.body.data[0]).toMatchObject({ rank: 2, publicKey: "GDONOR2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });

      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toMatch(/LEFT JOIN surface_donations d/);
      expect(sql).toMatch(/event_type = 'DonationRecorded'/);
      expect(sql).toMatch(/ROW_NUMBER\(\) OVER \(\s*ORDER BY COALESCE\(SUM\(d\.amount_xlm\), 0\) DESC, p\.public_key ASC\s*\)/);
      // The window is bound as a parameter rather than interpolated, so the
      // interval literal appears in the values array, not the SQL text.
      expect(sql).toContain("NOW() - ($1::interval)");
      expect(params).toEqual([period === "month" ? "30 days" : "1 year", 6, 5]);
      expect(pool.query.mock.calls[1][0]).toMatch(/FROM profiles/);
    });
  });

  it("propagates database errors to the error handler", async () => {
    pool.query.mockRejectedValueOnce(new Error("connection lost"));

    const res = await request(app).get("/api/leaderboard");

    expect(res.status).toBe(500);
  });
});
