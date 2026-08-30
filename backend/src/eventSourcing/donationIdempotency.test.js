"use strict";

/**
 * Idempotency guarantees for donation recording.
 *
 * Clients (mobile's offline queue, frontend retries) replay POST /api/donations
 * with the same transaction hash after network failures. These tests pin down
 * what a replay must do:
 *
 *   - identical replay  -> success carrying the stored record, no new event;
 *   - concurrent replays -> the database uniqueness constraints make duplicate
 *     records impossible, and every loser of the insert race resolves as an
 *     idempotent success instead of an error;
 *   - replay with mismatched fields -> rejected as tampering, not a retry.
 *
 * The emulator stands in for Postgres and enforces exactly the two constraints
 * the real schema puts on donation events — ux_donation_tx_hash (at most one
 * DonationRecorded per transaction hash) and ux_event_stream_stream_version
 * (one event per position in the Donation:<tx-hash> aggregate stream) —
 * rejecting violations with pg-shaped unique_violation errors.
 */

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

const { execute, DonationReplayConflictError } = require("./commandBus");
const { RecordDonationCommand } = require("./commands");

const { Keypair } = require("@stellar/stellar-sdk");
const _keys = Array.from({ length: 26 }, () => Keypair.random().publicKey());
function makePublicKey(char = "A") {
  const index = Math.abs(char.charCodeAt(0) - 65) % 26;
  return _keys[index];
}

function makeTxHash(char = "a") {
  return char.repeat(64);
}

function createDonationDbEmulator({ projectExists = true } = {}) {
  const rows = [];
  const insertCalls = [];

  const uniqueViolation = (constraint) => {
    const err = new Error(`duplicate key value violates unique constraint "${constraint}"`);
    err.code = "23505";
    err.constraint = constraint;
    return err;
  };

  async function query(sql, params = []) {
    if (sql.includes("payload->'data'->>'transactionHash'")) {
      const hash = params[0];
      return {
        rows: rows.filter(
          (r) =>
            r.aggregate_type === "Donation" &&
            r.event_type === "DonationRecorded" &&
            r.payload?.data?.transactionHash === hash,
        ),
      };
    }
    if (/SELECT id FROM projects/i.test(sql)) {
      return projectExists ? { rows: [{ id: params[0] }] } : { rows: [] };
    }
    if (/SELECT \* FROM projects/i.test(sql)) {
      return {
        rows: [{ id: params[0], raised_xlm: "0", donor_count: 0, status: "active" }],
      };
    }
    if (/FROM donor_stats/i.test(sql)) {
      return { rows: [] };
    }
    if (/MAX\(version\)/i.test(sql)) {
      const max = rows
        .filter((r) => r.aggregate_type === params[0] && r.aggregate_id === params[1])
        .reduce((acc, r) => Math.max(acc, r.version), 0);
      return { rows: [{ max_version: max }] };
    }
    if (/^UPDATE projects/i.test(sql)) {
      return { rows: [] };
    }
    if (/^INSERT INTO profiles/i.test(sql)) {
      return { rows: [] };
    }
    if (/^INSERT INTO event_stream/i.test(sql)) {
      insertCalls.push(params);
      const payload =
        typeof params[7] === "string" ? JSON.parse(params[7]) : params[7];

      // ux_donation_tx_hash: at most one DonationRecorded per tx hash.
      if (
        rows.some(
          (r) =>
            r.event_type === "DonationRecorded" &&
            r.payload.data.transactionHash === payload.data.transactionHash,
        )
      ) {
        throw uniqueViolation("ux_donation_tx_hash");
      }
      // ux_event_stream_stream_version: one event per aggregate position.
      if (rows.some((r) => r.stream_id === params[1] && r.version === params[5])) {
        throw uniqueViolation("ux_event_stream_stream_version");
      }

      rows.push({
        event_id: params[0],
        stream_id: params[1],
        aggregate_type: params[2],
        aggregate_id: params[3],
        event_type: params[4],
        version: params[5],
        aggregate_version: params[6],
        payload,
        actor: params[8],
        occurred_at: params[9],
        created_at: params[10],
      });
      return { rows: [] };
    }
    throw new Error(`donationIdempotency emulator: unexpected query: ${sql.slice(0, 80)}`);
  }

  return { query, rows, insertCalls };
}

function makeCommand({ projectId = "proj-1", donorAddress = makePublicKey("A"), amountXlm = "25", currency = "XLM", message = null, transactionHash = makeTxHash("a") } = {}) {
  return new RecordDonationCommand({
    actor: donorAddress,
    projectId,
    donorAddress,
    amountXlm,
    currency,
    message,
    transactionHash,
  });
}

