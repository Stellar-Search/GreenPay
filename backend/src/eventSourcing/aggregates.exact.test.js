"use strict";

/**
 * Exactness properties for the event-sourcing aggregates, plus the
 * goal-completion and match-cap boundary behaviour.
 *
 * Aggregates hold monetary state as BigInt stroops, so summing any number of
 * donations must reproduce the stored total exactly — a project that is one
 * stroop short of its goal is not funded, and a match cap is consumed to the
 * final stroop.
 */

const fc = require("fast-check");
const {
  ProjectAggregate,
  DonorAggregate,
  MatchAggregate,
} = require("./aggregates");
const { DonationRecordedEvent, MatchAppliedEvent } = require("./events");
const { xlmToStroops, stroopsToXlm } = require("../utils/xlm");

function xlmAmountArbitrary(maxWhole = 100_000) {
  return fc.tuple(
    fc.integer({ min: 0, max: maxWhole }),
    fc.integer({ min: 0, max: 9_999_999 }),
  ).map(([whole, frac]) => `${whole}.${frac.toString().padStart(7, "0")}`);
}

let eventCounter = 0;
function makeDonationEvent(amount) {
  eventCounter += 1;
  return new DonationRecordedEvent({
    aggregateId: `Donation:prop-${eventCounter}`,
    version: 1,
    actor: "test",
    projectId: "project-1",
    donorAddress: `G${"A".repeat(55)}`,
    amountXlm: amount,
    currency: "XLM",
    message: null,
    transactionHash: "a".repeat(64),
  });
}

