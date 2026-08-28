"use strict";

jest.mock("../db/pool", () => ({ query: jest.fn(), connect: jest.fn() }));

const {
  REVIEW_SCORE,
  assessDonation,
  evaluateLabelledSet,
  observedDonationsCte,
  queueDonationAssessment,
  _test,
} = require("./donationIntegrity");

const { Keypair } = require("@stellar/stellar-sdk");
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const DONOR = Keypair.random().publicKey();
const DESTINATION = Keypair.random().publicKey();

function observation(overrides = {}) {
  return {
    transactionHash: "a".repeat(64),
    projectId: PROJECT_ID,
    donorAddress: DONOR,
    destinationAddress: DESTINATION,
    amountXlm: "10.0000000",
    observedSource: "indexer_horizon",
    observedAt: "2026-08-28T10:00:00.000Z",
    ...overrides,
  };
}

function scoringDb({ relationship = null, rapid = null, circular = null } = {}) {
  const queries = [];
  const db = {
    query: jest.fn(async (sql, values) => {
      queries.push({ sql, values });
      if (/SELECT \* FROM donation_integrity_assessments WHERE transaction_hash/.test(sql)) return { rows: [] };
      if (/INSERT INTO donation_integrity_assessments/.test(sql)) {
        return { rows: [{ id: "assessment-1", review_status: "monitoring", observed_source: "indexer_horizon" }] };
      }
      if (/FROM project_wallet_relationships/.test(sql) && /relationship_type/.test(sql)) {
        return { rows: relationship ? [relationship] : [] };
      }
      if (/pair_count/.test(sql)) {
        return { rows: [rapid || { pair_count: 0, same_amount_count: 0 }] };
      }
      if (/WITH RECURSIVE paths/.test(sql)) return { rows: circular ? [circular] : [] };
      if (/UPDATE donation_integrity_assessments/.test(sql) && /RETURNING \*/.test(sql)) {
        return {
          rows: [{
            id: "assessment-1",
            confidence_score: values[1],
            review_status: values[2],
            exclude_from_leaderboard: false,
          }],
        };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  return { db, queries };
}

describe("donation integrity scoring", () => {
  beforeEach(() => {
    _test.controlledWallets.clear();
    _test.watchedWallets.clear();
  });

  test("combines independent confidence without exceeding one", () => {
    expect(_test.combinedConfidence([{ confidence: 0.5 }, { confidence: 0.5 }])).toBeCloseTo(0.75);
    expect(_test.combinedConfidence([{ confidence: 1 }, { confidence: 0.9 }])).toBe(1);
  });

  test("detects a controlled-wallet self-donation and routes it to review without enforcement", async () => {
    const { db, queries } = scoringDb({
      relationship: { relationship_type: "owner", source: "wallet_proof", confidence: "1" },
    });

    const result = await assessDonation(db, observation());

    expect(result.signals).toEqual([
      expect.objectContaining({ type: "self_donation", confidence: 1 }),
    ]);
    expect(result.assessment.review_status).toBe("pending_review");
    expect(Number(result.assessment.confidence_score)).toBeGreaterThanOrEqual(REVIEW_SCORE);
    expect(result.assessment.exclude_from_leaderboard).toBe(false);
    expect(queries.some(({ sql }) => /INSERT INTO donation_integrity_events/.test(sql))).toBe(true);
  });

  test("scores rapid repeated donations between the same address pair", async () => {
    const { db } = scoringDb({
      rapid: { pair_count: 4, same_amount_count: 4, window_start: new Date(), window_end: new Date() },
    });

    const result = await assessDonation(db, observation());

    expect(result.signals[0]).toMatchObject({ type: "rapid_repeat_pair" });
    expect(result.signals[0].confidence).toBeGreaterThanOrEqual(0.8);
    expect(result.assessment.review_status).toBe("pending_review");
  });

  test("scores a bounded circular path with depth in its review evidence", async () => {
    const { db } = scoringDb({
      circular: {
        path: [DESTINATION, Keypair.random().publicKey(), DONOR],
        depth: 2,
        first_seen: new Date("2026-08-28T09:00:00Z"),
        last_seen: new Date("2026-08-28T09:05:00Z"),
      },
    });

    const result = await assessDonation(db, observation());

    expect(result.signals[0]).toMatchObject({
      type: "circular_flow",
      confidence: 0.82,
      evidence: { depth: 2 },
    });
  });
});

describe("queue, evaluation, and surface queries", () => {
  test("upserts an indexer observation into the durable assessment queue", async () => {
    const db = { query: jest.fn(async () => ({ rows: [{ transaction_hash: "a".repeat(64) }] })) };
    await queueDonationAssessment(db, observation());
    expect(db.query).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO donation_integrity_queue/),
      expect.arrayContaining(["a".repeat(64), PROJECT_ID, DONOR, DESTINATION, "10.0000000", "indexer_horizon"]),
    );
  });

  test("measures false-positive rate and opens enforcement only after the labelled gate", async () => {
    const rows = [
      ...Array.from({ length: 20 }, () => ({ label: "confirmed_abuse", confidence_score: "0.95" })),
      ...Array.from({ length: 80 }, () => ({ label: "legitimate", confidence_score: "0.10" })),
    ];
    const ready = await evaluateLabelledSet({ query: jest.fn(async () => ({ rows })) });
    expect(ready).toMatchObject({
      totalLabels: 100,
      falsePositiveRate: 0,
      recall: 1,
      enforcementReady: true,
    });

    rows[20].confidence_score = "0.95";
    rows[21].confidence_score = "0.95";
    const tooManyFalsePositives = await evaluateLabelledSet({ query: jest.fn(async () => ({ rows })) });
    expect(tooManyFalsePositives.falsePositiveRate).toBe(0.025);
    expect(tooManyFalsePositives.enforcementReady).toBe(false);
  });

  test.each([
    ["leaderboard", "exclude_from_leaderboard"],
    ["displayedTotals", "exclude_from_displayed_totals"],
    ["impactFigures", "exclude_from_impact_figures"],
  ])("builds a confirmed-only %s donation surface", (surface, column) => {
    const sql = observedDonationsCte(surface);
    expect(sql).toMatch(/event_stream/);
    expect(sql).toMatch(/donations/);
    expect(sql).toContain(`a.${column} = TRUE`);
    expect(sql).toMatch(/a\.review_status = 'confirmed'/);
  });
});
