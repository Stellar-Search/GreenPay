"use strict";
const express = require("express");
const request = require("supertest");
const { apiEnvelope, errorHandler } = require("../middleware/apiEnvelope");

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

const pool = require("../db/pool");
const cache = require("../services/cache");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use("/api/impact", require("./impact"));
  app.use(errorHandler);
  return app;
}

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const DONOR_KEY = "G" + "A".repeat(55);

describe("GET /api/impact", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    cache.clear();
    app = buildApp();
  });

  describe("GET /api/impact/project/:id", () => {
    it("rejects a non-UUID id before touching the database", async () => {
      const res = await request(app).get("/api/impact/project/not-a-uuid");

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_PROJECT_ID");
      expect(pool.query).not.toHaveBeenCalled();
    });

    it("returns 404 when the project does not exist", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get(`/api/impact/project/${PROJECT_ID}`);

      expect(res.status).toBe(404);
    });

    it("caches by project id, not the full request URL", async () => {
      pool.query
        .mockResolvedValueOnce({
          rows: [{ id: PROJECT_ID, category: "reforestation", raised_xlm: "100", co2_offset_kg: 50 }],
        })
        .mockResolvedValueOnce({ rows: [{ totalDonationsXLM: "10", donorCount: 2 }] });

      const first = await request(app).get(`/api/impact/project/${PROJECT_ID}`);
      expect(first.status).toBe(200);
      expect(pool.query).toHaveBeenCalledTimes(2);

      // A different query string must hit the same cache entry rather than
      // minting a new one keyed on req.originalUrl.
      const second = await request(app).get(`/api/impact/project/${PROJECT_ID}?cachebuster=${Date.now()}`);
      expect(second.status).toBe(200);
      expect(pool.query).toHaveBeenCalledTimes(2); // no additional queries
      expect(second.body).toEqual(first.body);
    });
  });

  describe("GET /api/impact/donor/:publicKey", () => {
    it("rejects an invalid Stellar public key before touching the database", async () => {
      const res = await request(app).get("/api/impact/donor/not-a-key");

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_PUBLIC_KEY");
      expect(pool.query).not.toHaveBeenCalled();
    });

    it("caches by donor public key", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ totalDonatedXLM: "5", projectsSupported: 1, co2OffsetKg: 3 }] })
        .mockResolvedValueOnce({ rows: [{ category: "clean-water" }] });

      const first = await request(app).get(`/api/impact/donor/${DONOR_KEY}`);
      expect(first.status).toBe(200);
      expect(pool.query).toHaveBeenCalledTimes(2);

      const second = await request(app).get(`/api/impact/donor/${DONOR_KEY}`);
      expect(second.status).toBe(200);
      expect(pool.query).toHaveBeenCalledTimes(2);
    });
  });

  describe("GET /api/impact/global", () => {
    it("serves the second request from cache", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ totalDonationsXLM: "10", donorCount: 2, co2OffsetKg: "5" }] })
        .mockResolvedValueOnce({ rows: [] });

      const first = await request(app).get("/api/impact/global");
      expect(first.status).toBe(200);
      expect(pool.query).toHaveBeenCalledTimes(2);

      const second = await request(app).get("/api/impact/global");
      expect(second.status).toBe(200);
      expect(pool.query).toHaveBeenCalledTimes(2);
    });
  });
});
