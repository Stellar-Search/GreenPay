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

describe("Poison event retry tracking & Dead-Letter Queue (DLQ)", () => {
  let projections;
  let dispatchSpy;

  beforeEach(() => {
    projections = require("./projections");
    dispatchSpy = jest.spyOn(projections, "dispatchToProjections").mockImplementation(async () => {});
  });

  afterEach(() => {
    dispatchSpy.mockRestore();
  });

  class MockEventStorePool {
    constructor() {
      this.events = [];
      this.deadLetters = [];
      this.queries = [];
    }

    async query(sql, params = []) {
      this.queries.push({ sql: String(sql), params });
      const text = String(sql);

      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(text)) {
        return { rowCount: 0, rows: [] };
      }

      if (/INSERT INTO event_dead_letter/i.test(text)) {
        const [
          id, event_id, stream_id, aggregate_type, aggregate_id, event_type,
          version, payload, attempts, error_message, error_stack
        ] = params;
        const row = {
          id, event_id, stream_id, aggregate_type, aggregate_id, event_type,
          version, payload: typeof payload === "string" ? JSON.parse(payload) : payload,
          attempts, error_message, error_stack, created_at: new Date().toISOString()
        };
        this.deadLetters.push(row);
        return { rowCount: 1, rows: [row] };
      }

      if (/FROM event_dead_letter/i.test(text)) {
        if (/COUNT\(\*\)/i.test(text)) {
          return { rows: [{ count: String(this.deadLetters.length) }], rowCount: 1 };
        }
        const limit = params[0] || 100;
        return { rows: this.deadLetters.slice(0, limit), rowCount: Math.min(this.deadLetters.length, limit) };
      }

      if (/UPDATE event_stream/i.test(text)) {
        if (/dead_lettered\s*=\s*true/i.test(text)) {
          const [eventId, attempts, lastError] = params;
          const row = this.events.find(e => e.event_id === eventId);
          if (row) {
            row.processed = true;
            row.dead_lettered = true;
            row.attempts = attempts;
            row.last_error = lastError;
          }
          return { rowCount: 1, rows: [] };
        }
        if (/SET attempts/i.test(text)) {
          const [eventId, attempts, lastError] = params;
          const row = this.events.find(e => e.event_id === eventId);
          if (row) {
            row.attempts = attempts;
            row.last_error = lastError;
          }
          return { rowCount: 1, rows: [] };
        }
        if (/processed\s*=\s*true/i.test(text)) {
          const ids = Array.isArray(params[0]) ? params[0] : [params[0]];
          let count = 0;
          for (const id of ids) {
            const row = this.events.find(e => e.event_id === id);
            if (row) {
              row.processed = true;
              count++;
            }
          }
          return { rowCount: count, rows: [] };
        }
      }

      if (/FROM event_stream/i.test(text) && /processed\s*=\s*false/i.test(text)) {
        const limit = params[0] || 200;
        const unprocessed = this.events.filter(e => !e.processed).slice(0, limit);
        return { rows: unprocessed, rowCount: unprocessed.length };
      }

      return { rows: [], rowCount: 0 };
    }

    async connect() {
      return {
        query: (sql, params) => this.query(sql, params),
        release: () => {},
      };
    }
  }

  test("retries failing events and increments attempt count below maxAttempts", async () => {
    const pool = new MockEventStorePool();
    const store = new EventStoreService(pool);
    store.maxAttempts = 3;

    const event = makeDonationEvent("Donation:fail1", 1);
    pool.events.push({
      event_id: event.eventId,
      stream_id: event.getStreamId(),
      aggregate_type: event.aggregateType,
      aggregate_id: event.aggregateId,
      event_type: event.eventType,
      version: event.version,
      aggregate_version: event.aggregateVersion,
      payload: event.toPayload(),
      actor: event.actor,
      occurred_at: event.occurredAt,
      created_at: new Date().toISOString(),
      processed: false,
      attempts: 0,
      last_error: null,
    });

    dispatchSpy.mockRejectedValueOnce(new Error("Transient database error"));

    const result = await store.processBatch(10);
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.deadLettered).toBe(0);

    const row = pool.events[0];
    expect(row.processed).toBe(false);
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe("Transient database error");
    expect(pool.deadLetters.length).toBe(0);
  });

  test("routes to dead-letter queue after N failed attempts without blocking stream", async () => {
    const pool = new MockEventStorePool();
    const store = new EventStoreService(pool);
    store.maxAttempts = 3;

    const poisonEvent = makeDonationEvent("Donation:poison", 1);
    const validEvent = makeDonationEvent("Donation:valid", 1);

    pool.events.push({
      event_id: poisonEvent.eventId,
      stream_id: poisonEvent.getStreamId(),
      aggregate_type: poisonEvent.aggregateType,
      aggregate_id: poisonEvent.aggregateId,
      event_type: poisonEvent.eventType,
      version: poisonEvent.version,
      aggregate_version: poisonEvent.aggregateVersion,
      payload: poisonEvent.toPayload(),
      actor: poisonEvent.actor,
      occurred_at: poisonEvent.occurredAt,
      created_at: new Date().toISOString(),
      processed: false,
      attempts: 2, // already failed twice
      last_error: "prior error",
    });

    pool.events.push({
      event_id: validEvent.eventId,
      stream_id: validEvent.getStreamId(),
      aggregate_type: validEvent.aggregateType,
      aggregate_id: validEvent.aggregateId,
      event_type: validEvent.eventType,
      version: validEvent.version,
      aggregate_version: validEvent.aggregateVersion,
      payload: validEvent.toPayload(),
      actor: validEvent.actor,
      occurred_at: validEvent.occurredAt,
      created_at: new Date().toISOString(),
      processed: false,
      attempts: 0,
      last_error: null,
    });

    dispatchSpy.mockImplementation(async (db, ev) => {
      if (ev.aggregateId === poisonEvent.aggregateId) {
        throw new Error("Fatal projection schema incompatibility");
      }
    });

    // Run batch: poison event (3rd attempt) should be moved to DLQ, valid event should succeed
    const result = await store.processBatch(10);
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.deadLettered).toBe(1);

    // Poison event in stream is now processed & dead_lettered
    const poisonRow = pool.events[0];
    expect(poisonRow.processed).toBe(true);
    expect(poisonRow.dead_lettered).toBe(true);
    expect(poisonRow.attempts).toBe(3);
    expect(poisonRow.last_error).toBe("Fatal projection schema incompatibility");

    // Valid event was processed normally
    const validRow = pool.events[1];
    expect(validRow.processed).toBe(true);

    // Dead letter queue captured the failure with operator context
    expect(pool.deadLetters.length).toBe(1);
    const dlq = pool.deadLetters[0];
    expect(dlq.event_id).toBe(poisonEvent.eventId);
    expect(dlq.stream_id).toBe(poisonEvent.getStreamId());
    expect(dlq.event_type).toBe(poisonEvent.eventType);
    expect(dlq.attempts).toBe(3);
    expect(dlq.error_message).toBe("Fatal projection schema incompatibility");
    expect(dlq.error_stack).toBeDefined();

    // Operator visibility queries
    const dlqEvents = await store.getDeadLetterEvents(10);
    expect(dlqEvents.length).toBe(1);
    expect(dlqEvents[0].error_message).toBe("Fatal projection schema incompatibility");

    const dlqCount = await store.getDeadLetterCount();
    expect(dlqCount).toBe(1);

    // Stats include deadLettered count
    expect(store.getSchedulerStats().deadLettered).toBe(1);
  });

  test("one permanently failing event neither blocks subsequent events nor loops after DLQ", async () => {
    const pool = new MockEventStorePool();
    const store = new EventStoreService(pool);
    store.maxAttempts = 2;

    const poisonEvent = makeDonationEvent("Donation:bad", 1);
    const laterEvent1 = makeDonationEvent("Donation:good1", 1);
    const laterEvent2 = makeDonationEvent("Donation:good2", 1);

    const makeRow = (ev) => ({
      event_id: ev.eventId,
      stream_id: ev.getStreamId(),
      aggregate_type: ev.aggregateType,
      aggregate_id: ev.aggregateId,
      event_type: ev.eventType,
      version: ev.version,
      aggregate_version: ev.aggregateVersion,
      payload: ev.toPayload(),
      actor: ev.actor,
      occurred_at: ev.occurredAt,
      created_at: new Date().toISOString(),
      processed: false,
      attempts: 0,
      last_error: null,
    });

    pool.events.push(makeRow(poisonEvent));
    pool.events.push(makeRow(laterEvent1));
    pool.events.push(makeRow(laterEvent2));

    dispatchSpy.mockImplementation(async (db, ev) => {
      if (ev.aggregateId === poisonEvent.aggregateId) {
        throw new Error("Permanent payload poison");
      }
    });

    // Tick 1: Poison fails (attempt 1/2), good1 and good2 succeed
    const tick1 = await store.processBatch(10);
    expect(tick1.processed).toBe(2);
    expect(tick1.failed).toBe(1);
    expect(tick1.deadLettered).toBe(0);

    // Tick 2: Only poison remains unprocessed; fails (attempt 2/2 -> DLQ)
    const tick2 = await store.processBatch(10);
    expect(tick2.processed).toBe(0);
    expect(tick2.failed).toBe(1);
    expect(tick2.deadLettered).toBe(1);

    // Tick 3: Stream is completely clear, no remaining unprocessed events
    const tick3 = await store.processBatch(10);
    expect(tick3.total).toBe(0);
    expect(tick3.processed).toBe(0);
    expect(tick3.failed).toBe(0);

    // All events are resolved; DLQ has 1 recorded failure
    expect(pool.events.every(e => e.processed)).toBe(true);
    expect(await store.getDeadLetterCount()).toBe(1);
  });
});

