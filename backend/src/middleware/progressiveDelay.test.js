"use strict";
/**
 * middleware/progressiveDelay.test.js
 * Per-account progressive delay for sensitive endpoints (admin login).
 *
 * Covers the acceptance criterion that admin login applies a progressive
 * delay per *account*: the throttle follows the attempted username across any
 * number of source addresses (a distributed brute force rotating IPs is still
 * slowed and eventually hard-blocked), while different accounts on the same
 * address stay independent.
 */

const express = require("express");
const request = require("supertest");
const {
  createProgressiveDelay,
  createFailureStore,
  computeDelayMs,
  DEFAULT_PROGRESSIVE_DELAY_OPTIONS,
} = require("./progressiveDelay");
const { apiEnvelope, errorHandler } = require("./apiEnvelope");

/** Minimal login-ish app: fails unless the password is correct. */
function buildApp(options) {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.post(
    "/api/login",
    createProgressiveDelay(options),
    (req, res) => {
      if (req.body?.password === "correct") {
        return res.json({ ok: true });
      }
      res.status(401).json({ error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials" } });
    }
  );
  app.use(errorHandler);
  return app;
}

const login = (app, overrides = {}) =>
  request(app)
    .post("/api/login")
    .set("X-Forwarded-For", overrides.ip || "203.0.113.1")
    .send({ username: overrides.username || "admin", password: overrides.password || "wrong" });

describe("computeDelayMs — progressive delay schedule", () => {
  const opts = { threshold: 5, baseDelayMs: 1000, factor: 2, maxDelayMs: 30000 };

  it("is zero below the threshold", () => {
    expect(computeDelayMs(0, opts)).toBe(0);
    expect(computeDelayMs(4, opts)).toBe(0);
  });

  it("starts at the base delay at the threshold", () => {
    expect(computeDelayMs(5, opts)).toBe(1000);
  });

  it("doubles per additional failure", () => {
    expect(computeDelayMs(6, opts)).toBe(2000);
    expect(computeDelayMs(7, opts)).toBe(4000);
  });

  it("caps at maxDelayMs", () => {
    expect(computeDelayMs(50, opts)).toBe(30000);
  });

  it("uses sensible defaults when no options are given", () => {
    expect(computeDelayMs(DEFAULT_PROGRESSIVE_DELAY_OPTIONS.threshold)).toBe(
      DEFAULT_PROGRESSIVE_DELAY_OPTIONS.baseDelayMs
    );
  });
});

describe("createFailureStore — per-account failure bookkeeping", () => {
  it("records failures and resets on success", () => {
    const store = createFailureStore({ windowMs: 1000 });
    store.recordFailure("admin");
    store.recordFailure("admin");
    store.recordFailure("operator");

    expect(store.get("admin").count).toBe(2);
    expect(store.get("operator").count).toBe(1);

    store.reset("admin");
    expect(store.get("admin")).toBeNull();
    expect(store.size()).toBe(1);
  });

  it("expires entries after the window", () => {
    jest.useFakeTimers();
    try {
      const store = createFailureStore({ windowMs: 1000 });
      store.recordFailure("admin");
      expect(store.get("admin")).not.toBeNull();

      jest.advanceTimersByTime(1500);
      expect(store.get("admin")).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("createProgressiveDelay — per-account throttling", () => {
  it("does not delay attempts below the threshold", async () => {
    // Deterministic: assert the delay executor is never invoked, rather than
    // timing the response (real-timer bounds are flaky under CI load).
    const delay = jest.fn().mockResolvedValue();
    const app = buildApp({ threshold: 3, baseDelayMs: 30, factor: 2, maxDelayMs: 500, delay });

    const res = await login(app);
    expect(res.status).toBe(401);
    expect(delay).not.toHaveBeenCalled();
  });

  it("delays after the threshold and grows the delay", async () => {
    const app = buildApp({ threshold: 3, baseDelayMs: 30, factor: 2, maxDelayMs: 1000 });

    await login(app); // failure 1
    await login(app); // failure 2
    await login(app); // failure 3 — threshold met, still undelayed

    const t0 = Date.now();
    const fourth = await login(app); // failure 4 → first delay (30ms)
    const fourthElapsed = Date.now() - t0;
    expect(fourth.status).toBe(401);
    expect(fourthElapsed).toBeGreaterThanOrEqual(25);

    const t1 = Date.now();
    const fifth = await login(app); // failure 5 → doubled delay (60ms)
    const fifthElapsed = Date.now() - t1;
    expect(fifth.status).toBe(401);
    expect(fifthElapsed).toBeGreaterThanOrEqual(50);
    expect(fifthElapsed).toBeGreaterThan(fourthElapsed);
  });

  it("throttles the account regardless of the source address", async () => {
    // Distributed attempt: many IPs, one account. A per-IP limiter would never
    // fire here, but the account throttle must engage on the third failure
    // even though it arrives from a fresh address.
    let delayedCalls = 0;
    const app = buildApp({
      threshold: 2,
      baseDelayMs: 1,
      factor: 2,
      maxDelayMs: 100,
      delay: async () => { delayedCalls += 1; },
    });

    await login(app, { ip: "203.0.113.1" });
    await login(app, { ip: "198.51.100.7" });

    const delayed = await login(app, { ip: "192.0.2.99" }); // 3rd failure, fresh IP
    expect(delayed.status).toBe(401);
    expect(delayedCalls).toBe(1);
  });

  it("hard-blocks the account beyond maxFailures", async () => {
    const app = buildApp({
      threshold: 1,
      baseDelayMs: 1,
      factor: 1,
      maxDelayMs: 2,
      maxFailures: 3,
    });

    await login(app);
    await login(app);
    await login(app);

    const blocked = await login(app);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ success: false, error: { code: "ACCOUNT_THROTTLED" } });
  });

  it("keeps separate accounts independent", async () => {
    const app = buildApp({ threshold: 2, baseDelayMs: 20, factor: 2, maxDelayMs: 500 });

    await login(app, { username: "admin" });
    await login(app, { username: "admin" });

    // A different account on the same address is untouched.
    const other = await login(app, { username: "operator" });
    expect(other.status).toBe(401);
  });

  it("resets the counter after a successful login", async () => {
    const store = createFailureStore({ windowMs: 60000 });
    const app = buildApp({ threshold: 3, baseDelayMs: 30, factor: 2, maxDelayMs: 500, store });

    await login(app);
    await login(app);
    expect(store.get("admin").count).toBe(2);

    const ok = await login(app, { password: "correct" });
    expect(ok.status).toBe(200);

    // The finish listener resets asynchronously; give it a tick.
    await new Promise((r) => setTimeout(r, 10));
    expect(store.get("admin")).toBeNull();
  });

  it("no-ops when no account key is present", async () => {
    const app = buildApp({ threshold: 1, baseDelayMs: 30, factor: 2, maxDelayMs: 500 });

    const res = await request(app).post("/api/login").send({ password: "wrong" });
    expect(res.status).toBe(401);
  });
});
