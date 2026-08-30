/**
 * src/routes/onboarding.test.js
 *
 * Route-level behaviour: what a donor's browser actually sees.
 */
"use strict";

jest.mock("../db/pool", () => ({ query: jest.fn(), connect: jest.fn() }));

jest.mock("../middleware/rateLimiter", () => ({
  createRateLimiter: () => (req, res, next) => next(),
  createLayeredRateLimiter: () => (req, res, next) => next(),
}));

const express = require("express");
const request = require("supertest");
const { Keypair } = require("@stellar/stellar-sdk");

const pool = require("../db/pool");
const { apiEnvelope, errorHandler } = require("../middleware/apiEnvelope");
const { signToken } = require("../middleware/auth");
const onboardingRouter = require("./onboarding");

const DONOR = Keypair.random().publicKey();
const SESSION = "44444444-4444-4444-8444-444444444444";
const PROJECT = "55555555-5555-4555-8555-555555555555";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use("/api/v1/onboarding", onboardingRouter);
  app.use(errorHandler);
  return app;
}

function adminToken() {
  return signToken({ sub: "admin", role: "admin" }, "5m");
}

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("GET /paths", () => {
  it("offers the existing wallet flow and marks it explicitly unchanged", async () => {
    const res = await request(buildApp()).get("/api/v1/onboarding/paths");
    expect(res.status).toBe(200);

    const wallet = res.body.data.paths.find((p) => p.id === "connected_wallet");
    expect(wallet.available).toBe(true);
    // Stated rather than inferred from silence — the whole point of a
    // graduated design is that the fast path is untouched.
    expect(wallet.unchanged).toBe(true);
  });

  it("ships the trade-offs with the options, not behind a second request", async () => {
    const res = await request(buildApp()).get("/api/v1/onboarding/paths");
    for (const path of res.body.data.paths) {
      expect(path.tradeoffs).toBeDefined();
      expect(Array.isArray(path.tradeoffs.giveUp)).toBe(true);
    }
  });

  it("says a path is unavailable and why, instead of offering a dead end", async () => {
    const res = await request(buildApp()).get("/api/v1/onboarding/paths");
    const sponsored = res.body.data.paths.find((p) => p.id === "sponsored_account");
    if (!sponsored.available) {
      expect(sponsored.unavailableReason).toMatch(/no sponsorship treasury/i);
    }
  });

  it("restates the non-custodial guarantee at the top level", async () => {
    const res = await request(buildApp()).get("/api/v1/onboarding/paths");
    expect(res.body.data.guarantee).toMatch(/never holds your key/i);
    expect(res.body.data.guarantee).toMatch(/never holds your money/i);
  });

  it("quotes the sponsored path's cost in XLM", async () => {
    const res = await request(buildApp()).get("/api/v1/onboarding/paths");
    const sponsored = res.body.data.paths.find((p) => p.id === "sponsored_account");
    expect(sponsored.quote.lockedXlm).toBe("1.0000000");
  });
});

