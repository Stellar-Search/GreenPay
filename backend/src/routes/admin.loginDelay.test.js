"use strict";
/**
 * routes/admin.loginDelay.test.js
 *
 * Integration test for the real admin login middleware chain (per-IP limiter
 * + per-account progressive delay). Unlike admin.test.js, which stubs both
 * middleware modules out, this suite loads the real router so it proves the
 * acceptance criterion end to end: admin login applies a progressive delay
 * tied to the *account* — not the source address — in addition to the per-IP
 * limit.
 */

const express = require("express");
const request = require("supertest");
const { apiEnvelope, errorHandler } = require("../middleware/apiEnvelope");

jest.mock("../db/pool", () => ({ query: jest.fn() }));
jest.mock("../services/summaryQueue", () => ({
  enqueueAISummary: jest.fn().mockResolvedValue("job-id"),
}));

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use("/api/admin", require("./admin"));
  app.use(errorHandler);
  return app;
}

const login = (app, { username = "admin", password = "wrong" } = {}) =>
  request(app).post("/api/admin/login").send({ username, password });

describe("POST /api/admin/login — progressive per-account delay", () => {
  it("delays further attempts on a throttled account, not on other accounts", async () => {
    const app = buildApp();

    // Five failed attempts put the "admin" account at the threshold; each of
    // these must still resolve quickly (no delay below the threshold).
    for (let i = 0; i < 5; i++) {
      const res = await login(app);
      expect(res.status).toBe(401);
    }

    // Sixth attempt on the same account is delayed (base delay 1000ms).
    const t0 = Date.now();
    const delayed = await login(app);
    const delayedElapsed = Date.now() - t0;
    expect(delayed.status).toBe(401);
    expect(delayedElapsed).toBeGreaterThanOrEqual(900);
    expect(delayed.headers["retry-after"]).toBeDefined();

    // A different account from the same address is not delayed at all — the
    // throttle keys on the account, not the IP.
    const t1 = Date.now();
    const other = await login(app, { username: "operator" });
    const otherElapsed = Date.now() - t1;
    expect(other.status).toBe(401);
    expect(otherElapsed).toBeLessThan(500);
  }, 15000);
});
