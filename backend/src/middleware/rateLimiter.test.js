"use strict";
/**
 * middleware/rateLimiter.test.js
 * Integration tests for the express-rate-limit donation limiter.
 *
 * Spins up a minimal Express app with the *real* createRateLimiter (limit=10,
 * window=1 min) — no mocks — then fires requests in sequence and asserts that:
 *   - Requests 1-10 receive HTTP 200.
 *   - Request 11 receives HTTP 429.
 *   - The 429 response includes a `Retry-After` header.
 *
 * The rate-limit store is reset between test suites by creating a fresh app
 * instance for each describe block.
 *
 * Redis is mocked away rather than left to the environment. This suite covers
 * the in-memory fallback, whose defining property — separate app instances hold
 * separate counters — is the exact opposite of the shared-store behaviour
 * rateLimiter.redis.test.js asserts. Without this mock the suite passes or fails
 * depending on whether REDIS_URL happens to be set, which it now is in CI.
 */

jest.mock("../cache/redisClient", () => null);

const express = require("express");
const request = require("supertest");
const { createRateLimiter, createLayeredRateLimiter } = require("./rateLimiter");
const { apiEnvelope, errorHandler } = require("./apiEnvelope");

/** Build a minimal app that applies the given limiter to GET /ping. */
function buildApp(maxRequests = 10, windowMinutes = 1, name = "test-limiter") {
  const app = express();
  const limiter = createRateLimiter(maxRequests, windowMinutes, name);
  app.use(apiEnvelope);
  app.use(limiter);
  app.get("/api/ping", (_req, res) => res.status(200).json({ ok: true }));
  app.use(errorHandler);
  return app;
}

/**
 * Build an app running a layered limiter in front of POST /api/action. The
 * handler echoes the extracted client IP so tests can assert proxy handling.
 */
function buildLayeredApp(layers) {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use(createLayeredRateLimiter(layers));
  app.post("/api/action", (req, res) => res.status(200).json({ ok: true, ip: req.ip }));
  app.use(errorHandler);
  return app;
}

const WALLET_A = "G4VXYKAESZX2MVYX5BQ2HQS2LTDWFOYTD6GQOMFKPGZWQUX2NDITH5M5";
const WALLET_B = "G2AULUXEHXHXON3LB3XESWC64GYAPXM27ECFWL756HH6KXXLLLYUUFRB";
const WALLET_C = "GZOASTMZ7KFWEAOM6WLRGQ7M5U5URIS7M4AGEE3EB7JDW5A5267A43TK";

describe("Rate limiting middleware — donation endpoint", () => {
  let app;

  beforeEach(() => {
    // Fresh app → fresh in-memory store → counters reset to 0
    app = buildApp(10, 1);
  });

  it("allows up to 10 requests within the time window", async () => {
    for (let i = 1; i <= 10; i++) {
      const res = await request(app).get("/api/ping");
      expect(res.status).toBe(200);
    }
  });

  it("blocks the 11th request with HTTP 429", async () => {
    for (let i = 0; i < 10; i++) {
      await request(app).get("/api/ping");
    }

    const res = await request(app).get("/api/ping");
    expect(res.status).toBe(429);
  });

  it("returns a Retry-After header on the 429 response", async () => {
    for (let i = 0; i < 10; i++) {
      await request(app).get("/api/ping");
    }

    const res = await request(app).get("/api/ping");
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("returns a JSON body with a human-readable message on 429", async () => {
    for (let i = 0; i < 10; i++) {
      await request(app).get("/api/ping");
    }

    const res = await request(app).get("/api/ping");
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: expect.any(String),
      },
    });
  });

  it("still blocks request 12 after the 11th was already rejected", async () => {
    for (let i = 0; i < 12; i++) {
      await request(app).get("/api/ping");
    }

    const res = await request(app).get("/api/ping");
    expect(res.status).toBe(429);
  });
});

describe("Rate limiting middleware — custom window", () => {
  it("resets independent counters for separate app instances", async () => {
    const appA = buildApp(2, 1);
    const appB = buildApp(2, 1);

    // Exhaust appA
    await request(appA).get("/api/ping");
    await request(appA).get("/api/ping");
    const blockedOnA = await request(appA).get("/api/ping");
    expect(blockedOnA.status).toBe(429);

    // appB counter is untouched — first request must succeed
    const okOnB = await request(appB).get("/api/ping");
    expect(okOnB.status).toBe(200);
  });
});

describe("Rate limiting middleware — name requirement", () => {
  it("throws when constructed without a name", () => {
    expect(() => createRateLimiter(10, 1)).toThrow(/requires a unique `name`/);
  });
});

