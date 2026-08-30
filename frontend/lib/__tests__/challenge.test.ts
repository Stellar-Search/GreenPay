/**
 * lib/__tests__/challenge.test.ts
 *
 * Every property here exists so that signing the challenge cannot move money.
 * They are tested individually because "it looked safe" is how a signing
 * primitive becomes a payment.
 */
import { CHALLENGE_DATA_NAME, buildChallengeTransaction, assertSignedChallenge } from "@/lib/challenge";
import { Keypair, Networks, Transaction } from "@stellar/stellar-sdk";

const WALLET = Keypair.random();
const NONCE = "a".repeat(48);

function parse(xdr: string) {
  return new Transaction(xdr, Networks.TESTNET);
}

describe("buildChallengeTransaction", () => {
  const xdr = buildChallengeTransaction({ address: WALLET.publicKey(), nonce: NONCE });
  const tx = parse(xdr);

  it("uses sequence 0, which no live account has, so it can never be submitted", () => {
    expect(tx.sequence).toBe("0");
  });

  it("carries exactly one operation", () => {
    expect(tx.operations).toHaveLength(1);
  });

  it("uses manageData, which has no destination and no amount", () => {
    // There is no version of this transaction that transfers value, whatever
    // else goes wrong.
    expect(tx.operations[0].type).toBe("manageData");
  });

  it("binds the nonce, so a captured signature cannot authorise a later migration", () => {
    const op = tx.operations[0] as { name: string; value: Buffer };
    expect(op.name).toBe(CHALLENGE_DATA_NAME);
    expect(Buffer.from(op.value).toString("utf8")).toBe(NONCE);
  });

  it("is sourced by the address being proved", () => {
    expect(tx.source).toBe(WALLET.publicKey());
  });

  it("produces a different envelope for a different nonce", () => {
    const other = buildChallengeTransaction({ address: WALLET.publicKey(), nonce: "b".repeat(48) });
    expect(other).not.toBe(xdr);
  });
});

describe("assertSignedChallenge", () => {
  it("accepts an envelope signed by the connected wallet", () => {
    const tx = parse(buildChallengeTransaction({ address: WALLET.publicKey(), nonce: NONCE }));
    tx.sign(WALLET);
    expect(() => assertSignedChallenge(tx.toXDR(), WALLET.publicKey())).not.toThrow();
  });

  it("rejects an unsigned envelope", () => {
    const xdr = buildChallengeTransaction({ address: WALLET.publicKey(), nonce: NONCE });
    expect(() => assertSignedChallenge(xdr, WALLET.publicKey())).toThrow(/unsigned/i);
  });

  it("rejects an envelope for a different account than the one connected", () => {
    const other = Keypair.random();
    const tx = parse(buildChallengeTransaction({ address: other.publicKey(), nonce: NONCE }));
    tx.sign(other);
    expect(() => assertSignedChallenge(tx.toXDR(), WALLET.publicKey())).toThrow(/different account/i);
  });
});
