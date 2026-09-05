"use strict";

/**
 * Unit coverage for the replay log's cursor contract. The multi-process suite
 * proves it works over a real Redis; these pin the decisions that are easy to
 * regress — above all, that an empty replay and an unusable cursor are never
 * conflated.
 */

const { EventLog, INSTANCE_ID, parseCursor, compareStreamIds } = require("./eventLog");

describe("cursor parsing", () => {
  it("accepts the two cursor shapes it issues", () => {
    expect(parseCursor("r:1700000000000-0")).toEqual({ kind: "redis", id: "1700000000000-0" });
    expect(parseCursor("l:abc123:7")).toEqual({ kind: "local", instanceId: "abc123", seq: 7 });
  });

  it("rejects anything it did not issue rather than guessing", () => {
    for (const bad of ["", "nonsense", "r:", "r:not-an-id", "l:abc", "l:abc:notanumber", "x:1-0", null, 42]) {
      expect(parseCursor(bad)).toBeNull();
    }
  });

  it("orders stream ids numerically, not lexicographically", () => {
    // "9-0" > "10-0" as strings; getting this wrong makes an expired cursor
    // look current and silently drops the events a client is owed.
    expect(compareStreamIds("9-0", "10-0")).toBe(-1);
    expect(compareStreamIds("100-1", "100-2")).toBe(-1);
    expect(compareStreamIds("100-0", "100-0")).toBe(0);
  });
});

describe("in-memory mode (no shared store)", () => {
  let log;
  beforeEach(() => { log = new EventLog(null); });

  it("is not considered degraded, because one process is the whole world", () => {
    expect(log.usingSharedStore).toBe(false);
    expect(log.isDegraded()).toBe(false);
    expect(log.status().store).toBe("in-memory");
  });

  it("replays what was appended after a cursor", async () => {
    const first = await log.append({ name: "donation_event", payload: { n: 1 } });
    await log.append({ name: "donation_event", payload: { n: 2 } });
    await log.append({ name: "donation_event", payload: { n: 3 } });

    const result = await log.replay(first.cursor);
    expect(result.reset).toBe(false);
    expect(result.events.map((e) => e.payload.n)).toEqual([2, 3]);
  });

  it("reports no gap for a client already at the head", async () => {
    const last = await log.append({ name: "donation_event", payload: { n: 1 } });
    const result = await log.replay(last.cursor);
    expect(result.reset).toBe(false);
    expect(result.events).toEqual([]);
    expect(result.nextCursor).toBe(last.cursor);
  });

  it("refuses a cursor issued by another process instead of answering wrongly", async () => {
    await log.append({ name: "donation_event", payload: { n: 1 } });
    const result = await log.replay("l:ffffffffffffffff:1");
    // Sequence numbers from another pod say nothing about this pod's buffer;
    // answering from it would fabricate a timeline.
    expect(result.reset).toBe(true);
    expect(result.reason).toBe("CURSOR_FOREIGN");
    expect(result.events).toEqual([]);
  });

  it("cannot honour a shared cursor with no shared store", async () => {
    const result = await log.replay("r:1700000000000-0");
    expect(result.reset).toBe(true);
    expect(result.reason).toBe("STORE_UNAVAILABLE");
  });

  it("distinguishes 'no cursor' and 'bad cursor' from 'nothing happened'", async () => {
    await expect(log.replay(null)).resolves.toMatchObject({ reset: true, reason: "NO_CURSOR" });
    await expect(log.replay("garbage")).resolves.toMatchObject({ reset: true, reason: "INVALID_CURSOR" });
  });

  it("caps the batch so a far-behind client cannot ask for unbounded work", async () => {
    const first = await log.append({ name: "e", payload: {} });
    for (let i = 0; i < 40; i++) await log.append({ name: "e", payload: { i } });
    const result = await log.replay(first.cursor, 10);
    expect(result.events).toHaveLength(10);
  });
});

describe("shared store failures", () => {
  function failingRedis(error = new Error("ECONNREFUSED")) {
    return {
      xadd: jest.fn().mockRejectedValue(error),
      xrange: jest.fn().mockRejectedValue(error),
    };
  }

  it("keeps recording locally when the shared write fails, and says it is degraded", async () => {
    const log = new EventLog(failingRedis());
    const result = await log.append({ name: "donation_event", payload: { n: 1 } });

    // The event is still replayable by this pod — partial recovery beats none —
    // but the caller is told the cursor is not globally meaningful.
    expect(result.cursor).toContain(`l:${INSTANCE_ID}:`);
    expect(result.degraded).toBe(true);
    expect(log.isDegraded()).toBe(true);
  });

  it("tells the client to resynchronise when replay fails, not that nothing happened", async () => {
    const log = new EventLog(failingRedis());
    const result = await log.replay("r:1700000000000-0");

    // Returning `{ events: [], reset: false }` here would be the dangerous
    // answer: the client would conclude it had missed nothing.
    expect(result.reset).toBe(true);
    expect(result.reason).toBe("STORE_UNAVAILABLE");
    expect(result.degraded).toBe(true);
  });

  it("detects a cursor that has aged out of the capped stream", async () => {
    const redis = {
      xadd: jest.fn(),
      xrange: jest.fn()
        // Nothing after the client's cursor...
        .mockResolvedValueOnce([])
        // ...and the oldest surviving entry is already newer than it, so the
        // events between were trimmed and cannot be recovered.
        .mockResolvedValueOnce([["1700000009999-0", ["name", "e", "payload", "{}", "emittedAt", ""]]]),
    };
    const log = new EventLog(redis);
    const result = await log.replay("r:1700000000000-0");

    expect(result.reset).toBe(true);
    expect(result.reason).toBe("CURSOR_EXPIRED");
  });

  it("reports no gap when the stream is simply quiet", async () => {
    const redis = {
      xadd: jest.fn(),
      xrange: jest.fn()
        .mockResolvedValueOnce([])
        // The client's cursor is still within the retained window.
        .mockResolvedValueOnce([["1699999999999-0", ["name", "e", "payload", "{}", "emittedAt", ""]]]),
    };
    const log = new EventLog(redis);
    const result = await log.replay("r:1700000000000-0");

    expect(result.reset).toBe(false);
    expect(result.events).toEqual([]);
  });

  it("survives a row it cannot parse rather than failing the whole replay", async () => {
    const redis = {
      xadd: jest.fn(),
      xrange: jest.fn().mockResolvedValue([
        ["1700000000001-0", ["name", "donation_event", "payload", "{not json", "emittedAt", "t"]],
        ["1700000000002-0", ["name", "donation_event", "payload", "{\"n\":2}", "emittedAt", "t"]],
      ]),
    };
    const log = new EventLog(redis);
    const result = await log.replay("r:1700000000000-0");

    expect(result.events).toHaveLength(2);
    expect(result.events[0].payload).toEqual({});
    expect(result.events[1].payload).toEqual({ n: 2 });
  });
});
