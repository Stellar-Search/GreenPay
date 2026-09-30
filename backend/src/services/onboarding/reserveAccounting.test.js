/**
 * src/services/onboarding/reserveAccounting.test.js
 *
 * The base-reserve boundary is the arithmetic that decides whether a donation
 * is possible at all, so it is tested at the boundary rather than in the
 * middle: one stroop either side of "can this account send this payment".
 */
"use strict";

const {
  serializeCost,
  STROOPS_PER_XLM,
  DEFAULT_BASE_RESERVE_STROOPS,
  stroopsToXlmString,
  xlmStringToStroops,
  sponsorshipCost,
  sponsorshipFees,
  treasuryCapacity,
  accountSpendCheck,
  fromHorizonAccount,
  sponsorshipQuote,
} = require("./reserveAccounting");

const XLM = (n) => xlmStringToStroops(String(n));

describe("stroop conversion", () => {
  it("round-trips whole and fractional XLM without floating-point drift", () => {
    for (const value of ["0.0000000", "1.0000000", "0.0000001", "12345.6789012", "0.5000000"]) {
      expect(stroopsToXlmString(xlmStringToStroops(value))).toBe(value);
    }
  });

  it("represents 1 XLM as exactly 10,000,000 stroops", () => {
    expect(xlmStringToStroops("1")).toBe(STROOPS_PER_XLM);
  });

  it("truncates beyond seven decimal places rather than rounding up", () => {
    // Rounding up would let a quote promise a hundredth of a stroop that does
    // not exist, and the transaction would be rejected on submission.
    expect(xlmStringToStroops("0.99999999")).toBe(9_999_999n);
  });

  it("rejects a value that is not a decimal amount", () => {
    expect(() => xlmStringToStroops("ten")).toThrow(/decimal XLM amount/);
  });
});

describe("sponsorshipCost", () => {
  it("costs a bare account two base reserves — 1 XLM at today's parameters", () => {
    const cost = sponsorshipCost({});
    expect(cost.totalStroops).toBe(2n * DEFAULT_BASE_RESERVE_STROOPS);
    expect(cost.totalXlm).toBe("1.0000000");
    expect(cost.entries).toBe(2n);
  });

  it("adds one base reserve for a trustline", () => {
    expect(sponsorshipCost({ trustline: true }).totalXlm).toBe("1.5000000");
  });

  it("adds two base reserves per claimable balance", () => {
    expect(sponsorshipCost({ claimableBalances: 1 }).totalXlm).toBe("2.0000000");
    expect(sponsorshipCost({ claimableBalances: 2 }).totalXlm).toBe("3.0000000");
  });

  it("reports the whole reserve as recoverable, because reserves are locked and not spent", () => {
    const cost = sponsorshipCost({ trustline: true });
    expect(cost.recoverableStroops).toBe(cost.totalStroops);
  });

  it("tracks a base-reserve change rather than hardcoding 0.5 XLM", () => {
    // A validator vote doubling the base reserve must double every quote.
    const doubled = sponsorshipCost({ baseReserveStroops: 10_000_000n });
    expect(doubled.totalXlm).toBe("2.0000000");
  });

  it("refuses a non-positive base reserve", () => {
    expect(() => sponsorshipCost({ baseReserveStroops: 0n })).toThrow(RangeError);
  });
});

describe("sponsorshipFees", () => {
  it("counts only the fees, which are the part that never comes back", () => {
    const fees = sponsorshipFees();
    // Three operations to create, one to reclaim, at 100 stroops each.
    expect(fees.totalStroops).toBe(400n);
    expect(fees.totalXlm).toBe("0.0000400");
  });

  it("scales with a surge fee multiplier", () => {
    expect(sponsorshipFees({ feeMultiplier: 10 }).totalStroops).toBe(4000n);
  });
});

describe("treasuryCapacity", () => {
  it("reports how many donors a treasury can carry at once", () => {
    // 101 XLM: 1 XLM is the treasury's own minimum, leaving 100 XLM = 100 donors.
    const capacity = treasuryCapacity({ treasuryBalanceStroops: XLM(101) });
    expect(capacity.capacity).toBe(100);
    expect(capacity.exhausted).toBe(false);
  });

  it("counts existing sponsorships against the treasury's own minimum balance", () => {
    // Sponsoring raises numSponsoring, which raises the sponsor's own floor —
    // missing this is how a treasury wedges below its minimum and can no longer
    // afford the fee to revoke the sponsorships that would free the funds.
    const capacity = treasuryCapacity({
      treasuryBalanceStroops: XLM(101),
      activeSponsorships: 50,
    });
    expect(capacity.capacity).toBe(50);
  });

  it("reports exhaustion rather than a negative capacity", () => {
    const capacity = treasuryCapacity({ treasuryBalanceStroops: XLM(1) });
    expect(capacity.capacity).toBe(0);
    expect(capacity.exhausted).toBe(true);
    expect(capacity.lockableStroops).toBe(0n);
  });

  it("keeps an operating buffer out of lockable balance", () => {
    const withoutBuffer = treasuryCapacity({ treasuryBalanceStroops: XLM(101) });
    const withBuffer = treasuryCapacity({
      treasuryBalanceStroops: XLM(101),
      bufferStroops: XLM(20),
    });
    expect(withoutBuffer.capacity - withBuffer.capacity).toBe(20);
  });
});

