/**
 * src/services/onboarding/claimableBalances.test.js
 */
"use strict";

const { Keypair, Networks, Account, Asset } = require("@stellar/stellar-sdk");
const {
  DEFAULT_RECLAIM_WINDOW_SECONDS,
  buildClaimants,
  buildFundingBalanceTransaction,
  buildDonationBalanceTransaction,
  buildClaimTransaction,
  listClaimable,
  predicateOpen,
} = require("./claimableBalances");

const FUNDER = Keypair.random().publicKey();
const RECIPIENT = Keypair.random().publicKey();
const PROJECT = Keypair.random().publicKey();
const PASSPHRASE = Networks.TESTNET;

const account = (id, seq = "1") => new Account(id, seq);

describe("buildClaimants", () => {
  it("gives the recipient an unconditional claim", () => {
    const [recipient] = buildClaimants(RECIPIENT, FUNDER);
    expect(recipient.destination).toBe(RECIPIENT);
    expect(recipient.predicate.switch().name).toBe("claimPredicateUnconditional");
  });

  it("gives the creator a claim only after the window, so funds are never stranded", () => {
    // A single-claimant balance is a way to lose money permanently to a typo.
    const [, creator] = buildClaimants(RECIPIENT, FUNDER);
    expect(creator.destination).toBe(FUNDER);
    expect(creator.predicate.switch().name).toBe("claimPredicateNot");
  });

  it("defaults the reclaim window to two weeks", () => {
    expect(DEFAULT_RECLAIM_WINDOW_SECONDS).toBe(14 * 24 * 60 * 60);
  });

  it("refuses a recipient that is also the reclaim address", () => {
    expect(() => buildClaimants(RECIPIENT, RECIPIENT)).toThrow(/cannot be the same/i);
  });

  it("refuses a malformed address", () => {
    expect(() => buildClaimants("nope", FUNDER)).toThrow(/valid Stellar address/i);
  });
});

describe("buildFundingBalanceTransaction", () => {
  it("commits value to an address that need not be an account yet", () => {
    // This is the property the whole path rests on: a payment would require the
    // destination to exist; a claimable balance does not.
    const tx = buildFundingBalanceTransaction({
      funderAccount: account(FUNDER),
      recipient: RECIPIENT,
      amount: "25",
      networkPassphrase: PASSPHRASE,
    });
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0].type).toBe("createClaimableBalance");
    expect(Number(tx.operations[0].amount)).toBe(25);
  });

  it("attaches an optional memo, truncated to the Stellar text limit", () => {
    const tx = buildFundingBalanceTransaction({
      funderAccount: account(FUNDER),
      recipient: RECIPIENT,
      amount: "1",
      networkPassphrase: PASSPHRASE,
      memo: "a".repeat(60),
    });
    expect(tx.memo.value.toString()).toHaveLength(28);
  });

  it("refuses a malformed recipient before building anything", () => {
    expect(() =>
      buildFundingBalanceTransaction({
        funderAccount: account(FUNDER),
        recipient: "nope",
        amount: "1",
        networkPassphrase: PASSPHRASE,
      }),
    ).toThrow(/valid Stellar address/i);
  });
});

describe("buildDonationBalanceTransaction", () => {
  it("lets a donation reach a project wallet that cannot receive the asset yet", () => {
    const tx = buildDonationBalanceTransaction({
      donorAccount: account(RECIPIENT),
      projectWallet: PROJECT,
      amount: "10",
      asset: new Asset("USDC", PROJECT),
      networkPassphrase: PASSPHRASE,
    });
    const claimants = tx.operations[0].claimants;
    expect(claimants[0].destination).toBe(PROJECT);
    // The donor keeps the reclaim, so a project that never adds the trustline
    // does not silently absorb the funds.
    expect(claimants[1].destination).toBe(RECIPIENT);
  });
});

describe("buildClaimTransaction", () => {
  const BALANCE_ID = "0".repeat(72);

  it("builds a single claim operation", () => {
    const tx = buildClaimTransaction({
      claimantAccount: account(RECIPIENT),
      balanceId: BALANCE_ID,
      networkPassphrase: PASSPHRASE,
    });
    expect(tx.operations[0].type).toBe("claimClaimableBalance");
  });

  it("refuses a balance id of the wrong shape", () => {
    expect(() =>
      buildClaimTransaction({
        claimantAccount: account(RECIPIENT),
        balanceId: "short",
        networkPassphrase: PASSPHRASE,
      }),
    ).toThrow(/valid claimable balance id/i);
  });
});

describe("predicateOpen", () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();

  it("opens an unconditional predicate", () => {
    expect(predicateOpen({ unconditional: true })).toBe(true);
  });

  it("closes an absolute deadline that has passed", () => {
    expect(predicateOpen({ abs_before: past })).toBe(false);
    expect(predicateOpen({ abs_before: future })).toBe(true);
  });

  it("inverts a not predicate", () => {
    expect(predicateOpen({ not: { abs_before: future } })).toBe(false);
    expect(predicateOpen({ not: { abs_before: past } })).toBe(true);
  });

  it("requires every branch of an and", () => {
    expect(predicateOpen({ and: [{ unconditional: true }, { abs_before: future }] })).toBe(true);
    expect(predicateOpen({ and: [{ unconditional: true }, { abs_before: past }] })).toBe(false);
  });

  it("requires any branch of an or", () => {
    expect(predicateOpen({ or: [{ abs_before: past }, { unconditional: true }] })).toBe(true);
  });

  it("closes an unrecognised shape rather than offering a claim that would fail", () => {
    expect(predicateOpen({ something_new: true })).toBe(false);
    expect(predicateOpen(null)).toBe(false);
  });
});

describe("listClaimable", () => {
  it("returns only balances the address can claim right now", () => {
    const server = {
      claimableBalances: () => ({
        claimant: () => ({
          limit: () => ({
            call: async () => ({
              records: [
                {
                  id: "a",
                  asset: "native",
                  amount: "10",
                  claimants: [{ destination: RECIPIENT, predicate: { unconditional: true } }],
                },
                {
                  id: "b",
                  asset: "native",
                  amount: "5",
                  claimants: [
                    {
                      destination: RECIPIENT,
                      predicate: { abs_before: new Date(Date.now() - 1000).toISOString() },
                    },
                  ],
                },
              ],
            }),
          }),
        }),
      }),
    };

    return listClaimable(server, RECIPIENT).then((balances) => {
      expect(balances.map((b) => b.id)).toEqual(["a"]);
    });
  });
});
