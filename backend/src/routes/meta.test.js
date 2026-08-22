/**
 * src/routes/meta.test.js
 */
"use strict";

const express = require("express");
const request = require("supertest");
const metaRouter = require("./meta");

function buildApp() {
  const app = express();
  app.use("/api/v1/meta", metaRouter);
  return app;
}

describe("GET /api/v1/meta", () => {
  it("returns service metadata with all expected fields", async () => {
    const res = await request(buildApp()).get("/api/v1/meta");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        name: expect.any(String),
        version: expect.any(String),
        environment: expect.any(String),
        network: expect.any(String),
        node: expect.any(String),
        uptimeSeconds: expect.any(Number),
        timestamp: expect.any(String),
      }),
    );
  });
});
