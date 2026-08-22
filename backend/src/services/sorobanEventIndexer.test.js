"use strict";

const { Address, Keypair, nativeToScVal, xdr } = require("@stellar/stellar-sdk");
const { SorobanEventIndexer, decodeDonationEvent } = require("./sorobanEventIndexer");

const DONOR = Keypair.random().publicKey();
const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

function donationEvent(overrides = {}) {
  return {
    id: "1-0000000001",
    pagingToken: "42-1",
    ledger: 42,
    txHash: "a".repeat(64),
    topic: [
      nativeToScVal("donated", { type: "symbol" }),
      new Address(DONOR).toScVal(),
      nativeToScVal("8d9ac19b-52eb-42f7-80d9-19a88ba59e43", { type: "string" }),
    ],
    value: xdr.ScVal.scvVec([
      nativeToScVal(123456789n, { type: "i128" }),
      nativeToScVal("None", { type: "symbol" }),
      nativeToScVal(0, { type: "u32" }),
    ]),
    ...overrides,
  };
}

describe("Soroban donation event ingestion", () => {
  test("decodes the contract event without converting the amount to a float", () => {
    expect(decodeDonationEvent(donationEvent())).toEqual({
      donorAddress: DONOR,
      projectId: "8d9ac19b-52eb-42f7-80d9-19a88ba59e43",
      amountStroops: "123456789",
      transactionHash: "a".repeat(64),
      ledger: 42,
    });
  });

  test("persists the last event paging token only after the backend accepts the event", async () => {
    const queries = [];
    const db = {
      query: jest.fn(async (sql, values) => {
        queries.push({ sql, values });
        if (sql.startsWith("SELECT value")) return { rows: [] };
        return { rows: [] };
      }),
    };
    const rpcServer = {
      getLatestLedger: jest.fn(async () => ({ sequence: 40 })),
      getEvents: jest.fn(async () => ({ latestLedger: 42, events: [donationEvent()] })),
    };
    const handleDonation = jest.fn(async () => true);
    const indexer = new SorobanEventIndexer({ rpcServer, contractId: CONTRACT_ID, db, handleDonation });

    indexer.startLedger = 40;
    await indexer.pollOnce();

    expect(handleDonation).toHaveBeenCalledWith(
      "8d9ac19b-52eb-42f7-80d9-19a88ba59e43",
      expect.objectContaining({ amount_stroops: "123456789" })
    );
    expect(queries.at(-1).values).toEqual([`soroban_events_cursor:${CONTRACT_ID}`, "42-1"]);
  });

  test("does not advance the cursor when the command boundary rejects an event", async () => {
    const db = { query: jest.fn(async () => ({ rows: [] })) };
    const rpcServer = {
      getEvents: jest.fn(async () => ({ latestLedger: 42, events: [donationEvent()] })),
    };
    const indexer = new SorobanEventIndexer({
      rpcServer,
      contractId: CONTRACT_ID,
      db,
      handleDonation: jest.fn(async () => false),
    });
    indexer.startLedger = 40;

    await expect(indexer.pollOnce()).rejects.toThrow("backend command boundary rejected");
    expect(indexer.cursor).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });
});