describe("Layered rate limiting — shared-NAT clients don't starve each other", () => {
  let app;

  beforeEach(() => {
    // Coarse per-IP floor high enough that the shared test IP never trips it;
    // the real per-wallet cap is what must bite.
    app = buildLayeredApp({
      name: "layered-nat",
      windowMinutes: 1,
      ip: 100,
      wallet: 2,
    });
  });

  it("gives each wallet its own bucket even when they share one IP", async () => {
    const post = (walletAddress) =>
      request(app).post("/api/action").send({ walletAddress });

    // Each wallet can use its own budget (2) without touching the other's.
    expect((await post(WALLET_A)).status).toBe(200);
    expect((await post(WALLET_B)).status).toBe(200);
    expect((await post(WALLET_A)).status).toBe(200);
    expect((await post(WALLET_B)).status).toBe(200);

    // The third request per wallet exceeds that wallet's cap, not the IP's.
    expect((await post(WALLET_A)).status).toBe(429);
    expect((await post(WALLET_B)).status).toBe(429);
  });

  it("falls back to the IP bucket when no wallet is supplied", async () => {
    const post = () => request(app).post("/api/action").send({});

    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    // No wallet in the body → keys on IP, so the per-wallet cap (2) still bites.
    expect((await post()).status).toBe(429);
  });

  it("keys project-owner actions on the adminAddress wallet field", async () => {
    const app = buildLayeredApp({
      name: "layered-admin-wallet",
      windowMinutes: 1,
      ip: 100,
      wallet: 2,
    });
    const post = (adminAddress) => request(app).post("/api/action").send({ adminAddress });

    // Two project owners behind the same IP keep independent buckets.
    expect((await post(WALLET_A)).status).toBe(200);
    expect((await post(WALLET_A)).status).toBe(200);
    expect((await post(WALLET_B)).status).toBe(200);
    // Owner A's third request exceeds only A's wallet cap.
    expect((await post(WALLET_A)).status).toBe(429);
    expect((await post(WALLET_B)).status).toBe(200);
  });
});

describe("Layered rate limiting — distributed attempts stay bounded", () => {
  it("a global cap stops a flood no single client trips", async () => {
    // Each attacker client is under its own per-IP and per-wallet budget, so
    // only the shared global cap can bound the aggregate.
    const app = buildLayeredApp({
      name: "layered-global",
      windowMinutes: 1,
      ip: 100,
      wallet: 100,
      global: 5,
    });
    // Simulate the proxy chain that real deployments sit behind so each
    // request arrives with a distinct source address.
    app.set("trust proxy", 1);

    let lastStatus;
    for (let i = 1; i <= 6; i++) {
      lastStatus = await request(app)
        .post("/api/action")
        .set("X-Forwarded-For", `203.0.113.${i}`)
        .send({ walletAddress: WALLET_C });
      expect(lastStatus.status).toBe(i <= 5 ? 200 : 429);
    }
    expect(lastStatus.status).toBe(429);
  });
});

describe("Rate limiting — proxy trust configuration", () => {
  it("extracts the real client address behind a trusted proxy", async () => {
    const app = buildLayeredApp({
      name: "layered-proxy",
      windowMinutes: 1,
      ip: 2,
      wallet: 100,
    });
    app.set("trust proxy", 1);

    const from = (ip) =>
      request(app).post("/api/action").set("X-Forwarded-For", ip);

    // Two distinct XFF addresses behind the same proxy get separate IP buckets.
    expect((await from("198.51.100.10")).status).toBe(200);
    expect((await from("198.51.100.10")).status).toBe(200);
    // A third request from A hits A's bucket; B remains untouched.
    expect((await from("198.51.100.10")).status).toBe(429);
    expect((await from("198.51.100.20")).status).toBe(200);
  });

  it("echoes the forwarded client IP, not the proxy address", async () => {
    const app = buildLayeredApp({
      name: "layered-proxy-echo",
      windowMinutes: 1,
      ip: 100,
    });
    app.set("trust proxy", 1);

    const res = await request(app)
      .post("/api/action")
      .set("X-Forwarded-For", "198.51.100.42");
    expect(res.status).toBe(200);
    expect(res.body.data.ip).toBe("198.51.100.42");
  });

  it("ignores a forged X-Forwarded-For when no proxy is trusted", async () => {
    // Default trust proxy is off (dev). express-rate-limit logs an
    // ERR_ERL_UNEXPECTED_X_FORWARDED_FOR warning and keys on the socket
    // address, so a client forging X-Forwarded-For cannot mint fresh IP
    // buckets: three different forged addresses still share one bucket.
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const app = buildLayeredApp({ name: "layered-untrusted", windowMinutes: 1, ip: 2 });

    const forged = (ip) =>
      request(app).post("/api/action").set("X-Forwarded-For", ip);

    expect((await forged("198.51.100.9")).status).toBe(200);
    expect((await forged("198.51.100.10")).status).toBe(200);
    expect((await forged("198.51.100.11")).status).toBe(429);

    // The misconfiguration is surfaced loudly rather than silently.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ code: "ERR_ERL_UNEXPECTED_X_FORWARDED_FOR" })
    );
    errorSpy.mockRestore();
  });
});

describe("Layered rate limiting — construction validation", () => {
  it("throws when constructed without a name", () => {
    expect(() =>
      createLayeredRateLimiter({ windowMinutes: 1, ip: 10 })
    ).toThrow(/requires a unique `name`/);
  });

  it("throws when no layer is configured", () => {
    expect(() =>
      createLayeredRateLimiter({ name: "empty", windowMinutes: 1 })
    ).toThrow(/requires at least one of/);
  });

  it("throws on an unknown keyBy dimension", () => {
    expect(() =>
      createRateLimiter(10, 1, "bad-key", { keyBy: "walets" })
    ).toThrow(/unknown keyBy/);
  });
});
