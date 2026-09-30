"use strict";

const express = require("express");
const request = require("supertest");
const { apiEnvelope, errorHandler } = require("../middleware/apiEnvelope");

jest.mock("../db/pool", () => ({ query: jest.fn() }));
const pool = require("../db/pool");

function app() {
  const server = express();
  server.use(apiEnvelope);
  server.use("/api/stats", require("./stats"));
  server.use(errorHandler);
  return server;
}

describe("GET /api/stats/global", () => {
  beforeEach(() => jest.clearAllMocks());

  it("reports donation facts and claim counts without summing legacy CO2", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        totalDonations: 7,
        totalXLMRaised: "42.5",
        publishedImpactClaims: 3,
        verifiedImpactClaims: 1,
      }],
    });

    const response = await request(app()).get("/api/stats/global");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      totalDonations: 7,
      totalXLMRaised: "42.5000000",
      publishedImpactClaims: 3,
      verifiedImpactClaims: 1,
    });
    expect(pool.query.mock.calls[0][0]).not.toMatch(/co2_offset_kg|totalCO2OffsetKg/);
  });
});
