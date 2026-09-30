"use strict";

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

const pool = require("../db/pool");
const {
  execute,
  storeProjectAggregate,
  storeDonorAggregate,
  loadAggregateStream,
  fromRow,
  DonationReplayConflictError,
} = require("./commandBus");
const {
  RecordDonationCommand,
  ApplyMatchCommand,
  ChangeProjectStatusCommand,
  ReachMilestoneCommand,
  ReleaseEscrowCommand,
  CreateMatchOfferCommand,
} = require("./commands");
const { Keypair } = require("@stellar/stellar-sdk");
const { ProjectAggregate } = require("./aggregates");

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

describe("commandBus.js - Event Sourcing Core Engine (Issue #129)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("execute() command routing", () => {
    test("throws error when command handler is not registered", async () => {
      const fakeCommand = { commandType: "NonExistentCommand" };
      await expect(execute(fakeCommand)).rejects.toThrow(
        "No handler registered for command: NonExistentCommand"
      );
    });
  });

  describe("RecordDonationCommand / DonationCommandHandler", () => {
    test("throws validation error when payload is invalid", async () => {
      const cmd = new RecordDonationCommand({
        actor: "actor-1",
        projectId: "",
        donorAddress: "invalid-key",
        amountXlm: "-5",
        transactionHash: "short",
      });
      await expect(execute(cmd)).rejects.toThrow("projectId is required");
    });

    test("rejects XLM amounts with more than seven decimal places", () => {
      const cmd = new RecordDonationCommand({
        actor: "actor-1",
        projectId: "proj-1",
        donorAddress: makePublicKey("A"),
        amountXlm: "1.00000001",
        transactionHash: makeTxHash("a"),
      });

      expect(cmd.validate()).toContain(
        "amount must be a positive XLM amount with at most 7 decimal places"
      );
    });

    test("retains the maximum amount guard for non-XLM donations", () => {
      const cmd = new RecordDonationCommand({
        actor: "actor-1",
        projectId: "proj-1",
        donorAddress: makePublicKey("A"),
        amount: 1e15 + 1,
        currency: "USDC",
        transactionHash: makeTxHash("a"),
      });

      expect(cmd.validate()).toContain("amount exceeds allowed maximum");
    });

    test("deduplicates donation when transaction hash already exists in event_stream", async () => {
      const donorAddress = makePublicKey("A");
      const transactionHash = makeTxHash("a");

      pool.query
        // 1. pre-check: SELECT * ... payload->'data'->>'transactionHash'
        .mockResolvedValueOnce(
          queryResult([
            {
              event_id: "existing-event-id",
              stream_id: `Donation:${transactionHash}`,
              aggregate_type: "Donation",
              aggregate_id: `Donation:${transactionHash}`,
              event_type: "DonationRecorded",
              version: 1,
              aggregate_version: 1,
              payload: {
                data: {
                  projectId: "proj-1",
                  donorAddress,
                  amountXlm: "25.0000000",
                  amountStroops: "250000000",
                  currency: "XLM",
                  message: null,
                  transactionHash,
                },
              },
              actor: donorAddress,
              occurred_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
            },
          ]),
        );

      const cmd = new RecordDonationCommand({
        actor: donorAddress,
        projectId: "proj-1",
        donorAddress,
        amountXlm: "25",
        transactionHash,
      });

      const res = await execute(cmd);
      expect(res.deduplicated).toBe(true);
      expect(res.data.eventId).toBe("existing-event-id");
    });

    test("rejects a replay whose amount disagrees with the stored donation", async () => {
      const donorAddress = makePublicKey("A");
      const transactionHash = makeTxHash("a");

      pool.query.mockResolvedValueOnce(
        queryResult([
          {
            event_id: "existing-event-id",
            stream_id: `Donation:${transactionHash}`,
            aggregate_type: "Donation",
            aggregate_id: `Donation:${transactionHash}`,
            event_type: "DonationRecorded",
            version: 1,
            aggregate_version: 1,
            payload: {
              data: {
                projectId: "proj-1",
                donorAddress,
                amountXlm: "25.0000000",
                amountStroops: "250000000",
                currency: "XLM",
                message: null,
                transactionHash,
              },
            },
            actor: donorAddress,
            occurred_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        ]),
      );

      const cmd = new RecordDonationCommand({
        actor: donorAddress,
        projectId: "proj-1",
        donorAddress,
        amountXlm: "99",
        transactionHash,
      });

      await expect(execute(cmd)).rejects.toBeInstanceOf(DonationReplayConflictError);
    });

    test("recovers into an idempotent success when the insert loses the uniqueness race", async () => {
      const donorAddress = makePublicKey("H");
      const transactionHash = makeTxHash("b");
      const winnerRow = {
        event_id: "winner-event-id",
        stream_id: `Donation:${transactionHash}`,
        aggregate_type: "Donation",
        aggregate_id: `Donation:${transactionHash}`,
        event_type: "DonationRecorded",
        version: 1,
        aggregate_version: 1,
        payload: {
          data: {
            projectId: "proj-100",
            donorAddress,
            amountXlm: "15.5000000",
            amountStroops: "155000000",
            currency: "XLM",
            message: null,
            transactionHash,
          },
        },
        actor: donorAddress,
        occurred_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      };
      const uniqueViolation = new Error(
        "duplicate key value violates unique constraint \"ux_donation_tx_hash\""
      );
      uniqueViolation.code = "23505";

      pool.query
        // 1. pre-check finds nothing (the race window)
        .mockResolvedValueOnce(queryResult([]))
        // 2. project check
        .mockResolvedValueOnce(queryResult([{ id: "proj-100" }]))
        // 3. getProjectState
        .mockResolvedValueOnce(
          queryResult([{ id: "proj-100", raised_xlm: "0", donor_count: 0, status: "active" }])
        )
        // 4. getDonorState
        .mockResolvedValueOnce(queryResult([]))
        // 5. getNextVersion
        .mockResolvedValueOnce(queryResult([{ max_version: 0 }]))
        // 6. storeProjectAggregate
        .mockResolvedValueOnce(queryResult([]))
        // 7. storeDonorAggregate
        .mockResolvedValueOnce(queryResult([]))
        // 8. INSERT INTO event_stream hits ux_donation_tx_hash
        .mockRejectedValueOnce(uniqueViolation)
        // 9. recovery SELECT returns the winner's row
        .mockResolvedValueOnce(queryResult([winnerRow]));

      const cmd = new RecordDonationCommand({
        actor: donorAddress,
        projectId: "proj-100",
        donorAddress,
        amountXlm: "15.5",
        transactionHash,
      });

      const res = await execute(cmd);
      expect(res.deduplicated).toBe(true);
      expect(res.success).toBe(true);
      expect(res.data.eventId).toBe("winner-event-id");
    });

    test("rethrows non-uniqueness insert failures untouched", async () => {
      const donorAddress = makePublicKey("I");
      const transactionHash = makeTxHash("c");

      pool.query
        .mockResolvedValueOnce(queryResult([])) // pre-check
        .mockResolvedValueOnce(queryResult([{ id: "proj-100" }])) // project check
        .mockResolvedValueOnce(
          queryResult([{ id: "proj-100", raised_xlm: "0", donor_count: 0, status: "active" }])
        )
        .mockResolvedValueOnce(queryResult([])) // getDonorState
        .mockResolvedValueOnce(queryResult([{ max_version: 0 }])) // getNextVersion
        .mockResolvedValueOnce(queryResult([])) // storeProjectAggregate
        .mockResolvedValueOnce(queryResult([])) // storeDonorAggregate
        .mockRejectedValueOnce(new Error("connection refused")); // INSERT fails for another reason

      const cmd = new RecordDonationCommand({
        actor: donorAddress,
        projectId: "proj-100",
        donorAddress,
        amountXlm: "5",
        transactionHash,
      });

      await expect(execute(cmd)).rejects.toThrow("connection refused");
    });

    test("throws error when target project does not exist", async () => {
      const donorAddress = makePublicKey("B");
      const transactionHash = makeTxHash("b");

      pool.query
        // 1. existingCheck
        .mockResolvedValueOnce(queryResult([]))
        // 2. project check
        .mockResolvedValueOnce(queryResult([]));

      const cmd = new RecordDonationCommand({
        actor: donorAddress,
        projectId: "missing-project",
        donorAddress,
        amountXlm: "50",
        transactionHash,
      });

      await expect(execute(cmd)).rejects.toThrow("Project not found");
    });

    test("successfully processes and records valid donation", async () => {
      const donorAddress = makePublicKey("C");
      const transactionHash = makeTxHash("c");

      pool.query
        // 1. existingCheck
        .mockResolvedValueOnce(queryResult([]))
        // 2. project check (SELECT id FROM projects)
        .mockResolvedValueOnce(queryResult([{ id: "proj-100" }]))
        // 3. getProjectState (SELECT * FROM projects)
        .mockResolvedValueOnce(
          queryResult([{ id: "proj-100", raised_xlm: "100.0", donor_count: 5, status: "active" }])
        )
        // 4. getDonorState (SELECT * FROM donor_stats)
        .mockResolvedValueOnce(queryResult([]))
        // 5. getNextVersion (SELECT MAX(version))
        .mockResolvedValueOnce(queryResult([{ max_version: 2 }]))
        // 6. storeProjectAggregate (UPDATE projects)
        .mockResolvedValueOnce(queryResult([]))
        // 7. storeDonorAggregate (INSERT INTO profiles)
        .mockResolvedValueOnce(queryResult([]))
        // 8. INSERT INTO event_stream
        .mockResolvedValueOnce(queryResult([]));

      const cmd = new RecordDonationCommand({
        actor: donorAddress,
        projectId: "proj-100",
        donorAddress,
        amountXlm: "15.5",
        transactionHash,
      });

      const result = await execute(cmd);

      expect(result.deduplicated).toBe(false);
      expect(result.events.length).toBe(1);
      expect(result.events[0].eventType).toBe("DonationRecorded");
      expect(result.data.amountXlm).toBe("15.5000000");

      // Verify INSERT INTO event_stream was called with correct parameters
      const insertCall = pool.query.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO event_stream")
      );
      expect(insertCall).toBeDefined();
      expect(insertCall[1][4]).toBe("DonationRecorded"); // event_type
      expect(insertCall[1][5]).toBe(3); // version (max_version 2 + 1)
    });
  });

  describe("ApplyMatchCommand / ApplyMatchCommandHandler", () => {
    test("throws validation error when matchAmount is non-positive", async () => {
      const cmd = new ApplyMatchCommand({
        actor: "actor-2",
        matchId: "match-1",
        projectId: "proj-1",
        donorAddress: makePublicKey("D"),
        matchAmount: "0",
      });
      await expect(execute(cmd)).rejects.toThrow("matchAmount must be a positive number");
    });

    test("returns deduplicated result if match was already applied for originalTxHash", async () => {
      const donorAddress = makePublicKey("E");
      const originalTxHash = makeTxHash("e");

      pool.query.mockResolvedValueOnce(queryResult([{ event_id: "match-event-1" }]));

      const cmd = new ApplyMatchCommand({
        actor: donorAddress,
        matchId: "match-offer-1",
        projectId: "proj-1",
        donorAddress,
        matchAmount: "10",
        originalTxHash,
        multiplier: 1,
      });

      const res = await execute(cmd);
      expect(res.deduplicated).toBe(true);
      expect(res.data).toBeNull();
    });

    test("successfully applies match to donor stats and appends MatchApplied event", async () => {
      const donorAddress = makePublicKey("F");
      const originalTxHash = makeTxHash("f");

      pool.query
        // 1. existingMatchTx check
        .mockResolvedValueOnce(queryResult([]))
        // 2. getMatchState
        .mockResolvedValueOnce(
          queryResult([{ match_id: "match-10", cap_xlm: "100", matched_xlm: "20" }])
        )
        // 3. getDonorState
        .mockResolvedValueOnce(queryResult([]))
        // 4. getNextVersion
        .mockResolvedValueOnce(queryResult([{ max_version: 0 }]))
        // 5. storeDonorAggregate (profiles insert)
        .mockResolvedValueOnce(queryResult([]))
        // 6. INSERT INTO event_stream
        .mockResolvedValueOnce(queryResult([]));

      const cmd = new ApplyMatchCommand({
        actor: donorAddress,
        matchId: "match-10",
        projectId: "proj-1",
        donorAddress,
        matchAmount: "15",
        originalTxHash,
        multiplier: 2,
      });

      const res = await execute(cmd);
      expect(res.deduplicated).toBe(false);
      expect(res.data).toEqual({ matchId: "match-10", matchAmount: "15" });
      expect(res.events[0].eventType).toBe("MatchApplied");
    });
  });

  describe("ChangeProjectStatusCommand / ChangeProjectStatusCommandHandler", () => {
    test("throws validation error for invalid status value", async () => {
      const cmd = new ChangeProjectStatusCommand({
        actor: "admin",
        projectId: "proj-1",
        status: "invalid_status",
      });
      await expect(execute(cmd)).rejects.toThrow(
        "status must be one of: active, completed, paused, rejected"
      );
    });

    test("throws error if project is not found", async () => {
      pool.query.mockResolvedValueOnce(queryResult([]));

      const cmd = new ChangeProjectStatusCommand({
        actor: "admin",
        projectId: "missing-proj",
        status: "paused",
      });
      await expect(execute(cmd)).rejects.toThrow("Project not found");
    });

    test("returns noop when target status is identical to current status", async () => {
      pool.query.mockResolvedValueOnce(
        queryResult([{ id: "proj-1", status: "active", raised_xlm: "50", donor_count: 2 }])
      );

      const cmd = new ChangeProjectStatusCommand({
        actor: "admin",
        projectId: "proj-1",
        status: "active",
      });

      const res = await execute(cmd);
      expect(res.noop).toBe(true);
      expect(res.events).toEqual([]);
    });

    test("successfully changes project status and persists ProjectStatusChanged event", async () => {
      pool.query
        // 1. SELECT * FROM projects
        .mockResolvedValueOnce(
          queryResult([{ id: "proj-1", status: "active", raised_xlm: "50", donor_count: 2 }])
        )
        // 2. getNextVersion
        .mockResolvedValueOnce(queryResult([{ max_version: 4 }]))
        // 3. storeProjectAggregate (UPDATE projects)
        .mockResolvedValueOnce(queryResult([]))
        // 4. INSERT INTO event_stream
        .mockResolvedValueOnce(queryResult([]));

      const cmd = new ChangeProjectStatusCommand({
        actor: "admin",
        projectId: "proj-1",
        status: "paused",
        reason: "Owner requested pause",
      });

      const res = await execute(cmd);
      expect(res.events.length).toBe(1);
      expect(res.events[0].eventType).toBe("ProjectStatusChanged");
      expect(res.data).toEqual({ previousStatus: "active", newStatus: "paused" });
    });
  });

  describe("ReachMilestoneCommand / ReachMilestoneCommandHandler", () => {
    test("throws validation error when milestoneId is missing", async () => {
      const cmd = new ReachMilestoneCommand({
        actor: "system",
        milestoneId: "",
        projectId: "proj-1",
      });
      await expect(execute(cmd)).rejects.toThrow("milestoneId is required");
    });

    test("successfully records MilestoneReached event", async () => {
      const txHash = makeTxHash("f");

      pool.query
        // 1. getNextVersion
        .mockResolvedValueOnce(queryResult([{ max_version: 1 }]))
        // 2. INSERT INTO event_stream
        .mockResolvedValueOnce(queryResult([]));

      const cmd = new ReachMilestoneCommand({
        actor: "system",
        milestoneId: "m-100",
        projectId: "proj-1",
        transactionHash: txHash,
      });

      const res = await execute(cmd);
      expect(res.data.milestoneId).toBe("m-100");
      expect(res.events[0].eventType).toBe("MilestoneReached");
    });
  });

  describe("ReleaseEscrowCommand / ReleaseEscrowCommandHandler", () => {
    test("throws validation error when releaseTransactionHash is not 64-char hex", async () => {
      const cmd = new ReleaseEscrowCommand({
        actor: "freelancer",
        jobId: "job-1",
        releaseTransactionHash: "invalid-hash",
      });
      await expect(execute(cmd)).rejects.toThrow("releaseTransactionHash must be a 64-char hex string");
    });

    test("throws error when job is not found", async () => {
      const releaseTxHash = makeTxHash("e");
      pool.query.mockResolvedValueOnce(queryResult([])); // getJobState SELECT * FROM jobs

      const cmd = new ReleaseEscrowCommand({
        actor: "freelancer",
        jobId: "missing-job",
        releaseTransactionHash: releaseTxHash,
      });
      await expect(execute(cmd)).rejects.toThrow("Job not found");
    });

    test("successfully processes job escrow release", async () => {
      const clientKey = makePublicKey("C");
      const freelancerKey = makePublicKey("F");
      const releaseTxHash = makeTxHash("e");

      pool.query
        // 1. getJobState (SELECT * FROM jobs WHERE id = $1)
        .mockResolvedValueOnce(
          queryResult([
            {
              id: "job-50",
              client_public_key: clientKey,
              freelancer_public_key: freelancerKey,
              amount_escrow_xlm: "150.0",
              status: "funded",
            },
          ])
        )
        // 2. SELECT * FROM jobs WHERE id = $1
        .mockResolvedValueOnce(
          queryResult([
            {
              id: "job-50",
              client_public_key: clientKey,
              freelancer_public_key: freelancerKey,
              amount_escrow_xlm: "150.0",
              status: "funded",
            },
          ])
        )
        // 3. getNextVersion
        .mockResolvedValueOnce(queryResult([{ max_version: 0 }]))
        // 4. INSERT INTO event_stream
        .mockResolvedValueOnce(queryResult([]));

      const cmd = new ReleaseEscrowCommand({
        actor: freelancerKey,
        jobId: "job-50",
        releaseTransactionHash: releaseTxHash,
      });

      const res = await execute(cmd);
      expect(res.data.jobId).toBe("job-50");
      expect(res.events[0].eventType).toBe("JobReleased");
    });
  });

  describe("CreateMatchOfferCommand / CreateMatchOfferCommandHandler", () => {
    test("throws validation error when expiresAt is in the past", async () => {
      const cmd = new CreateMatchOfferCommand({
        actor: makePublicKey("M"),
        projectId: "proj-1",
        matcherAddress: makePublicKey("M"),
        capXlm: "500",
        multiplier: 2,
        expiresAt: new Date(Date.now() - 10000).toISOString(),
      });
      await expect(execute(cmd)).rejects.toThrow("expiresAt must be in the future");
    });

    test("successfully creates match offer event", async () => {
      const matcherAddress = makePublicKey("M");
      const futureDate = new Date(Date.now() + 86400000).toISOString();

      pool.query
        // 1. getNextVersion
        .mockResolvedValueOnce(queryResult([{ max_version: 0 }]))
        // 2. INSERT INTO event_stream
        .mockResolvedValueOnce(queryResult([]));

      const cmd = new CreateMatchOfferCommand({
        actor: matcherAddress,
        projectId: "proj-1",
        matcherAddress,
        capXlm: "1000",
        multiplier: 2,
        expiresAt: futureDate,
      });

      const res = await execute(cmd);
      expect(res.data.matchId).toBeDefined();
      expect(res.events[0].eventType).toBe("MatchCreated");
    });
  });

  describe("Aggregate Persistence & Helper Utilities", () => {
    test("storeProjectAggregate omits raised_xlm update when includeRaisedTotal is false", async () => {
      pool.query.mockResolvedValueOnce(queryResult([]));

      const aggregate = ProjectAggregate.fromState({
        id: "p1",
        status: "active",
        donor_count: 10,
        raised_xlm: "250.0",
      });

      await storeProjectAggregate(pool, "p1", aggregate, { includeRaisedTotal: false });

      const queryCall = pool.query.mock.calls[0];
      expect(queryCall[0]).toContain("UPDATE projects");
      expect(queryCall[0]).not.toContain("raised_xlm");
      expect(queryCall[1]).toEqual([10, "active", "p1"]);
    });

    test("storeDonorAggregate performs idempotent ON CONFLICT profile insert", async () => {
      pool.query.mockResolvedValueOnce(queryResult([]));
      const donorKey = makePublicKey("Z");

      await storeDonorAggregate(pool, donorKey);

      const queryCall = pool.query.mock.calls[0];
      expect(queryCall[0]).toContain("INSERT INTO profiles");
      expect(queryCall[0]).toContain("ON CONFLICT (public_key) DO NOTHING");
      expect(queryCall[1]).toEqual([donorKey]);
    });

    test("loadAggregateStream loads and parses payload into Event domain models", async () => {
      const streamId = "Donation:test-tx";
      pool.query.mockResolvedValueOnce(
        queryResult([
          {
            event_id: "e1",
            stream_id: streamId,
            aggregate_type: "Donation",
            aggregate_id: "test-tx",
            event_type: "DonationRecorded",
            version: 1,
            aggregate_version: 1,
            payload: {
              eventType: "DonationRecorded",
              aggregateId: streamId,
              version: 1,
              actor: makePublicKey("A"),
              data: {
                projectId: "proj-1",
                donorAddress: makePublicKey("A"),
                amountXlm: 10,
                transactionHash: makeTxHash("a"),
              },
            },
            actor: "actor-1",
            occurred_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        ])
      );

      const events = await loadAggregateStream("Donation", "test-tx");
      expect(events.length).toBe(1);
      expect(events[0].eventType).toBe("DonationRecorded");
    });

    test("fromRow formats raw db row into standardized object", () => {
      const row = {
        event_id: "ev-1",
        stream_id: "st-1",
        aggregate_type: "Match",
        aggregate_id: "m-1",
        event_type: "MatchApplied",
        version: 1,
        aggregate_version: 1,
        payload: { test: true },
        actor: "act-1",
        occurred_at: "2026-01-01",
        created_at: "2026-01-01",
      };

      const result = fromRow(row);
      expect(result).toEqual({
        eventId: "ev-1",
        streamId: "st-1",
        aggregateType: "Match",
        aggregateId: "m-1",
        eventType: "MatchApplied",
        version: 1,
        aggregateVersion: 1,
        payload: { test: true },
        actor: "act-1",
        occurredAt: "2026-01-01",
        createdAt: "2026-01-01",
      });
    });
  });
});