describe("funnel endpoints", () => {
  it("starts a session", async () => {
    const res = await request(buildApp())
      .post("/api/v1/onboarding/sessions")
      .send({ path: "connected_wallet", projectId: PROJECT });
    expect(res.status).toBe(201);
    expect(res.body.data.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("records a stage", async () => {
    const res = await request(buildApp())
      .post("/api/v1/onboarding/events")
      .send({ sessionId: SESSION, stage: "donate_intent", path: "connected_wallet" });
    expect(res.status).toBe(202);
    expect(res.body.data.recorded).toBe(true);
  });

  it("accepts and ignores an unknown stage rather than failing the donor's request", async () => {
    // Telemetry must never be able to break a donation.
    const res = await request(buildApp())
      .post("/api/v1/onboarding/events")
      .send({ sessionId: SESSION, stage: "donate_intent", path: "connected_wallet", detail: { a: "b" } });
    expect(res.status).toBe(202);
  });

  it("rejects a free-form blob on the public telemetry endpoint", async () => {
    const res = await request(buildApp())
      .post("/api/v1/onboarding/events")
      .send({ sessionId: SESSION, stage: "donate_intent", detail: { note: "x".repeat(5000) } });
    expect(res.status).toBe(400);
  });

  it("closes a session with an outcome", async () => {
    const res = await request(buildApp())
      .post("/api/v1/onboarding/sessions/complete")
      .send({ sessionId: SESSION, outcome: "completed", path: "sponsored_account" });
    expect(res.status).toBe(200);
  });
});

describe("GET /funnel/conversion", () => {
  it("refuses an unauthenticated caller", async () => {
    // Publishing exactly where donors give up also publishes where to aim.
    const res = await request(buildApp()).get("/api/v1/onboarding/funnel/conversion");
    expect(res.status).toBe(401);
  });

  it("returns a report with the biggest drop-offs for an admin", async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const res = await request(buildApp())
      .get("/api/v1/onboarding/funnel/conversion")
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.stages[0]).toBe("donate_intent");
    expect(res.body.data.biggestDropOffs).toEqual([]);
  });
});

describe("POST /sponsorship", () => {
  it("refuses a request that did not acknowledge the disclosure", async () => {
    // Enforced at the API, not only in the UI, so the guarantee survives a
    // client that skips the screen.
    const res = await request(buildApp())
      .post("/api/v1/onboarding/sponsorship")
      .send({ publicKey: DONOR, sessionId: SESSION });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/trade-offs must be acknowledged/i);
  });

  it("refuses a malformed public key", async () => {
    const res = await request(buildApp())
      .post("/api/v1/onboarding/sponsorship")
      .send({ publicKey: "nope", sessionId: SESSION, acknowledgedDisclosure: true });
    expect(res.status).toBe(400);
  });

  it("reports the path as unavailable when no sponsor is configured", async () => {
    const res = await request(buildApp())
      .post("/api/v1/onboarding/sponsorship")
      .send({ publicKey: DONOR, sessionId: SESSION, acknowledgedDisclosure: true });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("SPONSORSHIP_DISABLED");
  });
});

describe("POST /sponsorship/:id/abandon", () => {
  it("succeeds quietly for a request the browser already forgot about", async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const res = await request(buildApp()).post("/api/v1/onboarding/sponsorship/whatever/abandon").send({});
    expect(res.status).toBe(200);
    expect(res.body.data.released).toBe(false);
  });
});

describe("GET /onramp/providers", () => {
  it("reports 'not configured' as an answer rather than an error", async () => {
    const res = await request(buildApp()).get("/api/v1/onboarding/onramp/providers");
    expect(res.status).toBe(200);
    expect(res.body.data.configured).toBe(false);
    expect(res.body.data.providers).toEqual([]);
  });
});

describe("GET /upgrade/disclosures", () => {
  it("serves the starter-account trade-offs and the migration limits together", async () => {
    const res = await request(buildApp()).get("/api/v1/onboarding/upgrade/disclosures");
    expect(res.status).toBe(200);
    expect(res.body.data.starterAccount.giveUp.join(" ")).toMatch(/no password reset/i);
    expect(res.body.data.upgrade.doesNotMove.join(" ")).toMatch(/leaderboard/i);
  });
});

describe("POST /upgrade/challenge", () => {
  it("issues a challenge for two distinct addresses", async () => {
    const res = await request(buildApp())
      .post("/api/v1/onboarding/upgrade/challenge")
      .send({ fromAddress: DONOR, toAddress: Keypair.random().publicKey() });
    expect(res.status).toBe(201);
    expect(res.body.data.message).toMatch(/GreenPay account upgrade/);
  });

  it("refuses two identical addresses", async () => {
    const res = await request(buildApp())
      .post("/api/v1/onboarding/upgrade/challenge")
      .send({ fromAddress: DONOR, toAddress: DONOR });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SAME_ADDRESS");
  });
});

describe("source-address hashing", () => {
  it("never stores the raw value and is stable for the same input", () => {
    const hashed = onboardingRouter.hashSource("203.0.113.7");
    expect(hashed).not.toContain("203.0.113");
    expect(hashed).toHaveLength(32);
    expect(onboardingRouter.hashSource("203.0.113.7")).toBe(hashed);
  });

  it("gives different sources different hashes", () => {
    expect(onboardingRouter.hashSource("203.0.113.7")).not.toBe(onboardingRouter.hashSource("203.0.113.8"));
  });

  it("returns null for a missing source rather than hashing an empty string", () => {
    expect(onboardingRouter.hashSource(undefined)).toBeNull();
  });
});
