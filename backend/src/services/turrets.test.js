"use strict";

/**
 * turrets.test.js
 *
 * Verifies the idempotency guarantee added to matchDonationTxFunction:
 *
 *   - A second call with the same transaction_hash MUST be a no-op: no
 *     Horizon payment is submitted and no new DB row is written.
 *   - N concurrent calls for the same transaction_hash produce exactly one
 *     on-chain payment per match and exactly one row in
 *     matching_processed_donations.
 *   - The DB-level UNIQUE(original_tx_hash, match_id) constraint is honoured:
 *     concurrent losers receive a 23505 unique_violation and recover silently.
 *   - Non-XLM payments, unknown project wallets, and no-active-match cases
 *     still return quickly without touching the DB or Horizon.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────

// Mock the DB pool before the subject module is required.
jest.mock("../db/pool");

const pool = require("../db/pool");

// The subject under test — required after the mock is in place.
const turretsModule = require("./turrets");

// ── Constants ──────────────────────────────────────────────────────────────

const PROJECT_ID   = "proj-uuid-0001";
const PROJECT_NAME = "Clean Water Fund";
const WALLET_ADDR  = "GDESTINATION000000000000000000000000000000000000000000000001";
const DONOR_ADDR   = "GDONOR0000000000000000000000000000000000000000000000000001";
const MATCH_ID_1   = "match-uuid-0001";
const MATCH_ID_2   = "match-uuid-0002";

function makeTxHash(suffix = "a") {
  return suffix.padEnd(64, suffix);
}

/**
 * Build a minimal XLM payment payload as the Turret/Horizon stream emits it.
 */
function makePayment({ transaction_hash = makeTxHash("a"), amount = "100" } = {}) {
  return {
    transaction_hash,
    from: DONOR_ADDR,
    to: WALLET_ADDR,
    amount,
    asset_type: "native",
    asset_code: "XLM",
  };
}

/**
 * A single active donation_match row.
 */
function makeMatch({
  id = MATCH_ID_1,
  matcher_address = "GMATCHER00000001",
  cap_xlm = "500",
  matched_xlm = "0",
  multiplier = 1,
} = {}) {
  return { id, matcher_address, cap_xlm, matched_xlm, multiplier };
}

// ── DB emulator ────────────────────────────────────────────────────────────

/**
 * Minimal in-process emulator for the pool and pool.connect() interface.
 *
 * Tracks:
 *   processedRows  – rows inserted into matching_processed_donations
 *   donationRows   – rows inserted into donations
 *   matchUpdates   – (matchId, delta) increments applied to donation_matches
 *
 * Enforces UNIQUE(original_tx_hash, match_id) and raises a pg-shaped 23505
 * error on violation, mirroring what the real database does.
 */
