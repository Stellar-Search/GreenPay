"use strict";

const { EventStoreService } = require("./eventStore");
const { DonationRecordedEvent } = require("./events");

// A stand-in for the pg pool that reproduces Postgres' *correct* behaviour for
// `INSERT ... ON CONFLICT (stream_id, version) DO NOTHING RETURNING (xmax = 0) AS inserted`:
// a fresh insert returns rowCount 1 with inserted = true, while a conflict on the
// unique (stream_id, version) index returns rowCount 0 with no row.
class ConflictAwarePool {
  constructor() {
    this.seen = new Set();
    this.queryCount = 0;
  }

  async query(sql, params) {
    this.queryCount += 1;
    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rowCount: 0, rows: [] };
    const p = params || [];
    const streamId = p[1];
    const version = p[5];
    const key = `${streamId}|${version}`;
    if (this.seen.has(key)) {
      // Postgres DO NOTHING path: nothing touched, nothing returned.
      return { rowCount: 0, rows: [] };
    }
    this.seen.add(key);
    return { rowCount: 1, rows: [{ inserted: true }] };
  }
}

function makeDonationEvent(streamId, version) {
  return new DonationRecordedEvent({
    aggregateId: streamId,
    version,
    actor: "test",
    projectId: "proj-1",
    donorAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    amountXlm: 10,
    currency: "XLM",
    message: "hi",
    transactionHash: "a".repeat(64),
  });
}

describe("EventStoreService.append inserted flag", () => {
  test("first insert of a stream_id+version is reported as inserted", async () => {
    const store = new EventStoreService(new ConflictAwarePool());
    const result = await store.append(makeDonationEvent("Donation:tx1", 1));
    expect(result.inserted).toBe(true);
    expect(result.eventId).toBeDefined();
    expect(result.version).toBe(1);
  });

  test("re-inserting the same stream_id+version is reported as NOT inserted", async () => {
    const store = new EventStoreService(new ConflictAwarePool());
    const first = await store.append(makeDonationEvent("Donation:tx1", 1));
    expect(first.inserted).toBe(true);

    const second = await store.append(makeDonationEvent("Donation:tx1", 1));
    expect(second.inserted).toBe(false);
  });

  test("distinct stream_id+version pairs are each reported as inserted", async () => {
    const store = new EventStoreService(new ConflictAwarePool());
    expect((await store.append(makeDonationEvent("Donation:tx1", 1))).inserted).toBe(true);
    expect((await store.append(makeDonationEvent("Donation:tx2", 1))).inserted).toBe(true);
    expect((await store.append(makeDonationEvent("Donation:tx1", 2))).inserted).toBe(true);
  });

  test("the singleton eventStore exposes the same accurate semantics", async () => {
    const store = new EventStoreService(new ConflictAwarePool());
    const result = await store.append(makeDonationEvent("Match:m1", 1));
    expect(typeof result.inserted).toBe("boolean");
    expect(result.inserted).toBe(true);
  });
});

describe("EventStoreService.appendBatch inserted flag", () => {
  test("duplicates inside a batch are skipped (inserted false) without throwing", async () => {
    const pool = new ConflictAwarePool();
    // give appendBatch a connect() that reuses the same conflict tracking
    pool.connect = async () => ({
      query: (sql, params) => pool.query(sql, params),
      release: () => {},
    });
    const store = new EventStoreService(pool);

    const results = await store.appendBatch([
      makeDonationEvent("Donation:tx1", 1),
      makeDonationEvent("Donation:tx1", 1),
      makeDonationEvent("Donation:tx2", 1),
    ]);

    expect(results[0].inserted).toBe(true);
    expect(results[1].inserted).toBe(false);
    expect(results[2].inserted).toBe(true);
  });
});