describe("ProjectAggregate exact raised totals", () => {
  test("property: replaying many donations sums exactly in stroops", () => {
    fc.assert(
      fc.property(fc.array(xlmAmountArbitrary(), { minLength: 1, maxLength: 300 }), (amounts) => {
        const aggregate = new ProjectAggregate();
        for (const amount of amounts) {
          aggregate.apply(makeDonationEvent(amount), false);
        }
        const expectedStroops = amounts.reduce((acc, a) => acc + xlmToStroops(a), 0n);
        expect(aggregate.getState().raisedXlmStroops).toBe(expectedStroops);
        expect(aggregate.getState().raisedXlm).toBe(stroopsToXlm(expectedStroops));
      }),
      { numRuns: 200 },
    );
  });

  test("property: state hydrated from a NUMERIC row resumes exactly", () => {
    fc.assert(
      fc.property(
        xlmAmountArbitrary(),
        fc.array(xlmAmountArbitrary(), { minLength: 0, maxLength: 100 }),
        (seedAmount, amounts) => {
          const aggregate = ProjectAggregate.fromState({
            raised_xlm: seedAmount,
            goal_xlm: "1000.0000000",
            donor_count: 1,
            status: "active",
          });
          for (const amount of amounts) {
            aggregate.apply(makeDonationEvent(amount), false);
          }
          const expected = xlmToStroops(seedAmount) +
            amounts.reduce((acc, a) => acc + xlmToStroops(a), 0n);
          expect(aggregate.getState().raisedXlm).toBe(stroopsToXlm(expected));
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("DonorAggregate exact donated totals", () => {
  test("property: lifetime total equals the exact stroop sum", () => {
    fc.assert(
      fc.property(fc.array(xlmAmountArbitrary(), { minLength: 1, maxLength: 300 }), (amounts) => {
        const aggregate = new DonorAggregate();
        for (const amount of amounts) {
          aggregate.apply(makeDonationEvent(amount), false);
        }
        const expected = amounts.reduce((acc, a) => acc + xlmToStroops(a), 0n);
        const state = aggregate.getState();
        expect(state.totalDonatedXlmStroops).toBe(expected);
        expect(state.totalDonatedXlm).toBe(stroopsToXlm(expected));
      }),
      { numRuns: 200 },
    );
  });

  test("non-XLM donations never enter the XLM total", () => {
    const aggregate = new DonorAggregate();
    aggregate.apply(makeDonationEvent("10.0000000"), false);
    aggregate.apply({
      eventType: "DonationRecorded",
      data: { currency: "USDC", projectId: "p2", amountXlm: 50 },
    }, false);
    expect(aggregate.getState().totalDonatedXlm).toBe("10.0000000");
  });
});

describe("MatchAggregate cap boundary", () => {
  function matchEvent(amount) {
    eventCounter += 1;
    return new MatchAppliedEvent({
      aggregateId: `Match:m-${eventCounter}`,
      version: 1,
      actor: "test",
      matchId: `m-${eventCounter}`,
      projectId: "project-1",
      donorAddress: `G${"B".repeat(55)}`,
      matchAmount: amount,
      originalTxHash: null,
      multiplier: 1,
    });
  }

  test("accepts a match at exactly the remaining cap, rejects one stroop more", () => {
    const aggregate = new MatchAggregate();
    aggregate.apply({
      eventType: "MatchCreated",
      data: { capStroops: "500000000", multiplier: 1 },
    }, false);
    // cap = 50.0000000 XLM; consume all but one stroop
    aggregate.apply(matchEvent("49.9999999"), false);

    // One stroop over the remaining cap → rejected
    expect(() => aggregate.validateApplyMatch(2n)).toThrow(/exceeds remaining cap/);
    // Exactly the remaining single stroop → accepted
    expect(() => aggregate.validateApplyMatch(1n)).not.toThrow();

    aggregate.apply(matchEvent("0.0000001"), false);
    // Fully consumed → anything is rejected
    expect(() => aggregate.validateApplyMatch(1n)).toThrow(/fully consumed/);
    expect(aggregate.getState().matchedXlmStroops).toBe(500000000n);
  });

  test("property: matched total never exceeds the cap under arbitrary applies", () => {
    fc.assert(
      fc.property(
        fc.array(xlmAmountArbitrary(20), { minLength: 1, maxLength: 50 }),
        (amounts) => {
          const aggregate = new MatchAggregate();
          aggregate.apply({
            eventType: "MatchCreated",
            data: { capStroops: "1000000000", multiplier: 1 }, // 100 XLM
          }, false);
          for (const amount of amounts) {
            try {
              aggregate.validateApplyMatch(xlmToStroops(amount));
              aggregate.apply(matchEvent(amount), false);
            } catch {
              // rejected by the cap — the aggregate must be untouched
            }
            expect(
              aggregate.getState().matchedXlmStroops <= 1000000000n,
            ).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  test("legacy payload with a double matchAmount hydrates to exact stroops", () => {
    const legacyPayload = {
      eventId: "legacy-event",
      aggregateType: "Match",
      aggregateId: "match-1",
      eventType: "MatchApplied",
      version: 3,
      actor: "system",
      occurredAt: new Date().toISOString(),
      data: {
        matchId: "match-1",
        projectId: "p",
        donorAddress: "G".repeat(56),
        matchAmount: 0.1 + 0.2, // classic double artifact: 0.30000000000000004
        multiplier: 1,
      },
    };
    const { fromPayload } = require("./events");
    const event = fromPayload(legacyPayload);
    const aggregate = new MatchAggregate();
    aggregate.apply(event, false);
    expect(aggregate.getState().matchedXlmStroops).toBe(3000000n);
  });
});

describe("DonationRecorded payload round-trip", () => {
  test("property: stroops survive serialize → hydrate exactly", () => {
    fc.assert(
      fc.property(
        xlmAmountArbitrary(),
        fc.integer({ min: 1, max: 9 }),
        fc.string({ minLength: 0, maxLength: 20 }),
        (amount, version, message) => {
          const original = makeDonationEvent(amount);
          original.version = version;
          const payload = JSON.parse(JSON.stringify(original.toPayload()));
          const revived = require("./events").fromPayload(payload);
          expect(revived.data.amountStroops).toBe(original.data.amountStroops);
          expect(revived.data.amountXlm).toBe(amount);
        },
      ),
      { numRuns: 200 },
    );
  });
});
