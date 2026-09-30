"use strict";

const express = require("express");
const request = require("supertest");
const { apiEnvelope } = require("../middleware/apiEnvelope");
const {
  LEGACY_SUNSET_HTTP,
  apiVersionHeaders,
  createLifecycleRouter,
  legacyRedirect,
  mountApiVersion,
} = require("./lifecycle");

function buildApp() {
  const app = express();
  app.use(apiVersionHeaders);
  app.use(apiEnvelope);

  const shared = express.Router();
  shared.get("/", (_req, res) => res.json({ name: "service", version: "1.0.0" }));

  mountApiVersion(app, "v1", [{ path: "/meta", router: shared }]);
  mountApiVersion(app, "v2", [{
    path: "/meta",
    router: shared,
    transform: (value) => ({ service: value.name, release: value.version }),
  }]);
  app.use("/api/versions", createLifecycleRouter());
  app.use("/api", legacyRedirect);
  return app;
}

describe("API lifecycle", () => {
  it("serves v1 and v2 concurrently without changing the v1 representation", async () => {
    const app = buildApp();
    const v1 = await request(app).get("/api/v1/meta").expect(200);
    const v2 = await request(app).get("/api/v2/meta").expect(200);

    expect(v1.headers["x-api-version"]).toBe("1");
    expect(v1.body.data).toEqual({ name: "service", version: "1.0.0" });
    expect(v2.headers["x-api-version"]).toBe("2");
    expect(v2.body.data).toEqual({ service: "service", release: "1.0.0" });
  });

  it("publishes machine-readable lifecycle and changelog documents", async () => {
    const app = buildApp();
    const versions = await request(app).get("/api/versions").expect(200);
    const changelog = await request(app).get("/api/versions/changelog").expect(200);

    expect(versions.body.data).toEqual(expect.objectContaining({
      current: "v1",
      versions: expect.arrayContaining([
        expect.objectContaining({ version: "v1", status: "stable" }),
        expect.objectContaining({ version: "v2", status: "experimental" }),
      ]),
      legacy: expect.objectContaining({
        status: "deprecated",
        sunset: "2030-12-31T23:59:59.000Z",
      }),
    }));
    expect(versions.headers["x-api-version"]).toBeUndefined();
    expect(changelog.body.data.entries.length).toBeGreaterThan(0);
  });

  it("redirects legacy methods and queries with complete deprecation signalling", async () => {
    const res = await request(buildApp())
      .post("/api/donations?source=old-mobile")
      .send({ amount: "1" })
      .expect(308);

    expect(res.headers.location).toBe("/api/v1/donations?source=old-mobile");
    expect(res.headers.deprecation).toBe("true");
    expect(res.headers.sunset).toBe(LEGACY_SUNSET_HTTP);
    expect(res.headers.link).toContain("rel=\"successor-version\"");
    expect(res.headers.link).toContain("rel=\"deprecation\"");
    expect(res.headers["x-api-version"]).toBe("1");
  });

  it("rejects invalid version mount definitions at startup", () => {
    expect(() => mountApiVersion(express(), "latest", [])).toThrow("Invalid API version");
    expect(() => mountApiVersion(express(), "v3", [{ path: "meta" }])).toThrow(
      "absolute path",
    );
  });
});
