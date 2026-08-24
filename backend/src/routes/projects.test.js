"use strict";
const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const { signToken } = require("../middleware/auth");
const { apiEnvelope, errorHandler } = require("../middleware/apiEnvelope");

process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "testpass";
process.env.JWT_SECRET = "test-secret-for-jest";

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const WALLET_ADDRESS = "GDPROJECTOWNERPUBLICWALLETADDRESSXXXXXXXXXXXXXXXXXXXXXXXX";

function makeProjectRow(overrides = {}) {
  return {
    id: PROJECT_ID,
    name: "Reforest the Delta",
    description: "desc",
    category: "Reforestation",
    location: "Delta",
    wallet_address: WALLET_ADDRESS,
    goal_xlm: "1000",
    raised_xlm: "0",
    donor_count: 0,
    co2_offset_kg: 0,
    status: "paused",
    rejection_reason: null,
    verified: false,
    on_chain_verified: false,
    tags: [],
    ai_summary: null,
    ai_summary_generated_at: null,
    ai_summary_model: null,
    ai_summary_source_hash: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

jest.mock("../services/audit", () => ({
  logAdminAction: jest.fn(),
}));

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

const pool = require("../db/pool");
const { logAdminAction } = require("../services/audit");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use("/api/projects", require("./projects"));
  app.use(errorHandler);
  return app;
}

describe("PATCH /api/projects/:id/status", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    pool.query.mockReset();
    logAdminAction.mockReset();
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes("SELECT * FROM projects")) {
        return { rows: [makeProjectRow()] };
      }
      if (sql.includes("UPDATE projects")) {
        return { rows: [makeProjectRow({ status: "active" })] };
      }
      return { rows: [] };
    });
  });

  it("rejects a request with no Authorization header and no adminAddress at all", async () => {
    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}/status`)
      .send({ status: "active" });

    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("rejects a request with no Authorization header and an arbitrary spoofed adminAddress", async () => {
    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}/status`)
      .send({ status: "active", adminAddress: "GSOMEUNRELATEDATTACKERADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXX" });

    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("rejects a request whose adminAddress exactly matches the project's public wallet_address, absent a real token", async () => {
    // wallet_address is public (shown on the project's own page), so an attacker
    // can always supply this exact value. It must not grant anything on its own.
    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}/status`)
      .send({ status: "active", adminAddress: WALLET_ADDRESS });

    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("rejects a well-formed but unsigned-by-us token", async () => {
    const forgedToken = jwt.sign({ role: "admin", sub: "admin" }, "some-other-secret", { expiresIn: "1h" });

    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}/status`)
      .set("Authorization", `Bearer ${forgedToken}`)
      .send({ status: "active", adminAddress: WALLET_ADDRESS });

    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("rejects an expired admin token", async () => {
    const expired = signToken({ role: "admin", sub: "admin" }, "0s");
    await new Promise((r) => setTimeout(r, 100));

    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}/status`)
      .set("Authorization", `Bearer ${expired}`)
      .send({ status: "active" });

    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("allows a valid admin JWT to change status, and records the verified admin as actor rather than any client-supplied adminAddress", async () => {
    const token = signToken({ role: "admin", sub: "admin" }, "1h");

    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "active", adminAddress: "GSOMEUNRELATEDATTACKERADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXX" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("active");

    expect(logAdminAction).toHaveBeenCalledTimes(1);
    const call = logAdminAction.mock.calls[0][0];
    expect(call.actor).toBe("admin");
    expect(call.actor).not.toBe("GSOMEUNRELATEDATTACKERADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXX");
  });

  it("still validates the status enum for an authenticated admin", async () => {
    const token = signToken({ role: "admin", sub: "admin" }, "1h");

    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "not-a-real-status" });

    expect(res.status).toBe(400);
  });
});
