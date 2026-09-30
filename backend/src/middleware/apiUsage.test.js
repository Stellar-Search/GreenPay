"use strict";

const express = require("express");
const request = require("supertest");
const {
  cleanDimension,
  createApiUsageMiddleware,
  getUsageSnapshot,
  resetUsageForTests,
} = require("./apiUsage");

describe("API usage telemetry", () => {
  beforeEach(resetUsageForTests);

  it("measures endpoint usage by API, client, and client release", async () => {
    const records = [];
    const app = express();
    app.use(createApiUsageMiddleware({ log: (record) => records.push(record) }));
    app.get("/api/v1/projects/:id", (_req, res) => res.status(200).json({ ok: true }));

    await request(app)
      .get("/api/v1/projects/7b94379a-ef24-4dc9-a2af-cbe5151f2d10")
      .set("X-Client-Name", "mobile")
      .set("X-Client-Version", "4.2.1")
      .set("X-Client-API-Version", "1")
      .expect(200);

    expect(records).toContainEqual(expect.objectContaining({
      event: "api_request",
      apiVersion: "v1",
      requestedVersion: "v1",
      clientName: "mobile",
      clientVersion: "4.2.1",
      clientApiVersion: "1",
      endpoint: "/api/v1/projects/:id",
      statusCode: 200,
      deprecated: false,
    }));
    expect(getUsageSnapshot().series).toContainEqual(expect.objectContaining({
      clientName: "mobile",
      clientVersion: "4.2.1",
      count: 1,
    }));
  });

  it("marks legacy traffic while attributing it to its v1 implementation", async () => {
    const records = [];
    const app = express();
    app.use(createApiUsageMiddleware({ log: (record) => records.push(record) }));
    app.use("/api", (_req, res) => res.redirect(308, "/api/v1/projects"));

    await request(app).get("/api/projects").set("X-Client-Name", "extension").expect(308);
    expect(records[0]).toEqual(expect.objectContaining({
      apiVersion: "v1",
      requestedVersion: "legacy",
      clientName: "extension",
      endpoint: "/api/projects",
      deprecated: true,
    }));
  });

  it("bounds invalid or attacker-controlled dimension values", () => {
    expect(cleanDimension("Mobile-Preview+12")).toBe("mobile-preview+12");
    expect(cleanDimension("contains spaces and / separators")).toBe("unknown");
    expect(cleanDimension("x".repeat(65))).toBe("unknown");
  });
});