describe("donation record idempotency", () => {
  test("replaying an identical record call returns the stored record as a success without writing again", async () => {
    const db = createDonationDbEmulator();
    const cmd = makeCommand();

    const first = await execute(cmd, db);
    expect(first.deduplicated).toBe(false);

    const replay = await execute(makeCommand(), db);
    expect(replay.deduplicated).toBe(true);
    expect(replay.data.eventId).toBe(first.events[0].eventId);
    expect(replay.data.payload.data.amountXlm).toBe(first.events[0].data.amountXlm);

    expect(db.rows).toHaveLength(1);
    expect(db.insertCalls).toHaveLength(1);
  });

  test("N simultaneous identical record calls produce exactly one row and one event", async () => {
    const db = createDonationDbEmulator();
    const N = 10;

    // Fired concurrently: by construction every handler passes its read
    // pre-check before any of them reaches the INSERT, so nine lose the
    // write race against the uniqueness constraint and must recover into
    // an idempotent success instead of failing.
    const results = await Promise.all(
      Array.from({ length: N }, () => execute(makeCommand(), db)),
    );

    const fresh = results.filter((r) => !r.deduplicated);
    const deduped = results.filter((r) => r.deduplicated);
    expect(fresh).toHaveLength(1);
    expect(deduped).toHaveLength(N - 1);

    // Exactly one donation row/event exists for the transaction hash...
    expect(db.rows).toHaveLength(1);
    expect(db.insertCalls).toHaveLength(N);
    expect(db.rows[0].event_type).toBe("DonationRecorded");
    // aggregateId is stored unprefixed — see events.js's buildStreamId.
    expect(db.rows[0].aggregate_id).toBe(makeTxHash("a"));
    expect(db.rows[0].stream_id).toBe(`Donation:${makeTxHash("a")}`);

    // ...and every caller observed it: same identity, same amount, success.
    const winnerEventId = db.rows[0].event_id;
    for (const result of results) {
      if (result.deduplicated) {
        expect(result.success).toBe(true);
        expect(result.data.eventId).toBe(winnerEventId);
        expect(result.data.payload.data.transactionHash).toBe(makeTxHash("a"));
      } else {
        expect(result.events[0].eventId).toBe(winnerEventId);
      }
    }
    const amounts = new Set(
      results.map((r) =>
        r.deduplicated ? r.data.payload.data.amountXlm : r.events[0].data.amountXlm,
      ),
    );
    expect(amounts.size).toBe(1);
  });

  test("a replay with a different amount is rejected as tampering, not treated as a retry", async () => {
    const db = createDonationDbEmulator();

    await execute(makeCommand({ amountXlm: "25" }), db);
    expect(db.rows).toHaveLength(1);

    await expect(
      execute(makeCommand({ amountXlm: "250" }), db),
    ).rejects.toMatchObject({
      name: "DonationReplayConflictError",
      code: "DONATION_TX_CONFLICT",
      status: 409,
    });
    expect(db.rows).toHaveLength(1);
  });

  test("a replay targeting a different project is rejected as tampering", async () => {
    const db = createDonationDbEmulator();

    await execute(makeCommand({ projectId: "proj-1" }), db);
    expect(db.rows).toHaveLength(1);

    await expect(
      execute(makeCommand({ projectId: "proj-2" }), db),
    ).rejects.toBeInstanceOf(DonationReplayConflictError);

    try {
      await execute(makeCommand({ projectId: "proj-2" }), db);
    } catch (err) {
      expect(err.mismatches.some((m) => m.includes("projectId"))).toBe(true);
    }
    expect(db.rows).toHaveLength(1);
  });

  test("a replay claiming a different donor is rejected as tampering", async () => {
    const db = createDonationDbEmulator();

    await execute(makeCommand({ donorAddress: makePublicKey("A") }), db);

    await expect(
      execute(makeCommand({ donorAddress: makePublicKey("B") }), db),
    ).rejects.toMatchObject({
      code: "DONATION_TX_CONFLICT",
    });
    expect(db.rows).toHaveLength(1);
  });

  test("a losing insert whose fields disagree with the winner is still a conflict, never a silent dedupe", async () => {
    const db = createDonationDbEmulator();

    // Two different payloads race on the same transaction hash; both pass
    // their pre-check before either writes, so the loser recovers via the
    // uniqueness constraint and must surface the mismatch.
    const settled = await Promise.allSettled([
      execute(makeCommand({ amountXlm: "25" }), db),
      execute(makeCommand({ amountXlm: "30" }), db),
    ]);

    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(DonationReplayConflictError);

    // Exactly one row was written, and it belongs to the winning payload.
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].payload.data.amountXlm).toBe(
      fulfilled[0].value.events[0].data.amountXlm,
    );
  });

  test("message differences between retries are tolerated: they do not affect totals", async () => {
    const db = createDonationDbEmulator();

    await execute(makeCommand({ message: "first attempt" }), db);
    const replay = await execute(makeCommand({ message: "edited after failure" }), db);

    expect(replay.deduplicated).toBe(true);
    expect(db.rows).toHaveLength(1);
  });
});
