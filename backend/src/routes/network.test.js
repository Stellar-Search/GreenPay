"use strict";

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

const express = require("express");
const supertest = require("supertest");
const pool = require("../db/pool");
const networkRouter = require("./network");
const { apiEnvelope, errorHandler } = require("../middleware/apiEnvelope");

function buildApp() {
  const app = express();
  app.use(apiEnvelope);
  app.use("/api/network", networkRouter);
  app.use(errorHandler);
  return app;
}

describe("GET /api/network/graph", () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  it("aggregates donation and escrow rows into a deduplicated node/edge graph", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          { source: "GDONOR1", target: "GPROJECT1", amount: "10", txHash: "tx1", type: "donation", createdAt: "2026-01-01" },
          { source: "GDONOR1", target: "GPROJECT2", amount: "5", txHash: "tx2", type: "donation", createdAt: "2026-01-02" },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { source: "GCLIENT1", target: "GDONOR1", amount: "20", txHash: "tx3", type: "escrow", createdAt: "2026-01-03" },
        ],
      });

    const res = await supertest(buildApp()).get("/api/network/graph");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.edges).toHaveLength(3);

    const donor1 = res.body.data.nodes.find((n) => n.id === "GDONOR1");
    expect(donor1.totalOut).toBe(15);
    expect(donor1.totalIn).toBe(20);
    expect(donor1.degree).toBe(3);
  });

  it("clamps the limit query param to the maximum allowed edges", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });

    const res = await supertest(buildApp()).get("/api/network/graph?limit=999999999");

    expect(res.status).toBe(200);
    expect(pool.query).toHaveBeenNthCalledWith(1, expect.any(String), [50000]);
  });

  it("propagates database errors to the error handler", async () => {
    pool.query.mockRejectedValueOnce(new Error("db down"));

    const res = await supertest(buildApp()).get("/api/network/graph");

    expect(res.status).toBe(500);
  });
});