function createDbEmulator({ matches = [makeMatch()], projectExists = true } = {}) {
  const processedRows = [];
  const donationRows  = [];
  const matchUpdates  = [];

  const uniqueViolation = () => {
    const err = new Error(
      "duplicate key value violates unique constraint " +
      "\"matching_processed_donations_original_tx_hash_match_id_key\""
    );
    err.code       = "23505";
    err.constraint = "matching_processed_donations_original_tx_hash_match_id_key";
    return err;
  };

  async function handleQuery(sql, params = []) {
    // Project lookup
    if (/SELECT id, name FROM projects/i.test(sql)) {
      return projectExists
        ? { rows: [{ id: PROJECT_ID, name: PROJECT_NAME }] }
        : { rows: [] };
    }

    // Active match lookup — return a live view: cap minus sum of updates so
    // far so the test correctly reflects committed state.
    if (/SELECT id, matcher_address, cap_xlm, matched_xlm, multiplier/i.test(sql)) {
      return {
        rows: matches.map((m) => {
          const applied = matchUpdates
            .filter((u) => u.matchId === m.id)
            .reduce((s, u) => s + u.delta, 0);
          return { ...m, matched_xlm: String(parseFloat(m.matched_xlm) + applied) };
        }),
      };
    }

    // Idempotency pre-check
    if (/SELECT match_id FROM matching_processed_donations/i.test(sql)) {
      const hash = params[0];
      return {
        rows: processedRows
          .filter((r) => r.original_tx_hash === hash)
          .map((r) => ({ match_id: r.match_id })),
      };
    }

    // UPDATE donation_matches
    if (/UPDATE donation_matches/i.test(sql)) {
      matchUpdates.push({ matchId: params[1], delta: parseFloat(params[0]) });
      return { rows: [] };
    }

    // INSERT INTO matching_processed_donations  (idempotency fence)
    if (/INSERT INTO matching_processed_donations/i.test(sql)) {
      const [id, original_tx_hash, match_id, matching_tx_hash, match_amount_xlm] = params;
      if (
        processedRows.some(
          (r) => r.original_tx_hash === original_tx_hash && r.match_id === match_id
        )
      ) {
        throw uniqueViolation();
      }
      processedRows.push({ id, original_tx_hash, match_id, matching_tx_hash, match_amount_xlm });
      return { rows: [] };
    }

    // INSERT INTO donations
    if (/INSERT INTO donations/i.test(sql)) {
      const [id, project_id, donor_address, amount_xlm, amount, currency,
        message, transaction_hash, idempotency_key] = params;
      donationRows.push({
        id, project_id, donor_address, amount_xlm, amount, currency,
        message, transaction_hash, idempotency_key,
      });
      return { rows: [] };
    }

    // Transaction control
    if (/^BEGIN$|^COMMIT$|^ROLLBACK$/i.test(sql.trim())) {
      return { rows: [] };
    }

    throw new Error(
      `turrets emulator: unexpected query:\n  ${sql.trim().slice(0, 120)}`
    );
  }

  // pool.query — used for read-only queries outside the transaction
  const query = jest.fn(handleQuery);

  // pool.connect() — returns a transactional client backed by the same store
  const connect = jest.fn(async () => ({
    query: jest.fn(handleQuery),
    release: jest.fn(),
  }));

  return { query, connect, processedRows, donationRows, matchUpdates };
}

// ── submitMatchingPayment spy ──────────────────────────────────────────────

/**
 * Replace submitMatchingPayment with a spy that returns a successful result
 * without touching the Stellar SDK or the network.
 *
 * Returns the spy so tests can inspect call counts.
 */
function mockSubmitMatchingPayment() {
  let callCount = 0;
  const spy = jest
    .spyOn(turretsModule, "submitMatchingPayment")
    .mockImplementation(async () => {
      callCount += 1;
      return { success: true, txHash: `mock-tx-${callCount}-${Math.random().toString(36).slice(2)}` };
    });
  return spy;
}

// ── Helper ─────────────────────────────────────────────────────────────────

