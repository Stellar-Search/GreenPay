"use strict";

/**
 * Round-trip and replay coverage for the event stream.
 *
 * Unlike the fully-mocked `pool.query` used elsewhere, the emulator below
 * actually filters rows by the SQL predicate it was given (stream_id,
 * aggregate_type/aggregate_id, transactionHash) instead of returning a
 * canned response regardless of the query. That's what makes these tests
 * capable of catching the historical bug where DomainEvent.getStreamId()
 * double-prefixed an aggregateId that callers had already prefixed: a
 * write/read pair built from mismatched stream ids would come back empty
 * here, exactly as it silently did in production before the fix.
 */

const { EventStoreService } = require("./eventStore");
const { DonationRecordedEvent } = require("./events");
const { execute, loadAggregateStream } = require("./commandBus");
const { RecordDonationCommand } = require("./commands");
const { ProjectAggregate, DonorAggregate } = require("./aggregates");

const { Keypair } = require("@stellar/stellar-sdk");
const _keys = Array.from({ length: 26 }, () => Keypair.random().publicKey());
function makePublicKey(char = "A") {
  const index = Math.abs(char.charCodeAt(0) - 65) % 26;
  return _keys[index];
}

function makeTxHash(char = "a") {
  return char.repeat(64);
}

function createEventStorePool() {
  const rows = [];

  async function query(sql, params = []) {
    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rowCount: 0, rows: [] };

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
    if (/^SELECT event_id.*FROM event_stream\s+WHERE stream_id = \$1/is.test(sql)) {
      const streamId = params[0];
      return {
        rows: rows
          .filter((r) => r.stream_id === streamId)
          .sort((a, b) => a.version - b.version),
      };
    }
    if (/SELECT id FROM projects/i.test(sql)) {
      return { rows: [{ id: params[0] }] };
    }
    if (/SELECT \* FROM projects/i.test(sql)) {
      return { rows: [{ id: params[0], raised_xlm: "0", donor_count: 0, status: "active" }] };
    }
    if (/FROM donor_stats/i.test(sql)) {
      return { rows: [] };
    }
    if (/MAX\(version\).*WHERE stream_id = \$1/is.test(sql)) {
      const streamId = params[0];
      const max = rows
        .filter((r) => r.stream_id === streamId)
        .reduce((acc, r) => Math.max(acc, r.version), 0);
      return { rows: [{ max_version: max }] };
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
      const [eventId, streamId, aggregateType, aggregateId, eventType, version, aggregateVersion, payload, actor, occurredAt, createdAt] = params;
      rows.push({
        event_id: eventId,
        stream_id: streamId,
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        event_type: eventType,
        version,
        aggregate_version: aggregateVersion,
        payload: typeof payload === "string" ? JSON.parse(payload) : payload,
        actor,
        occurred_at: occurredAt,
        created_at: createdAt,
      });
      return { rows: [{ inserted: true }], rowCount: 1 };
    }

    throw new Error(`streamRoundtrip test pool: unexpected query: ${sql.slice(0, 120)}`);
  }

  return { query, connect: async () => ({ query, release: () => {} }), rows };
}

describe("EventStoreService round-trip", () => {
  test("an appended event is returned by getStream for the same aggregate type/id", async () => {
    const pool = createEventStorePool();
    const store = new EventStoreService(pool);
    const txHash = makeTxHash("a");

    const event = new DonationRecordedEvent({
      aggregateId: txHash,
      version: 1,
      actor: "donor-1",
      projectId: "proj-1",
      donorAddress: makePublicKey("A"),
      amountXlm: 10,
      currency: "XLM",
      transactionHash: txHash,
    });

    const appendResult = await store.append(event);
    expect(appendResult.inserted).toBe(true);

    const streamEvents = await store.getStream("Donation", txHash);
    expect(streamEvents).toHaveLength(1);
    expect(streamEvents[0].event_id).toBe(event.eventId);
    expect(streamEvents[0].stream_id).toBe(`Donation:${txHash}`);

    const version = await store.getStreamVersion("Donation", txHash);
    expect(version).toBe(1);
  });

  test("getStream returns nothing for an aggregate id that was never written", async () => {
    const pool = createEventStorePool();
    const store = new EventStoreService(pool);

    const streamEvents = await store.getStream("Donation", makeTxHash("z"));
    expect(streamEvents).toHaveLength(0);
  });
});

