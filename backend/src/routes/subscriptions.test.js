"use strict";

const express = require("express");
const request = require("supertest");
const { apiEnvelope, errorHandler } = require("../middleware/apiEnvelope");

jest.mock("../db/pool", () => ({ query: jest.fn() }));
jest.mock("../middleware/rateLimiter", () => ({
  createRateLimiter: () => (_req, _res, next) => next(),
}));

const pool = require("../db/pool");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use("/api/subscriptions", require("./subscriptions"));
  app.use(errorHandler);
  return app;
}

describe("project update subscriptions", () => {
  beforeEach(() => pool.query.mockReset());

  it("records the recipient's preferred content language", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: "project-1" }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp()).post("/api/subscriptions").send({
      projectId: "project-1",
      email: "Donante@Example.com",
      preferredLanguage: "es-MX",
    });

    expect(res.status).toBe(201);
    expect(res.body.data.preferredLanguage).toBe("es");
    expect(pool.query.mock.calls[1][0]).toContain("preferred_language");
    expect(pool.query.mock.calls[1][1]).toEqual(expect.arrayContaining([
      "project-1", "donante@example.com", "es",
    ]));
  });

  it("rejects an unsupported preference", async () => {
    const res = await request(buildApp()).post("/api/subscriptions").send({
      projectId: "project-1",
      email: "donor@example.com",
      preferredLanguage: "fr",
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CONTENT_LANGUAGE_INVALID");
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("returns the current subscriber count", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ count: "12" }] });
    const res = await request(buildApp()).get("/api/subscriptions/project-1/count");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(12);
  });
});
