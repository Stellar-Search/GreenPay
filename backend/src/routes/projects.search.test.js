"use strict";

const express = require("express");
const request = require("supertest");
const { apiEnvelope, errorHandler } = require("../middleware/apiEnvelope");

jest.mock("../services/audit", () => ({
  logAdminAction: jest.fn(),
}));

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

jest.mock("../services/projectSearch", () => ({
  searchProjects: jest.fn(),
}));

const pool = require("../db/pool");
const { searchProjects } = require("../services/projectSearch");

function makeProjectRow(overrides = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Reforest the Delta",
    description: "Reforestation project in the delta",
    category: "Reforestation",
    location: "Delta",
    wallet_address: "GTEST",
    goal_xlm: "1000",
    raised_xlm: "250",
    donor_count: 5,
    co2_offset_kg: 100,
    status: "active",
    rejection_reason: null,
    verified: true,
    on_chain_verified: false,
    tags: ["trees"],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use("/api/projects", require("./projects"));
  app.use(errorHandler);
  return app;
}

describe("GET /api/projects search", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    searchProjects.mockReset();
  });

  it("returns projects with search meta and facets", async () => {
    searchProjects.mockResolvedValue({
      rows: [makeProjectRow()],
      meta: {
        total: 1,
        search: "reforestation",
        latencyMs: 12,
        facets: {
          category: { Reforestation: 1 },
          status: { active: 1 },
          verified: { true: 1 },
          location: { Delta: 1 },
          fundingProgress: { under25: 1 },
        },
      },
    });

    const res = await request(app)
      .get("/api/projects")
      .query({ search: "reforestation" })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe("Reforest the Delta");
    expect(res.body.meta.total).toBe(1);
    expect(res.body.meta.facets.category.Reforestation).toBe(1);
    expect(searchProjects).toHaveBeenCalledWith(pool, expect.objectContaining({ search: "reforestation" }), expect.any(Object));
  });
});
