"use strict";

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

jest.mock("../eventSourcing/commandBus", () => ({
  execute: jest.fn(),
  DonationReplayConflictError: class DonationReplayConflictError extends Error {
    constructor(transactionHash, mismatches) {
      super(`Transaction ${transactionHash} is already recorded with different details (${mismatches.join("; ")})`);
      this.name = "DonationReplayConflictError";
      this.code = "DONATION_TX_CONFLICT";
      this.status = 409;
      this.transactionHash = transactionHash;
      this.mismatches = mismatches;
    }
  },
}));

jest.mock("../middleware/rateLimiter", () => ({
  createRateLimiter: () => (req, res, next) => next(),
  createLayeredRateLimiter: () => (req, res, next) => next(),
}));
jest.mock("../services/donationIntegrity", () => ({
  queueDonationAssessment: jest.fn().mockResolvedValue({}),
}));

const pool = require("../db/pool");
const { execute, DonationReplayConflictError } = require("../eventSourcing/commandBus");
const { computeBadges } = require("../services/store");
const { DonationRecordedEvent } = require("../eventSourcing/events");
const { recordDonation } = require("./donations");

const { Keypair } = require("@stellar/stellar-sdk");
const _keys = Array.from({ length: 26 }, () => Keypair.random().publicKey());
function makePublicKey(char = "A") {
  const index = Math.abs(char.charCodeAt(0) - 65) % 26;
  return _keys[index];
}

function makeTxHash(char = "a") {
  return char.repeat(64);
}

function queryResult(rows = []) {
  return { rows };
}

function makeDonationRecordedEvent({ projectId, donorAddress, amountXlm, transactionHash, currency = "XLM", message = null }) {
  return new DonationRecordedEvent({
    aggregateId: transactionHash,
    version: 1,
    actor: donorAddress,
    projectId,
    donorAddress,
    amountXlm,
    currency,
    message,
    transactionHash,
  });
}

function createMockResponse() {
  return {
    statusCode: 200,
    body: null,
    meta: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    apiMeta(meta) {
      this.meta = meta;
      return this;
    },
    json(payload) {
      if (this.statusCode >= 400) {
        this.body = {
          success: false,
          error: {
            code: payload.code || "ERROR",
            message: payload.message || payload.error,
          },
        };
      } else {
        this.body = {
          success: true,
          data: payload,
        };
        if (this.meta !== undefined) {
          this.body.meta = this.meta;
        }
      }
      return this;
    },
  };
}

async function invokeRecordDonation(body) {
  const req = { body };
  const res = createMockResponse();
  const next = jest.fn((err) => {
    if (err) {
      res.status(err.status || 500).json({ code: err.code || "ERROR", message: err.message || "Internal server error" });
    }
  });

  await recordDonation(req, res, next);
  return { req, res, next };
}

function expectBadge(totalXLM, tier) {
  const badges = computeBadges(totalXLM);

  if (!tier) {
    expect(badges).toEqual([]);
    return;
  }

  expect(badges).toEqual([
    expect.objectContaining({
      tier,
      earnedAt: expect.any(String),
    }),
  ]);
}

describe("donations route badge calculation", () => {
  test("awards no badge at 0 XLM", () => {
    expectBadge(0, null);
  });

  test("awards no badge at 9 XLM", () => {
    expectBadge(9, null);
  });

  test("awards Seedling at 10 XLM", () => {
    expectBadge(10, "seedling");
  });

  test("keeps Seedling at 99 XLM", () => {
    expectBadge(99, "seedling");
  });

  test("awards Tree at 100 XLM", () => {
    expectBadge(100, "tree");
  });

  test("keeps Tree at 499 XLM", () => {
    expectBadge(499, "tree");
  });

  test("awards Forest at 500 XLM", () => {
    expectBadge(500, "forest");
  });

  test("keeps Forest at 1999 XLM", () => {
    expectBadge(1999, "forest");
  });

  test("awards Earth Guardian at 2000 XLM", () => {
    expectBadge(2000, "earth");
  });
});