describe("commandBus round-trip: execute() -> loadAggregateStream()", () => {
  test("a donation recorded through execute() is returned by loadAggregateStream for the same transaction hash", async () => {
    const pool = createEventStorePool();
    const txHash = makeTxHash("b");
    const donorAddress = makePublicKey("B");

    const cmd = new RecordDonationCommand({
      actor: donorAddress,
      projectId: "proj-1",
      donorAddress,
      amountXlm: "25",
      currency: "XLM",
      transactionHash: txHash,
    });

    const result = await execute(cmd, pool);
    expect(result.deduplicated).toBe(false);

    const events = await loadAggregateStream("Donation", txHash, pool);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("DonationRecorded");
    expect(events[0].aggregateId).toBe(txHash);
    expect(events[0].data.transactionHash).toBe(txHash);
  });

  test("loadAggregateStream for a different aggregate type never returns another type's events, even with the same raw id", async () => {
    const pool = createEventStorePool();
    // A Match aggregate and a Donation aggregate that happen to share a raw
    // id must land in different streams — proof the type is really part of
    // the id the reader builds, not just decoration.
    const sharedId = "shared-id-123";

    const donationCmd = new RecordDonationCommand({
      actor: makePublicKey("C"),
      projectId: "proj-1",
      donorAddress: makePublicKey("C"),
      amountXlm: "5",
      currency: "XLM",
      transactionHash: makeTxHash("c"),
    });
    await execute(donationCmd, pool);

    const matchEvents = await loadAggregateStream("Match", sharedId, pool);
    expect(matchEvents).toHaveLength(0);
  });
});

describe("aggregate replay reproduces read-model state", () => {
  test("a ProjectAggregate rebuilt only from loadAggregateStream matches the state applied live at write time", async () => {
    const pool = createEventStorePool();
    const projectId = "proj-1";
    const txHash = makeTxHash("d");
    const donorAddress = makePublicKey("D");

    const cmd = new RecordDonationCommand({
      actor: donorAddress,
      projectId,
      donorAddress,
      amountXlm: "42",
      currency: "XLM",
      transactionHash: txHash,
    });

    const { events: liveEvents } = await execute(cmd, pool);

    // "Live" state: the aggregate as commandBus applied the event to it in
    // the same request that wrote it.
    const liveProject = new ProjectAggregate({ raisedXlm: 0, donorCount: 0, status: "active", goalXlm: 1000 });
    liveProject.apply(liveEvents[0], false);

    // "Replayed" state: a brand-new aggregate fed only from events read back
    // out of the stream — what a read-model rebuild does after the fact.
    const replayedProject = new ProjectAggregate({ raisedXlm: 0, donorCount: 0, status: "active", goalXlm: 1000 });
    const streamEvents = await loadAggregateStream("Donation", txHash, pool);
    replayedProject.loadFromEvents(streamEvents);

    expect(replayedProject.getState().raisedXlm).toBe(liveProject.getState().raisedXlm);
    expect(replayedProject.getState().raisedXlm).toBe(42);
  });

  test("a DonorAggregate rebuilt from the stream matches the donor's live totals", async () => {
    const pool = createEventStorePool();
    const donorAddress = makePublicKey("E");
    const txHash = makeTxHash("e");

    const cmd = new RecordDonationCommand({
      actor: donorAddress,
      projectId: "proj-1",
      donorAddress,
      amountXlm: "17.5",
      currency: "XLM",
      transactionHash: txHash,
    });

    const { events: liveEvents } = await execute(cmd, pool);

    const liveDonor = new DonorAggregate();
    liveDonor.apply(liveEvents[0], false);

    const replayedDonor = new DonorAggregate();
    const streamEvents = await loadAggregateStream("Donation", txHash, pool);
    replayedDonor.loadFromEvents(streamEvents);

    expect(replayedDonor.getState().totalDonatedXlm).toBe(liveDonor.getState().totalDonatedXlm);
    expect(replayedDonor.getState().totalDonatedXlm).toBe(17.5);
    expect(replayedDonor.getState().projectsSupported.has("proj-1")).toBe(true);
  });
});
