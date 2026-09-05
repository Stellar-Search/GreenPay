"use strict";

const express = require("express");
const request = require("supertest");
const { Keypair } = require("@stellar/stellar-sdk");
const { apiEnvelope, errorHandler } = require("../middleware/apiEnvelope");

jest.mock("../db/pool", () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock("../middleware/auth", () => ({
  adminRequired: (req, _res, next) => {
    req.admin = { sub: req.headers["x-reviewer"] || "reviewer-a" };
    next();
  },
}));
jest.mock("../services/cache", () => ({ clear: jest.fn() }));

const pool = require("../db/pool");

const ASSESSMENT_ID = "11111111-1111-4111-8111-111111111111";
const APPEAL_ID = "22222222-2222-4222-8222-222222222222";

function buildApp() {
  const app = express();
  app.set("trust proxy", false);
  app.use(express.json());
  app.use(apiEnvelope);
  app.use("/api/integrity", require("./integrity"));
  app.use(errorHandler);
  return app;
}

function transactionClient(handler) {
  return {
    query: jest.fn(handler),
    release: jest.fn(),
  };
}

describe("donation integrity review API", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockReset();
    pool.connect.mockReset();
    app = buildApp();
  });

  test("publishes the signal, disclosure, enforcement, and appeal position", async () => {
    const response = await request(app).get("/api/integrity/policy");

    expect(response.status).toBe(200);
    expect(response.body.data.disclosedSignals).toEqual(expect.arrayContaining([
      "declared wallet relationships",
      "short-window repeated pairs",
      "bounded circular-flow paths",
    ]));
    expect(response.body.data.thresholdDisclosure).toMatch(/live weights.*public/i);
    expect(response.body.data.detectionParameters).toMatchObject({
      reviewScore: 0.7,
      repeatMinimumCount: 3,
      maximumGraphDepth: 3,
    });
    expect(response.body.data.enforcement).toHaveProperty("leaderboard");
    expect(response.body.data.enforcement).toHaveProperty("displayedTotals");
    expect(response.body.data.enforcement).toHaveProperty("impactFigures");
  });

  test("a reviewer confirmation records a case but applies no penalty while enforcement is disabled", async () => {
    const client = transactionClient(async (sql, values) => {
      if (/SELECT \* FROM donation_integrity_assessments/.test(sql)) {
        return { rows: [{ id: ASSESSMENT_ID, review_status: "pending_review" }] };
      }
      if (/SELECT enforcement_enabled/.test(sql)) return { rows: [{ enforcement_enabled: false }] };
      if (/UPDATE donation_integrity_assessments/.test(sql)) {
        return {
          rows: [{
            id: ASSESSMENT_ID,
            review_status: values[1],
            exclude_from_leaderboard: values[2],
            exclude_from_displayed_totals: values[2],
            exclude_from_impact_figures: values[2],
          }],
        };
      }
      return { rows: [] };
    });
    pool.connect.mockResolvedValue(client);

    const response = await request(app)
      .post(`/api/integrity/reviews/${ASSESSMENT_ID}/decision`)
      .send({ action: "confirm", reason: "Transaction flow evidence was independently reviewed and confirmed." });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      review_status: "confirmed",
      exclude_from_leaderboard: false,
      exclude_from_displayed_totals: false,
      exclude_from_impact_figures: false,
    });
    const update = client.query.mock.calls.find(([sql]) => /UPDATE donation_integrity_assessments/.test(sql));
    expect(update[1][2]).toBe(false);
  });

  test("keeps enforcement disabled when the labelled-set gate is not met", async () => {
    const client = transactionClient(async (sql) => ({
      rows: /SELECT l\.label/.test(sql)
        ? Array.from({ length: 10 }, () => ({ label: "legitimate", confidence_score: "0.1" }))
        : [],
    }));
    pool.connect.mockResolvedValue(client);

    const response = await request(app)
      .post("/api/integrity/enforcement/enable")
      .send({ reason: "Enable only after the required independent evaluation has completed." });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("EVALUATION_GATE_NOT_MET");
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  });

  test("enables confirmed-case exclusions only after the labelled evaluation passes", async () => {
    const labels = [
      ...Array.from({ length: 20 }, () => ({ label: "confirmed_abuse", confidence_score: "0.95" })),
      ...Array.from({ length: 80 }, () => ({ label: "legitimate", confidence_score: "0.10" })),
    ];
    const client = transactionClient(async (sql) => {
      if (/SELECT l\.label/.test(sql)) return { rows: labels };
      if (/UPDATE donation_integrity_settings/.test(sql)) {
        return { rows: [{ id: "global", enforcement_enabled: true }] };
      }
      if (/UPDATE donation_integrity_assessments/.test(sql)) return { rows: [{ id: ASSESSMENT_ID }] };
      return { rows: [] };
    });
    pool.connect.mockResolvedValue(client);

    const response = await request(app)
      .post("/api/integrity/enforcement/enable")
      .send({ reason: "The independently reviewed labelled set meets every published quality gate." });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      settings: { enforcement_enabled: true },
      affectedCases: 1,
    });
    expect(client.query.mock.calls.some(([sql]) => (
      /exclude_from_leaderboard = TRUE/.test(sql) && /review_status = 'confirmed'/.test(sql)
    ))).toBe(true);
  });

  test("accepts a signed appeal from an affected wallet and suspends surface exclusions", async () => {
    const wallet = Keypair.random();
    let storedChallenge;
    pool.query.mockImplementation(async (sql, values) => {
      if (/SELECT a\.id/.test(sql)) return { rows: [{ id: ASSESSMENT_ID }] };
      if (/INSERT INTO donation_integrity_appeal_challenges/.test(sql)) {
        storedChallenge = {
          id: values[0],
          assessment_id: values[1],
          wallet_address: values[2],
          challenge: values[3],
          expires_at: values[4],
        };
        return { rows: [] };
      }
      return { rows: [] };
    });

    const challengeResponse = await request(app)
      .post(`/api/integrity/reviews/${ASSESSMENT_ID}/appeal-challenge`)
      .send({ walletAddress: wallet.publicKey() });
    expect(challengeResponse.status).toBe(201);

    const client = transactionClient(async (sql) => {
      if (/FROM donation_integrity_appeal_challenges/.test(sql)) return { rows: [storedChallenge] };
      if (/SELECT \* FROM donation_integrity_assessments/.test(sql)) {
        return { rows: [{ id: ASSESSMENT_ID, review_status: "confirmed" }] };
      }
      return { rows: [] };
    });
    pool.connect.mockResolvedValue(client);
    const signature = wallet.sign(Buffer.from(storedChallenge.challenge, "utf8")).toString("base64");

    const appealResponse = await request(app)
      .post(`/api/integrity/reviews/${ASSESSMENT_ID}/appeals`)
      .send({
        challengeId: storedChallenge.id,
        signature,
        reason: "The transfer was a legitimate return of unused project funds with supporting records.",
      });

    expect(appealResponse.status).toBe(201);
    expect(appealResponse.body.data).toMatchObject({ assessmentId: ASSESSMENT_ID, status: "pending" });
    expect(client.query.mock.calls.some(([sql]) => (
      /exclude_from_leaderboard = FALSE/.test(sql) && /review_status = 'appealed'/.test(sql)
    ))).toBe(true);
  });

  test("requires a different reviewer for an appeal decision", async () => {
    const client = transactionClient(async (sql) => {
      if (/SELECT ap\.\*, a\.decided_by/.test(sql)) {
        return {
          rows: [{
            id: APPEAL_ID,
            assessment_id: ASSESSMENT_ID,
            status: "pending",
            original_reviewer: "reviewer-a",
          }],
        };
      }
      return { rows: [] };
    });
    pool.connect.mockResolvedValue(client);

    const response = await request(app)
      .post(`/api/integrity/appeals/${APPEAL_ID}/decision`)
      .set("x-reviewer", "reviewer-a")
      .send({ outcome: "deny", reason: "The submitted evidence does not explain the circular transaction path." });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INDEPENDENT_REVIEWER_REQUIRED");
  });
});