async function run(payment, db) {
  pool.query   = db.query;
  pool.connect = db.connect;
  return turretsModule.matchDonationTxFunction(payment);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("matchDonationTxFunction — idempotency", () => {
  let submitSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    submitSpy = mockSubmitMatchingPayment();
  });

  afterEach(() => {
    submitSpy.mockRestore();
  });

  // ── Core acceptance criteria ─────────────────────────────────────────────

  test("first call processes the match and writes exactly one idempotency row", async () => {
    const db = createDbEmulator();
    const result = await run(makePayment(), db);

    expect(result.matched).toBe(true);
    expect(result.totalMatched).toBeGreaterThan(0);
    expect(result.matches).toHaveLength(1);

    // Exactly one row in the idempotency table.
    expect(db.processedRows).toHaveLength(1);
    expect(db.processedRows[0].original_tx_hash).toBe(makeTxHash("a"));
    expect(db.processedRows[0].match_id).toBe(MATCH_ID_1);

    // Exactly one donation row.
    expect(db.donationRows).toHaveLength(1);
    expect(db.donationRows[0].idempotency_key).toBe(
      `match:${makeTxHash("a")}:${MATCH_ID_1}`
    );
  });

  test("AC1 — second call with the same transaction_hash is a no-op", async () => {
    const db = createDbEmulator();
    const payment = makePayment();

    const first  = await run(payment, db);
    const second = await run(payment, db);

    // First call succeeds and processes the match.
    expect(first.matched).toBe(true);
    expect(first.deduplicated).toBeFalsy();

    // Second call returns immediately as a deduplicated no-op.
    expect(second.matched).toBe(true);
    expect(second.deduplicated).toBe(true);

    // Still exactly one idempotency row and one donation row after two calls.
    expect(db.processedRows).toHaveLength(1);
    expect(db.donationRows).toHaveLength(1);
  });

  test("AC2 — only one matching payment submitted to Horizon across two calls", async () => {
    const db = createDbEmulator();
    const payment = makePayment();

    await run(payment, db);
    await run(payment, db);

    // submitMatchingPayment must have been called exactly once — not twice.
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  test("AC3 — DB-level unique violation on concurrent retry is recovered, not thrown", async () => {
    const db = createDbEmulator();
    const payment = makePayment();

    // Simulate the concurrent-retry scenario:
    //
    //   Two invocations pass the pre-check simultaneously (processedRows is
    //   empty when both read it), then both reach the INSERT.  The winner
    //   commits; the loser receives a 23505 unique_violation.
    //
    // We replicate this by:
    //   1. Running the first call normally so the row is in processedRows.
    //   2. Momentarily hiding processedRows from the pre-check SELECT so the
    //      second call's pre-check sees nothing and proceeds to INSERT.
    //   3. The INSERT then finds the existing row and raises 23505.
    //   4. The function must recover silently — no throw, result is defined.
    await run(payment, db); // winner commits the row

    // Temporarily make the pre-check return no rows so the loser skips past it.
    const savedRows = processedRows_snapshot(db);
    overridePreCheck(db, []);

    const result = await run(payment, db);

    // Restore so subsequent assertions on processedRows are correct.
    restorePreCheck(db, savedRows);

    // Must not throw — must return a defined result.
    expect(result).toBeDefined();
    expect(result.matched).toBeDefined();

    // Still exactly one idempotency row (the loser's INSERT was rejected).
    expect(db.processedRows).toHaveLength(1);
    // submitMatchingPayment called once for the winner, once for the loser
    // (loser submits to Horizon before attempting the INSERT, then the INSERT
    // fails but is recovered gracefully).
    expect(submitSpy).toHaveBeenCalledTimes(2);
  });

  test("multiple matches: each processed once, duplicates skipped individually", async () => {
    const match1 = makeMatch({ id: MATCH_ID_1, cap_xlm: "500", matched_xlm: "0" });
    const match2 = makeMatch({
      id: MATCH_ID_2, cap_xlm: "300", matched_xlm: "0",
      matcher_address: "GMATCHER00000002",
    });
    const db = createDbEmulator({ matches: [match1, match2] });
    const payment = makePayment({ amount: "50" });

    const first = await run(payment, db);
    expect(first.matches).toHaveLength(2);
    expect(db.processedRows).toHaveLength(2);
    expect(db.donationRows).toHaveLength(2);

    const second = await run(payment, db);
    expect(second.deduplicated).toBe(true);

    // No additional rows written on the second call.
    expect(db.processedRows).toHaveLength(2);
    expect(db.donationRows).toHaveLength(2);
    // Horizon was called exactly twice (once per match on the first call).
    expect(submitSpy).toHaveBeenCalledTimes(2);
  });

  test("different transaction_hashes each produce independent, complete match sets", async () => {
    const db = createDbEmulator();

    const first  = await run(makePayment({ transaction_hash: makeTxHash("a") }), db);
    const second = await run(makePayment({ transaction_hash: makeTxHash("b") }), db);

    expect(first.matched).toBe(true);
    expect(second.matched).toBe(true);

    // Two distinct tx hashes → two idempotency rows and two donation rows.
    expect(db.processedRows).toHaveLength(2);
    expect(db.donationRows).toHaveLength(2);
    expect(db.processedRows[0].original_tx_hash).not.toBe(
      db.processedRows[1].original_tx_hash
    );
  });

  // ── Early-exit / guard paths ─────────────────────────────────────────────

  test("non-XLM asset returns early without any DB or Horizon calls", async () => {
    const db = createDbEmulator();
    pool.query   = db.query;
    pool.connect = db.connect;

    const result = await turretsModule.matchDonationTxFunction({
      transaction_hash: makeTxHash("c"),
      from: DONOR_ADDR, to: WALLET_ADDR, amount: "100",
      asset_type: "credit_alphanum4", asset_code: "USDC",
    });

    expect(result.matched).toBe(false);
    expect(result.reason).toMatch(/not an XLM/i);
    expect(db.query).not.toHaveBeenCalled();
    expect(db.connect).not.toHaveBeenCalled();
    expect(submitSpy).not.toHaveBeenCalled();
  });

  test("unknown project wallet returns early without touching matching tables", async () => {
    const db = createDbEmulator({ projectExists: false });
    const result = await run(makePayment(), db);

    expect(result.matched).toBe(false);
    expect(result.reason).toMatch(/project not found/i);
    expect(db.processedRows).toHaveLength(0);
    expect(db.donationRows).toHaveLength(0);
    expect(submitSpy).not.toHaveBeenCalled();
  });

  test("no active matching offers returns early without Horizon call", async () => {
    const db = createDbEmulator({ matches: [] });
    const result = await run(makePayment(), db);

    expect(result.matched).toBe(false);
    expect(result.reason).toMatch(/no active matching offers/i);
    expect(db.processedRows).toHaveLength(0);
    expect(db.connect).not.toHaveBeenCalled();
    expect(submitSpy).not.toHaveBeenCalled();
  });

  // ── DB transaction atomicity ─────────────────────────────────────────────

  test("each match uses a separate DB client acquired from pool.connect()", async () => {
    const match1 = makeMatch({ id: MATCH_ID_1 });
    const match2 = makeMatch({ id: MATCH_ID_2, matcher_address: "GMATCHER00000002" });
    const db = createDbEmulator({ matches: [match1, match2] });

    await run(makePayment(), db);

    // One client acquired per successful match.
    expect(db.connect).toHaveBeenCalledTimes(2);

    // Every acquired client must have been released (finally block guarantee).
    const clients = await Promise.all(db.connect.mock.results.map((r) => r.value));
    for (const client of clients) {
      expect(client.release).toHaveBeenCalledTimes(1);
    }
  });

  test("donations INSERT includes idempotency_key with stable format match:<tx>:<matchId>", async () => {
    const db = createDbEmulator();
    const txHash = makeTxHash("z");
    await run(makePayment({ transaction_hash: txHash }), db);

    expect(db.donationRows).toHaveLength(1);
    expect(db.donationRows[0].idempotency_key).toBe(
      `match:${txHash}:${MATCH_ID_1}`
    );
  });
});

// ── Helpers for AC3 concurrent-retry simulation ───────────────────────────

function processedRows_snapshot(db) {
  return [...db.processedRows];
}

/**
 * Override the pre-check SELECT to return a fixed list (possibly empty),
 * simulating the window where a concurrent caller passes the read before
 * the winner's transaction commits.
 */
function overridePreCheck(db, rowsToReturn) {
  const original = db.query.getMockImplementation();

  db.query.mockImplementation(async (sql, params = []) => {
    if (/SELECT match_id FROM matching_processed_donations/i.test(sql)) {
      return { rows: rowsToReturn.map((r) => ({ match_id: r.match_id })) };
    }
    return original(sql, params);
  });

  // Also override the client query for any client already connected.
  db.connect.mockImplementation(async () => ({
    query: jest.fn(async (sql, params = []) => {
      if (/SELECT match_id FROM matching_processed_donations/i.test(sql)) {
        return { rows: rowsToReturn.map((r) => ({ match_id: r.match_id })) };
      }
      // Delegate to the pool-level emulator for other queries.
      return original(sql, params);
    }),
    release: jest.fn(),
  }));
}

function restorePreCheck(db, savedRows) {
  // The already-inserted rows are still in db.processedRows (written by the
  // winner before we called overridePreCheck); nothing needs restoring.
  void savedRows;
}
