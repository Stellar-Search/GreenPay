"use strict";

const request = require("supertest");
const app = require("../server");
const { LEGACY_SUNSET_HTTP } = require("../versioning/lifecycle");

describe("server API lifecycle integration", () => {
  it("serves discovery and the concurrent v2 metadata representation", async () => {
    const versions = await request(app).get("/api/versions").expect(200);
    const v2 = await request(app).get("/api/v2/meta").expect(200);

    expect(versions.body.data.current).toBe("v1");
    expect(versions.body.data.changelog).toBe("/api/versions/changelog");
    expect(v2.headers["x-api-version"]).toBe("2");
    expect(v2.body.data).toEqual(expect.objectContaining({
      service: expect.any(Object),
      runtime: expect.any(Object),
      api: { version: "v2", status: "experimental" },
    }));
  });

  it("redirects an old mutating client before CSRF while preserving method semantics", async () => {
    const response = await request(app)
      .post("/api/donations?source=installed-mobile")
      .send({ amountXLM: "1.0000000" })
      .expect(308);

    expect(response.headers.location).toBe("/api/v1/donations?source=installed-mobile");
    expect(response.headers.deprecation).toBe("true");
    expect(response.headers.sunset).toBe(LEGACY_SUNSET_HTTP);
    expect(response.headers.link).toContain("/api/versions/changelog");
  });
});