describe("POST /api/donations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("records a valid donation and dispatches it through the command bus", async () => {
    const donorAddress = makePublicKey("A");
    const transactionHash = makeTxHash("a");

    pool.query.mockResolvedValueOnce(queryResult([{ id: "project-1" }])); // project lookup

    const donationEvent = makeDonationRecordedEvent({
      projectId: "project-1",
      donorAddress,
      amountXlm: "10",
      transactionHash,
    });
    execute.mockResolvedValueOnce({
      events: [donationEvent],
      data: { donationId: donationEvent.eventId, amountXlm: "10.0000000" },
      deduplicated: false,
    });

    const { res, next } = await invokeRecordDonation({
      projectId: "project-1",
      donorAddress,
      amountXLM: "10",
      transactionHash,
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(
      expect.objectContaining({
        id: donationEvent.eventId,
        projectId: "project-1",
        donorAddress,
        amountXlm: "10.0000000",
        currency: "XLM",
        transactionHash,
      }),
    );

    expect(execute).toHaveBeenCalledTimes(1);
    const dispatchedCommand = execute.mock.calls[0][0];
    expect(dispatchedCommand.commandType).toBe("RecordDonation");
    expect(dispatchedCommand.payload).toEqual(
      expect.objectContaining({ projectId: "project-1", donorAddress, transactionHash }),
    );
  });

  test("returns 404 for an unknown project id", async () => {
    pool.query.mockResolvedValueOnce(queryResult([]));

    const { res, next } = await invokeRecordDonation({
      projectId: "missing-project",
      donorAddress: makePublicKey("B"),
      amountXLM: "15",
      transactionHash: makeTxHash("b"),
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatchObject({ code: "PROJECT_NOT_FOUND", message: "Project not found" });
    expect(execute).not.toHaveBeenCalled();
  });

  test("returns 400 for an invalid public key", async () => {
    const { res, next } = await invokeRecordDonation({
      projectId: "project-1",
      donorAddress: "not-a-stellar-key",
      amountXLM: "15",
      transactionHash: makeTxHash("c"),
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatchObject({ code: "VALIDATION_FAILED", message: "Invalid Stellar public key" });
    expect(pool.query).not.toHaveBeenCalled();
  });

  test("returns 400 for an invalid transaction hash", async () => {
    const { res, next } = await invokeRecordDonation({
      projectId: "project-1",
      donorAddress: makePublicKey("C"),
      amountXLM: "15",
      transactionHash: "bad-hash",
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatchObject({ code: "VALIDATION_FAILED", message: "Invalid transaction hash" });
    expect(pool.query).not.toHaveBeenCalled();
  });

  test("deduplicates duplicate transaction hashes and returns the existing record", async () => {
    const donorAddress = makePublicKey("D");
    const transactionHash = makeTxHash("d");

    pool.query.mockResolvedValueOnce(queryResult([{ id: "project-1" }]));
    execute.mockResolvedValueOnce({
      data: { id: "donation-existing", transactionHash, amountXlm: 25 },
      deduplicated: true,
    });

    const { res, next } = await invokeRecordDonation({
      projectId: "project-1",
      donorAddress,
      amountXLM: "25",
      transactionHash,
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual(
      expect.objectContaining({
        id: "donation-existing",
        transactionHash,
        amountXlm: 25,
      }),
    );
    expect(res.body.meta.deduplicated).toBe(true);
  });

  test("returns 409 and flags a suspicious replay when fields disagree with the stored donation", async () => {
    const donorAddress = makePublicKey("D");
    const transactionHash = makeTxHash("d");

    pool.query.mockResolvedValueOnce(queryResult([{ id: "project-1" }]));
    execute.mockRejectedValueOnce(
      new DonationReplayConflictError(transactionHash, [
        "amount (stored 25.0000000, received 30.0000000)",
      ]),
    );

    const { res, next } = await invokeRecordDonation({
      projectId: "project-1",
      donorAddress,
      amountXLM: "30",
      transactionHash,
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatchObject({
      code: "DONATION_TX_CONFLICT",
      message: "Transaction hash already recorded with different details",
    });
  });

  test("propagates command bus failures to the error handler", async () => {
    pool.query.mockResolvedValueOnce(queryResult([{ id: "project-4" }]));
    execute.mockRejectedValueOnce(new Error("profile write failed"));

    const { res, next } = await invokeRecordDonation({
      projectId: "project-4",
      donorAddress: makePublicKey("G"),
      amountXLM: "12",
      transactionHash: makeTxHash("a"),
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].message).toBe("profile write failed");
    expect(res.statusCode).toBe(500);
  });
});
