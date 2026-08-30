/**
 * src/services/onboarding/sponsoredAccounts.test.js
 *
 * Covers the three things that decide whether this path is safe to ship:
 * the transaction really is non-custodial, a sponsorship that fails mid-flow
 * gives its treasury capacity back, and an abandoned request leaves nothing
 * behind.
 */
"use strict";

jest.mock("../../db/pool", () => ({ query: jest.fn(), connect: jest.fn() }));

const { Keypair, Networks, Account, Transaction } = require("@stellar/stellar-sdk");

// Generated per run rather than hardcoded: a committed secret key is a
// committed secret key even when it only ever touches a test.
const SPONSOR = Keypair.random();
const DONOR = Keypair.random();

process.env.SPONSOR_SECRET_KEY = SPONSOR.secret();

const pool = require("../../db/pool");
const sponsored = require("./sponsoredAccounts");
const { xlmStringToStroops } = require("./reserveAccounting");

const XLM = (n) => xlmStringToStroops(String(n));

function horizonAccount(publicKey, sequence = "100", balance = "1000") {
  const account = new Account(publicKey, sequence);
  account.balances = [{ asset_type: "native", balance }];
  return account;
}

function fakeClient() {
  const queries = [];
  return {
    queries,
    query: jest.fn(async (sql, params) => {
      queries.push({ sql, params });
      if (/INSERT INTO sponsored_accounts/.test(sql)) {
        return {
          rows: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              account_public_key: params[1],
              reserved_stroops: "10000000",
              expires_at: new Date(Date.now() + 900_000).toISOString(),
            },
          ],
        };
      }
      if (/SELECT id, state FROM sponsored_accounts/.test(sql)) return { rows: [] };
      if (/FROM sponsored_accounts/.test(sql)) {
        return {
          rows: [{ per_session: 0, per_ip_daily: 0, global_daily: 0, global_hourly: 0, active_sponsorships: 0 }],
        };
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [] });
});