describe("Adaptive batch backoff when zero progress is made", () => {
  const stubPool = { query: jest.fn(), connect: jest.fn() };

  test("backs off batch size instead of growing when saturated batch processes 0 events", () => {
    const store = new EventStoreService(stubPool);
    store.adaptiveBatch = true;
    store.batchSize = 800;

    // Saturated batch that processed 0 items (e.g. all failed)
    const nextSize = store.recordBatchOutcome({ total: 800, limit: 800, processed: 0, failed: 800 });
    expect(nextSize).toBe(400); // shrunk from 800 to 400
    expect(store.stats.consecutiveSaturated).toBe(0);
    expect(store.stats.consecutiveZeroProgress).toBe(1);

    // Another saturated batch with 0 progress
    const nextSize2 = store.recordBatchOutcome({ total: 400, limit: 400, processed: 0, failed: 400 });
    expect(nextSize2).toBe(200); // shrunk to base batch size
    expect(store.stats.consecutiveZeroProgress).toBe(2);

    // Stays bounded at minimum baseBatchSize
    const nextSize3 = store.recordBatchOutcome({ total: 200, limit: 200, processed: 0, failed: 200 });
    expect(nextSize3).toBe(200);
  });

  test("nextDelayMs returns poll interval instead of catch-up interval when processed === 0", () => {
    const store = new EventStoreService(stubPool);
    store.adaptiveBatch = true;
    const { pollIntervalMs, catchUpIntervalMs } = store.getSchedulerStats();

    // Saturated batch with successful progress -> fast catch-up interval (10ms)
    expect(store.nextDelayMs({ total: 200, limit: 200, processed: 200, failed: 0 }, 100)).toBe(catchUpIntervalMs);

    // Saturated batch with 0 progress -> aligned idle poll interval (does NOT hot loop at 10ms)
    expect(store.nextDelayMs({ total: 200, limit: 200, processed: 0, failed: 200 }, 0)).toBe(pollIntervalMs);
  });
});
