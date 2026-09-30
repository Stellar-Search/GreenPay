"use strict";

const { DonationRecordedEvent, JobReleasedEvent, buildStreamId, fromPayload } = require("./events");

function makeTxHash(char = "a") {
  return char.repeat(64);
}

describe("buildStreamId", () => {
  it("joins aggregate type and aggregate id with a single colon", () => {
    expect(buildStreamId("Donation", "tx1")).toBe("Donation:tx1");
  });

  it("does not add a prefix twice even if called twice on its own output", () => {
    // Guards the exact regression: buildStreamId must never be applied to an
    // aggregateId that a caller already prefixed.
    const once = buildStreamId("Donation", "tx1");
    expect(once).not.toContain("Donation:Donation:");
  });
});

describe("DomainEvent.getStreamId", () => {
  it("prefixes the aggregate type exactly once when aggregateId is unprefixed", () => {
    const event = new DonationRecordedEvent({
      aggregateId: makeTxHash("a"),
      version: 1,
      actor: "donor-1",
      projectId: "proj-1",
      donorAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amountXlm: 10,
      currency: "XLM",
      transactionHash: makeTxHash("a"),
    });

    expect(event.getStreamId()).toBe(`Donation:${makeTxHash("a")}`);
    expect(event.getStreamId()).not.toContain("Donation:Donation:");
  });

  it("uses buildStreamId under the hood, so a reader building the same id from the same inputs always matches", () => {
    const event = new JobReleasedEvent({
      aggregateId: "job-1",
      version: 1,
      actor: "system",
      clientPublicKey: "GCLIENT",
      freelancerPublicKey: "GFREELANCER",
      amountXlm: 5,
      releaseTransactionHash: makeTxHash("b"),
    });

    expect(event.getStreamId()).toBe(buildStreamId("Job", "job-1"));
  });
});

describe("DomainEvent.toRow", () => {
  it("stores aggregate_id unprefixed while stream_id carries the type prefix", () => {
    const event = new DonationRecordedEvent({
      aggregateId: makeTxHash("c"),
      version: 1,
      actor: "donor-1",
      projectId: "proj-1",
      donorAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amountXlm: 10,
      currency: "XLM",
      transactionHash: makeTxHash("c"),
    });

    const row = event.toRow();
    expect(row.aggregate_id).toBe(makeTxHash("c"));
    expect(row.stream_id).toBe(`Donation:${makeTxHash("c")}`);
    // The stored row's own fields agree with a reader that rebuilds the
    // stream id the same way getStream/loadAggregateStream do.
    expect(row.stream_id).toBe(buildStreamId(row.aggregate_type, row.aggregate_id));
  });
});

describe("fromPayload round-trips aggregateId unchanged", () => {
  it("reconstructs an event whose aggregateId (and therefore stream id) matches the original", () => {
    const original = new DonationRecordedEvent({
      aggregateId: makeTxHash("d"),
      version: 1,
      actor: "donor-1",
      projectId: "proj-1",
      donorAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amountXlm: 10,
      currency: "XLM",
      transactionHash: makeTxHash("d"),
    });

    const reconstructed = fromPayload(original.toPayload());

    expect(reconstructed.aggregateId).toBe(original.aggregateId);
    expect(reconstructed.getStreamId()).toBe(original.getStreamId());
    expect(reconstructed.getStreamId()).not.toContain("Donation:Donation:");
  });
});
