/**
 * src/routes/onboarding.sponsor.test.js
 *
 * The onboarding routes with a sponsor **configured**.
 *
 * onboarding.test.js covers the sponsor-disabled deployment, which is the
 * default and therefore the path unit tests naturally exercise. That left the
 * enabled path — the one that actually matters to a donor — untested at the
 * route level, and it shipped a 500: the reserve model works in BigInt, and
 * `res.json()` cannot serialize BigInt, so every sponsorship quote failed with
 * "Do not know how to serialize a BigInt" the moment a treasury was configured.
 *
 * These tests exist so that class of bug cannot come back: every response this
 * router can produce with sponsorship enabled is asserted to survive JSON.
 */
"use strict";

jest.mock("../db/pool", () => ({ query: jest.fn(), connect: jest.fn() }));

jest.mock("../middleware/rateLimiter", () => ({
  createRateLimiter: () => (req, res, next) => next(),
  createLayeredRateLimiter: () => (req, res, next) => next(),
}));

const { Keypair } = require("@stellar/stellar-sdk");

// Configured before the router is required, because env is read at module load.
const SPONSOR = Keypair.random();
process.env.SPONSOR_SECRET_KEY = SPONSOR.secret();

const express = require("express");
const request = require("supertest");

const pool = require("../db/pool");
const { apiEnvelope, errorHandler } = require("../middleware/apiEnvelope");
const { signToken } = require("../middleware/auth");
const sponsored = require("../services/onboarding/sponsoredAccounts");
const onboardingRouter = require("./onboarding");

const DONOR = Keypair.random().publicKey();
const SESSION = "44444444-4444-4444-8444-444444444444";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use("/api/v1/onboarding", onboardingRouter);
  app.use(errorHandler);
  return app;
}

/** Fails if any BigInt survives into the response payload. */
function assertSerializable(body) {
  expect(() => JSON.stringify(body)).not.toThrow();
  const walk = (value, path) => {
    expect(`${path}:${typeof value}`).not.toMatch(/bigint$/);
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
    }
  };
  walk(body, "body");
}

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("with a sponsor configured", () => {
  it("reports the sponsored path as available", async () => {
    const res = await request(buildApp()).get("/api/v1/onboarding/paths");
    const path = res.body.data.paths.find((p) => p.id === "sponsored_account");

    expect(path.available).toBe(true);
    expect(path.unavailableReason).toBeNull();
    expect(path.quote.lockedXlm).toBe("1.0000000");
  });

  it("still reports the existing wallet flow as unchanged", async () => {
    // Turning sponsorship on must not alter the path most donations take.
    const res = await request(buildApp()).get("/api/v1/onboarding/paths");
    const wallet = res.body.data.paths.find((p) => p.id === "connected_wallet");

    expect(wallet.available).toBe(true);
    expect(wallet.unchanged).toBe(true);
  });

  it("serves a quote instead of a 500", async () => {
    // The regression: this returned "Do not know how to serialize a BigInt".
    jest.spyOn(sponsored, "quoteSponsorship").mockResolvedValue({
      allowed: true,
      cost: { entries: 2, totalXlm: "1.0000000", totalStroops: "10000000" },
      accountExists: false,
      sponsorPublicKey: SPONSOR.publicKey(),
      quote: { lockedXlm: "1.0000000", disclosure: [], recoverable: true },
      limits: {},
    });

    const res = await request(buildApp())
      .post("/api/v1/onboarding/sponsorship/quote")
      .send({ publicKey: DONOR, sessionId: SESSION });

    expect(res.status).toBe(200);
    expect(res.body.data.quote.lockedXlm).toBe("1.0000000");
    assertSerializable(res.body);
  });

  it("returns a JSON-safe payload from the real quote path, with no BigInt anywhere", async () => {
    // Exercises the genuine service — the layer where the BigInt originated —
    // rather than a mock that could not reproduce the bug.
    jest.spyOn(sponsored, "accountExists").mockResolvedValue(false);
    jest.spyOn(sponsored, "readTreasuryBalanceStroops").mockResolvedValue(BigInt(5_000_000_000));

    const result = await sponsored.quoteSponsorship({
      publicKey: DONOR,
      sessionId: SESSION,
      ipHash: "hashed",
    });

    expect(result.allowed).toBe(true);
    assertSerializable(result);
    expect(result.cost.totalXlm).toBe("1.0000000");
    expect(result.cost.totalStroops).toBe("10000000");
  });

  it("keeps the ledger response serializable", async () => {
    jest.spyOn(sponsored, "readTreasuryBalanceStroops").mockResolvedValue(BigInt(1_010_000_000));
    pool.query.mockResolvedValue({
      rows: [
        {
          active: 2, pending: 1, reclaimed: 0, failed: 0,
          locked_stroops: "20000000", reserved_stroops: "10000000", reclaim_failures: 0,
        },
      ],
    });

    const res = await request(buildApp())
      .get("/api/v1/onboarding/sponsorship/ledger")
      .set("Authorization", `Bearer ${signToken({ sub: "admin" }, "5m")}`);

    expect(res.status).toBe(200);
    assertSerializable(res.body);
    expect(res.body.data.enabled).toBe(true);
    expect(res.body.data.perAccountCostXlm).toBe("1.0000000");
    expect(res.body.data.lockedXlm).toBe("2.0000000");
  });

  it("still refuses a request that did not acknowledge the disclosure", async () => {
    const res = await request(buildApp())
      .post("/api/v1/onboarding/sponsorship")
      .send({ publicKey: DONOR, sessionId: SESSION });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/trade-offs must be acknowledged/i);
  });
});