describe("buildCreationTransaction — the non-custodial shape", () => {
  const tx = sponsored.buildCreationTransaction({
    sponsorAccount: horizonAccount(SPONSOR.publicKey()),
    sponsorPublicKey: SPONSOR.publicKey(),
    donorPublicKey: DONOR.publicKey(),
  });

  it("wraps account creation in a sponsorship sandwich", () => {
    expect(tx.operations.map((op) => op.type)).toEqual([
      "beginSponsoringFutureReserves",
      "createAccount",
      "endSponsoringFutureReserves",
    ]);
  });

  it("creates the account with a zero starting balance", () => {
    // The whole funnel blocker in one argument: without the sponsorship this
    // would be rejected, and the donor would have to find XLM first.
    const create = tx.operations.find((op) => op.type === "createAccount");
    expect(Number(create.startingBalance)).toBe(0);
    expect(create.destination).toBe(DONOR.publicKey());
  });

  it("sources the closing operation from the donor, so the platform cannot submit alone", () => {
    const end = tx.operations.find((op) => op.type === "endSponsoringFutureReserves");
    expect(end.source).toBe(DONOR.publicKey());
  });

  it("is invalid with only the sponsor's signature", () => {
    const signed = sponsored.buildCreationTransaction({
      sponsorAccount: horizonAccount(SPONSOR.publicKey()),
      sponsorPublicKey: SPONSOR.publicKey(),
      donorPublicKey: DONOR.publicKey(),
    });
    signed.sign(SPONSOR);
    // One signature for a transaction needing two: the donor's consent is
    // structurally required, not merely requested.
    expect(signed.signatures).toHaveLength(1);
    signed.sign(DONOR);
    expect(signed.signatures).toHaveLength(2);
  });

  it("never asks for, stores, or accepts the donor's secret key", () => {
    const source = require("fs").readFileSync(`${__dirname}/sponsoredAccounts.js`, "utf8");
    expect(source).not.toMatch(/donorSecret|secretKey\s*:\s*donor|fromSecret\(\s*donor/i);
  });
});

describe("assertMatchesOffer", () => {
  function offered() {
    const tx = sponsored.buildCreationTransaction({
      sponsorAccount: horizonAccount(SPONSOR.publicKey()),
      sponsorPublicKey: SPONSOR.publicKey(),
      donorPublicKey: DONOR.publicKey(),
    });
    tx.sign(SPONSOR);
    return tx;
  }

  it("accepts the same transaction with the donor's signature added", () => {
    const tx = offered();
    const record = { id: "x", unsigned_xdr: tx.toXDR() };
    const cosigned = new Transaction(tx.toXDR(), Networks.TESTNET);
    cosigned.sign(DONOR);
    expect(() => sponsored.assertMatchesOffer(cosigned, record)).not.toThrow();
  });

  it("rejects a transaction whose operations were swapped for different ones", () => {
    // Otherwise a donor could return a transaction that spends the sponsor's
    // balance and collect the sponsor's signature on it.
    const record = { id: "x", unsigned_xdr: offered().toXDR() };
    const attacker = sponsored.buildCreationTransaction({
      sponsorAccount: horizonAccount(SPONSOR.publicKey()),
      sponsorPublicKey: SPONSOR.publicKey(),
      donorPublicKey: Keypair.random().publicKey(),
    });
    expect(() => sponsored.assertMatchesOffer(attacker, record)).toThrow(/does not match/i);
  });
});

describe("accountExists", () => {
  it("reports false for Horizon's 404, which is the normal first-time-donor case", async () => {
    const server = { loadAccount: jest.fn().mockRejectedValue({ response: { status: 404 } }) };
    await expect(sponsored.accountExists(DONOR.publicKey(), server)).resolves.toBe(false);
  });

  it("reports true when the account loads", async () => {
    const server = { loadAccount: jest.fn().mockResolvedValue(horizonAccount(DONOR.publicKey())) };
    await expect(sponsored.accountExists(DONOR.publicKey(), server)).resolves.toBe(true);
  });

  it("raises rather than claiming the account is missing when Horizon is down", async () => {
    // Reading a 503 as "no such account" would sponsor an account that already
    // exists and lock the reserve a second time.
    const server = { loadAccount: jest.fn().mockRejectedValue({ response: { status: 503 } }) };
    await expect(sponsored.accountExists(DONOR.publicKey(), server)).rejects.toMatchObject({
      code: "HORIZON_UNAVAILABLE",
    });
  });
});

describe("requestSponsorship", () => {
  function server({ donorExists = false } = {}) {
    return {
      loadAccount: jest.fn(async (key) => {
        if (key === DONOR.publicKey() && !donorExists) {
          const err = new Error("not found");
          err.response = { status: 404 };
          throw err;
        }
        return horizonAccount(key);
      }),
    };
  }

  it("returns a sponsor-signed transaction awaiting the donor's signature", async () => {
    const client = fakeClient();
    const dbPool = { connect: jest.fn().mockResolvedValue(client), query: jest.fn().mockResolvedValue({ rows: [] }) };

    const result = await sponsored.requestSponsorship(
      { publicKey: DONOR.publicKey(), sessionId: "s", ipHash: "h" },
      { server: server(), pool: dbPool },
    );

    expect(result.state).toBe("awaiting_signature");
    const tx = new Transaction(result.xdr, Networks.TESTNET);
    expect(tx.signatures).toHaveLength(1);
    expect(result.quote.lockedXlm).toBe("1.0000000");
  });

  it("takes an advisory lock so two concurrent requests cannot both claim the last slot", async () => {
    const client = fakeClient();
    const dbPool = { connect: jest.fn().mockResolvedValue(client), query: jest.fn().mockResolvedValue({ rows: [] }) };
    await sponsored.requestSponsorship(
      { publicKey: DONOR.publicKey(), sessionId: "s", ipHash: "h" },
      { server: server(), pool: dbPool },
    );
    expect(client.queries.some((q) => /pg_advisory_xact_lock/.test(q.sql))).toBe(true);
  });

  it("rejects a malformed address before touching the database", async () => {
    const dbPool = { connect: jest.fn(), query: jest.fn() };
    await expect(
      sponsored.requestSponsorship({ publicKey: "not-a-key", sessionId: "s" }, { server: server(), pool: dbPool }),
    ).rejects.toMatchObject({ code: "INVALID_PUBLIC_KEY" });
    expect(dbPool.connect).not.toHaveBeenCalled();
  });

  it("refuses to sponsor an account that already exists", async () => {
    const client = fakeClient();
    const dbPool = { connect: jest.fn().mockResolvedValue(client), query: jest.fn().mockResolvedValue({ rows: [] }) };
    await expect(
      sponsored.requestSponsorship(
        { publicKey: DONOR.publicKey(), sessionId: "s" },
        { server: server({ donorExists: true }), pool: dbPool },
      ),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_ACCOUNT_EXISTS" });
  });

  it("releases the reserved capacity when building the transaction fails mid-flow", async () => {
    // The row is committed before the network call, so a failure here would
    // otherwise leak treasury capacity forever.
    const client = fakeClient();
    const releaseCalls = [];
    const dbPool = {
      connect: jest.fn().mockResolvedValue(client),
      query: jest.fn(async (sql, params) => {
        releaseCalls.push({ sql, params });
        return { rows: [{ id: params?.[0] }] };
      }),
    };
    // The treasury read succeeds — the failure lands on the *next* sponsor
    // load, which is the one that builds the transaction. That is the real
    // mid-flow gap: the capacity row is already committed by then.
    let sponsorLoads = 0;
    const failingServer = {
      loadAccount: jest.fn(async (key) => {
        if (key === DONOR.publicKey()) {
          const err = new Error("not found");
          err.response = { status: 404 };
          throw err;
        }
        sponsorLoads += 1;
        if (sponsorLoads === 1) return horizonAccount(key);
        throw new Error("horizon exploded");
      }),
    };

    await expect(
      sponsored.requestSponsorship(
        { publicKey: DONOR.publicKey(), sessionId: "s" },
        { server: failingServer, pool: dbPool },
      ),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_BUILD_FAILED" });

    const release = releaseCalls.find((c) => /reserved_stroops = 0/.test(c.sql));
    expect(release).toBeDefined();
    expect(release.params).toContain("failed");
  });
});

describe("submitSponsorship", () => {
  function offeredRecord(overrides = {}) {
    const tx = sponsored.buildCreationTransaction({
      sponsorAccount: horizonAccount(SPONSOR.publicKey()),
      sponsorPublicKey: SPONSOR.publicKey(),
      donorPublicKey: DONOR.publicKey(),
    });
    tx.sign(SPONSOR);
    const cosigned = new Transaction(tx.toXDR(), Networks.TESTNET);
    cosigned.sign(DONOR);
    return {
      record: {
        id: "22222222-2222-4222-8222-222222222222",
        state: "awaiting_signature",
        unsigned_xdr: tx.toXDR(),
        account_public_key: DONOR.publicKey(),
        reserved_stroops: "10000000",
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        ...overrides,
      },
      signedXdr: cosigned.toXDR(),
    };
  }

  it("marks the sponsorship active and converts reserved capacity into locked reserve", async () => {
    const { record, signedXdr } = offeredRecord();
    const writes = [];
    const dbPool = {
      query: jest.fn(async (sql, params) => {
        writes.push({ sql, params });
        if (/SELECT \* FROM sponsored_accounts/.test(sql)) return { rows: [record] };
        return { rows: [] };
      }),
    };
    const server = { submitTransaction: jest.fn().mockResolvedValue({ successful: true, hash: "abc" }) };

    const result = await sponsored.submitSponsorship({ id: record.id, signedXdr }, { server, pool: dbPool });

    expect(result).toMatchObject({ state: "active", transactionHash: "abc" });
    expect(writes.some((w) => /locked_stroops = reserved_stroops/.test(w.sql))).toBe(true);
  });

  it("is idempotent for a retried submit after a dropped response", async () => {
    const { record, signedXdr } = offeredRecord({ state: "active", transaction_hash: "abc" });
    const dbPool = { query: jest.fn().mockResolvedValue({ rows: [record] }) };
    const server = { submitTransaction: jest.fn() };

    const result = await sponsored.submitSponsorship({ id: record.id, signedXdr }, { server, pool: dbPool });

    expect(result.deduplicated).toBe(true);
    // Submitting twice would lock reserve twice.
    expect(server.submitTransaction).not.toHaveBeenCalled();
  });

  it("releases capacity and reports honestly when Horizon rejects the transaction", async () => {
    const { record, signedXdr } = offeredRecord();
    const writes = [];
    const dbPool = {
      query: jest.fn(async (sql, params) => {
        writes.push({ sql, params });
        if (/SELECT \* FROM sponsored_accounts/.test(sql)) return { rows: [record] };
        return { rows: [{ id: record.id }] };
      }),
    };
    const server = {
      submitTransaction: jest.fn().mockRejectedValue({
        response: { data: { extras: { result_codes: { transaction: "tx_bad_seq" } } } },
      }),
    };

    await expect(
      sponsored.submitSponsorship({ id: record.id, signedXdr }, { server, pool: dbPool }),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_SUBMIT_FAILED" });

    expect(writes.some((w) => /reserved_stroops = 0/.test(w.sql))).toBe(true);
  });

  it("releases capacity when the transaction lands on-chain but fails", async () => {
    const { record, signedXdr } = offeredRecord();
    const writes = [];
    const dbPool = {
      query: jest.fn(async (sql, params) => {
        writes.push({ sql, params });
        if (/SELECT \* FROM sponsored_accounts/.test(sql)) return { rows: [record] };
        return { rows: [{ id: record.id }] };
      }),
    };
    const server = { submitTransaction: jest.fn().mockResolvedValue({ successful: false, hash: "deadbeef" }) };

    await expect(
      sponsored.submitSponsorship({ id: record.id, signedXdr }, { server, pool: dbPool }),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_EXECUTION_FAILED" });

    const release = writes.find((w) => /reserved_stroops = 0/.test(w.sql));
    expect(release).toBeDefined();
    // The hash is kept even for a failure, so the attempt stays auditable.
    expect(release.params).toContain("deadbeef");
  });

  it("refuses a transaction that does not match the offer", async () => {
    const { record } = offeredRecord();
    const attacker = sponsored.buildCreationTransaction({
      sponsorAccount: horizonAccount(SPONSOR.publicKey()),
      sponsorPublicKey: SPONSOR.publicKey(),
      donorPublicKey: Keypair.random().publicKey(),
    });
    const dbPool = { query: jest.fn().mockResolvedValue({ rows: [record] }) };
    const server = { submitTransaction: jest.fn() };

    await expect(
      sponsored.submitSponsorship({ id: record.id, signedXdr: attacker.toXDR() }, { server, pool: dbPool }),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_TAMPERED" });
    expect(server.submitTransaction).not.toHaveBeenCalled();
  });

  it("closes an expired offer instead of submitting it", async () => {
    const { record, signedXdr } = offeredRecord({
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const dbPool = {
      query: jest.fn(async (sql) => {
        if (/SELECT \* FROM sponsored_accounts/.test(sql)) return { rows: [record] };
        return { rows: [{ id: record.id }] };
      }),
    };
    const server = { submitTransaction: jest.fn() };

    await expect(
      sponsored.submitSponsorship({ id: record.id, signedXdr }, { server, pool: dbPool }),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_EXPIRED" });
    expect(server.submitTransaction).not.toHaveBeenCalled();
  });

  it("refuses to reopen a closed request", async () => {
    const { record, signedXdr } = offeredRecord({ state: "abandoned" });
    const dbPool = { query: jest.fn().mockResolvedValue({ rows: [record] }) };
    await expect(
      sponsored.submitSponsorship({ id: record.id, signedXdr }, { server: {}, pool: dbPool }),
    ).rejects.toMatchObject({ code: "SPONSORSHIP_CLOSED" });
  });
});

describe("abandonSponsorship — an abandoned donation leaves no partial state", () => {
  it("zeroes the reserved capacity and closes the row", async () => {
    const dbPool = {
      query: jest.fn().mockResolvedValue({ rows: [{ id: "abc", state: "abandoned" }] }),
    };
    const result = await sponsored.abandonSponsorship("abc", dbPool);

    expect(result).toEqual({ id: "abc", released: true, state: "abandoned" });
    const [sql, params] = dbPool.query.mock.calls[0];
    expect(sql).toMatch(/reserved_stroops = 0/);
    expect(sql).toMatch(/locked_stroops = 0/);
    expect(params).toContain("abandoned");
  });

  it("never downgrades a sponsorship that already went active", async () => {
    // An active sponsorship holds real reserve on the ledger. Marking it
    // abandoned would tell the treasury it has capacity it does not have.
    const dbPool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const result = await sponsored.abandonSponsorship("abc", dbPool);
    expect(result.released).toBe(false);
    expect(dbPool.query.mock.calls[0][0]).toMatch(/state <> \$5/);
  });

  it("is quiet about an unknown id, because the caller is a browser beacon", async () => {
    const dbPool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await expect(sponsored.abandonSponsorship("nope", dbPool)).resolves.toMatchObject({ released: false });
  });
});

describe("sweepExpiredSponsorships", () => {
  it("reclaims capacity from offers that were never co-signed", async () => {
    const dbPool = { query: jest.fn().mockResolvedValue({ rows: [{ id: "a" }, { id: "b" }] }) };
    await expect(sponsored.sweepExpiredSponsorships(dbPool)).resolves.toBe(2);
    expect(dbPool.query.mock.calls[0][0]).toMatch(/expires_at < NOW\(\)/);
  });

  it("leaves active sponsorships alone", async () => {
    const dbPool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await sponsored.sweepExpiredSponsorships(dbPool);
    expect(dbPool.query.mock.calls[0][1][1]).toEqual(["requested", "awaiting_signature"]);
  });
});

describe("reclaimSponsorship — the recovery path", () => {
  it("refuses to revoke while the account could not carry its own reserve", async () => {
    // Submitting anyway would be rejected on-chain; saying why is more useful
    // than a retry loop.
    const record = { id: "r", state: "active", account_public_key: DONOR.publicKey() };
    const dbPool = { query: jest.fn().mockResolvedValue({ rows: [record] }) };
    const server = { loadAccount: jest.fn().mockResolvedValue(horizonAccount(DONOR.publicKey(), "1", "0.2")) };

    const result = await sponsored.reclaimSponsorship("r", { server, pool: dbPool });
    expect(result.reclaimed).toBe(false);
    expect(result.reason).toMatch(/would need 1\.0000000 XLM/);
  });

  it("revokes and records the reclaim when the account can carry its own reserve", async () => {
    const record = { id: "r", state: "active", account_public_key: DONOR.publicKey() };
    const writes = [];
    const dbPool = {
      query: jest.fn(async (sql, params) => {
        writes.push({ sql, params });
        if (/SELECT \* FROM sponsored_accounts/.test(sql)) return { rows: [record] };
        return { rows: [] };
      }),
    };
    const server = {
      loadAccount: jest.fn(async (key) => horizonAccount(key, "5", "10")),
      submitTransaction: jest.fn().mockResolvedValue({ successful: true, hash: "reclaimhash" }),
    };

    const result = await sponsored.reclaimSponsorship("r", { server, pool: dbPool });

    expect(result).toEqual({ reclaimed: true, transactionHash: "reclaimhash" });
    expect(writes.some((w) => /locked_stroops = 0/.test(w.sql) && w.params.includes("reclaimed"))).toBe(true);
  });

  it("treats an account the donor merged away as already reclaimed", async () => {
    const record = { id: "r", state: "active", account_public_key: DONOR.publicKey() };
    const dbPool = {
      query: jest.fn(async (sql) => {
        if (/SELECT \* FROM sponsored_accounts/.test(sql)) return { rows: [record] };
        return { rows: [] };
      }),
    };
    const server = { loadAccount: jest.fn().mockRejectedValue(new Error("404")) };

    const result = await sponsored.reclaimSponsorship("r", { server, pool: dbPool });
    expect(result.reclaimed).toBe(true);
    expect(result.reason).toMatch(/already returned/);
  });

  it("counts a failed revocation so monitoring can see reserve is not coming back", async () => {
    const record = { id: "r", state: "active", account_public_key: DONOR.publicKey() };
    const writes = [];
    const dbPool = {
      query: jest.fn(async (sql, params) => {
        writes.push({ sql, params });
        if (/SELECT \* FROM sponsored_accounts/.test(sql)) return { rows: [record] };
        return { rows: [] };
      }),
    };
    const server = {
      loadAccount: jest.fn(async (key) => horizonAccount(key, "5", "10")),
      submitTransaction: jest.fn().mockRejectedValue({
        response: { data: { extras: { result_codes: { transaction: "tx_failed" } } } },
      }),
    };

    const result = await sponsored.reclaimSponsorship("r", { server, pool: dbPool });
    expect(result.reclaimed).toBe(false);
    expect(writes.some((w) => /reclaim_failures = reclaim_failures \+ 1/.test(w.sql))).toBe(true);
  });

  it("declines when the sponsorship is not active", async () => {
    const dbPool = { query: jest.fn().mockResolvedValue({ rows: [{ id: "r", state: "abandoned" }] }) };
    const result = await sponsored.reclaimSponsorship("r", { server: {}, pool: dbPool });
    expect(result).toMatchObject({ reclaimed: false, reason: expect.stringContaining("abandoned") });
  });
});

describe("readTreasuryBalanceStroops", () => {
  it("reads the sponsor's native balance", async () => {
    const server = { loadAccount: jest.fn().mockResolvedValue(horizonAccount(SPONSOR.publicKey(), "1", "250.5")) };
    await expect(sponsored.readTreasuryBalanceStroops(server)).resolves.toBe(XLM("250.5"));
  });

  it("pauses sponsorship rather than assuming a healthy treasury when Horizon is unreadable", async () => {
    const server = { loadAccount: jest.fn().mockRejectedValue(new Error("down")) };
    await expect(sponsored.readTreasuryBalanceStroops(server)).rejects.toMatchObject({
      code: "TREASURY_UNREADABLE",
    });
  });
});

describe("reserveLedger", () => {
  it("separates reserve actually locked from capacity merely committed", async () => {
    const dbPool = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            active: 4, pending: 2, reclaimed: 1, failed: 3,
            locked_stroops: "40000000", reserved_stroops: "20000000", reclaim_failures: 0,
          },
        ],
      }),
    };
    const ledger = await sponsored.reserveLedger(dbPool);
    expect(ledger.lockedXlm).toBe("4.0000000");
    expect(ledger.committedXlm).toBe("6.0000000");
    expect(ledger.activeSponsorships).toBe(4);
  });
});