describe("accountSpendCheck — the base-reserve boundary", () => {
  const BASE = { numSubEntries: 0, numSponsoring: 0, numSponsored: 0 };

  it("gives a plain account a 1 XLM minimum balance", () => {
    const check = accountSpendCheck({ ...BASE, balanceStroops: XLM(5) });
    expect(check.minimumBalanceStroops).toBe(XLM(1));
  });

  it("refuses a payment one stroop above the boundary", () => {
    // 2 XLM balance, 1 XLM locked as reserve, 100 stroops of fee:
    // spendable is exactly 0.99999 XLM.
    const spendable = XLM(2) - XLM(1) - 100n;
    const check = accountSpendCheck({
      ...BASE,
      balanceStroops: XLM(2),
      amountStroops: spendable + 1n,
    });
    expect(check.sufficient).toBe(false);
    expect(check.shortfallStroops).toBe(1n);
  });

  it("allows a payment of exactly the spendable amount", () => {
    const spendable = XLM(2) - XLM(1) - 100n;
    const check = accountSpendCheck({
      ...BASE,
      balanceStroops: XLM(2),
      amountStroops: spendable,
    });
    expect(check.sufficient).toBe(true);
    expect(check.shortfallStroops).toBe(0n);
  });

  it("counts a trustline as a subentry, which is the case that surprises donors", () => {
    // 1.4 XLM with a USDC trustline looks spendable and is not: 1.5 XLM is
    // locked, so the account is already below its own minimum.
    const check = accountSpendCheck({
      ...BASE,
      balanceStroops: XLM("1.4"),
      numSubEntries: 1,
      amountStroops: XLM("0.1"),
    });
    expect(check.minimumBalanceStroops).toBe(XLM("1.5"));
    expect(check.spendableStroops).toBe(0n);
    expect(check.sufficient).toBe(false);
  });

  it("gives a fully sponsored account a zero minimum balance", () => {
    // This is the whole point of the sponsored path: the donor can spend every
    // stroop they receive, because the platform carries the reserve.
    const check = accountSpendCheck({
      balanceStroops: XLM(10),
      numSubEntries: 0,
      numSponsoring: 0,
      numSponsored: 2,
      amountStroops: XLM(10) - 100n,
    });
    expect(check.minimumBalanceStroops).toBe(0n);
    expect(check.sufficient).toBe(true);
  });

  it("treats a brand-new zero-balance account as unable to send anything", () => {
    const check = accountSpendCheck({ ...BASE, balanceStroops: 0n, amountStroops: XLM(1) });
    expect(check.sufficient).toBe(false);
    expect(check.spendableStroops).toBe(0n);
  });

  it("never reports negative spendable balance for an account below its minimum", () => {
    const check = accountSpendCheck({ ...BASE, balanceStroops: XLM("0.2") });
    expect(check.spendableStroops).toBe(0n);
  });

  it("charges the transaction fee on top of the reserve", () => {
    const noFee = accountSpendCheck({ ...BASE, balanceStroops: XLM(2), feeStroops: 0 });
    const withFee = accountSpendCheck({ ...BASE, balanceStroops: XLM(2), feeStroops: 100 });
    expect(noFee.spendableStroops - withFee.spendableStroops).toBe(100n);
  });
});

describe("fromHorizonAccount", () => {
  it("decodes Horizon's field names into the boundary check's inputs", () => {
    const decoded = fromHorizonAccount({
      subentry_count: 3,
      num_sponsoring: 1,
      num_sponsored: 2,
      balances: [
        { asset_type: "credit_alphanum4", asset_code: "USDC", balance: "50.0000000" },
        { asset_type: "native", balance: "7.5000000" },
      ],
    });
    expect(decoded.balanceStroops).toBe(XLM("7.5"));
    expect(decoded.numSubEntries).toBe(3n);
    expect(decoded.numSponsored).toBe(2n);
  });

  it("treats an account with no native balance as zero rather than throwing", () => {
    expect(fromHorizonAccount({ balances: [] }).balanceStroops).toBe(0n);
  });
});

describe("sponsorshipQuote", () => {
  it("states the locked amount and that it is recoverable", () => {
    const quote = sponsorshipQuote({});
    expect(quote.lockedXlm).toBe("1.0000000");
    expect(quote.recoverable).toBe(true);
  });

  it("leads with what the donor gives up, not with the benefit", () => {
    const quote = sponsorshipQuote({});
    const keyOwnership = quote.disclosure.find((line) => /you hold your own key/i.test(line));
    expect(keyOwnership).toMatch(/cannot sign for you/i);
    expect(keyOwnership).toMatch(/cannot .*recover your key/i);
  });
});

describe("serializeCost — the HTTP boundary", () => {
  it("produces a value JSON can actually serialize", () => {
    // BigInt throws "Do not know how to serialize a BigInt" inside res.json(),
    // which turns a working sponsorship quote into a 500 for every donor. This
    // only shows up once a sponsor is configured, so it is asserted directly.
    const serialized = serializeCost(sponsorshipCost({ trustline: true }));
    expect(() => JSON.stringify(serialized)).not.toThrow();
  });

  it("contains no BigInt anywhere in the tree", () => {
    const serialized = serializeCost(sponsorshipCost({ trustline: true, claimableBalances: 2 }));
    for (const [key, value] of Object.entries(serialized)) {
      expect(typeof value).not.toBe("bigint");
      expect(`${key} is ${typeof value}`).toMatch(/(string|number)$/);
    }
  });

  it("preserves the exact stroop total as a string, losing no precision", () => {
    const cost = sponsorshipCost({ trustline: true });
    expect(serializeCost(cost).totalStroops).toBe(cost.totalStroops.toString());
    expect(serializeCost(cost).totalXlm).toBe("1.5000000");
  });

  it("keeps every component of the cost breakdown", () => {
    const serialized = serializeCost(sponsorshipCost({ trustline: true, claimableBalances: 1 }));
    expect(serialized.accountXlm).toBe("1.0000000");
    expect(serialized.trustlineXlm).toBe("0.5000000");
    expect(serialized.claimableBalanceXlm).toBe("1.0000000");
    expect(serialized.entries).toBe(5);
  });
});
