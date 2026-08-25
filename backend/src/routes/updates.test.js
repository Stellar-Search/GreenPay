"use strict";
const express = require("express");
const request = require("supertest");
const { apiEnvelope, errorHandler } = require("../middleware/apiEnvelope");
const { signToken } = require("../middleware/auth");

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

jest.mock("../middleware/rateLimiter", () => ({
  createRateLimiter: () => (req, res, next) => next(),
  createLayeredRateLimiter: () => (req, res, next) => next(),
}));

jest.mock("../services/email", () => ({
  enqueueUpdateNotifications: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../services/push", () => ({
  sendUpdatePushNotifications: jest.fn().mockResolvedValue(undefined),
}));

const pool = require("../db/pool");
const { enqueueUpdateNotifications } = require("../services/email");
const { sendUpdatePushNotifications } = require("../services/push");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use("/api/updates", require("./updates"));
  app.use(errorHandler);
  return app;
}

function adminToken() {
  return signToken({ role: "admin", sub: "admin" }, "1h");
}

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const projectRow = {
  id: PROJECT_ID,
  name: "Reef Cleanup",
  description: "desc",
  category: "ocean",
  location: "here",
  wallet_address: "GABC",
  goal_xlm: "100",
  raised_xlm: "10",
  donor_count: 1,
  co2_offset_kg: 5,
  status: "active",
  verified: true,
  on_chain_verified: false,
  tags: [],
};
const updateRow = {
  id: "22222222-2222-2222-2222-222222222222",
  project_id: PROJECT_ID,
  title: "New photos",
  body: "Great progress this month",
  created_at: new Date().toISOString(),
};

describe("POST /api/updates", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockReset();
    app = buildApp();
  });

  it("enqueues chunked email and push fan-out instead of querying subscribers inline", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [projectRow] }) // project lookup
      .mockResolvedValueOnce({ rows: [updateRow] }); // insert ... returning

    const res = await request(app)
      .post("/api/updates")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ projectId: PROJECT_ID, title: "New photos", body: "Great progress this month" });

    expect(res.status).toBe(201);

    // Only the project lookup and the insert touch the database here — no
    // "SELECT email FROM project_subscriptions" (or device tokens) inline.
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[0][0]).toMatch(/FROM projects/);
    expect(pool.query.mock.calls[1][0]).toMatch(/INSERT INTO project_updates/);

    expect(enqueueUpdateNotifications).toHaveBeenCalledWith({
      project: expect.objectContaining({ id: PROJECT_ID }),
      update: expect.objectContaining({ id: updateRow.id }),
    });
    expect(sendUpdatePushNotifications).toHaveBeenCalledWith({
      project: expect.objectContaining({ id: PROJECT_ID }),
      update: expect.objectContaining({ id: updateRow.id }),
    });
  });

  it("still creates the update even if enqueueing notifications fails", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [projectRow] })
      .mockResolvedValueOnce({ rows: [updateRow] });
    enqueueUpdateNotifications.mockRejectedValueOnce(new Error("queue unavailable"));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app)
      .post("/api/updates")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ projectId: PROJECT_ID, title: "New photos", body: "Great progress this month" });

    expect(res.status).toBe(201);
    // Let the rejected fire-and-forget promise settle before asserting.
    await new Promise((resolve) => setImmediate(resolve));
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to enqueue email notifications"),
      "queue unavailable",
    );

    errorSpy.mockRestore();
  });
});
