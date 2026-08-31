/**
 * lib/challenge.ts — proving control of a wallet address without a payment.
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 * Migrating donation history needs proof that the donor controls the
 * destination wallet. Ed25519 signs arbitrary bytes happily, but wallet
 * extensions deliberately will not: a wallet that signs opaque bytes on request
 * is a wallet that can be tricked into signing a payment presented as a
 * "verification message". Freighter's API therefore signs transaction envelopes
 * and nothing else.
 *
 * ── The standard answer, which this follows ─────────────────────────────────
 * SEP-10 solves exactly this by building a transaction that *cannot* be
 * submitted and having the wallet sign that. The pieces each do a job:
 *
 *   - **sequence 0** — no live account ever has it, so the network rejects the
 *     envelope outright. Signing it can never move anything.
 *   - **a `manageData` operation, not a payment** — there is no destination and
 *     no amount, so there is no version of this transaction that transfers
 *     value even if every other guard failed.
 *   - **the nonce as the data value** — this is what makes the proof
 *     single-use and bound to *this* migration rather than replayable against
 *     another one. Without it, a signature captured once would authorise every
 *     future upgrade of the same address.
 *
 * The backend re-derives the envelope hash from the returned XDR and verifies
 * the signature against it. See `verifyChallengeEnvelope` in
 * backend/src/services/onboarding/accountUpgrade.js — the two halves of this
 * protocol have to agree, so they are commented as one thing in two places.
 */
import { Account, Operation, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE } from "./stellar";

/**
 * The `manageData` key the wallet displays. Shared verbatim with the backend:
 * a mismatch means every migration fails closed, which is the right direction,
 * but it also means this string is protocol and not decoration.
 */
export const CHALLENGE_DATA_NAME = "GreenPay account upgrade";

/**
 * Builds the unsubmittable challenge transaction for `address` to sign.
 *
 * Sequence "-1" is what the SDK increments to 0 — the value SEP-10 uses for
 * precisely this purpose.
 */
export function buildChallengeTransaction({ address, nonce }: { address: string; nonce: string }): string {
  const account = new Account(address, "-1");
  return new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.manageData({
        name: CHALLENGE_DATA_NAME,
        // manageData values are capped at 64 bytes; the nonce is 48 hex chars.
        value: nonce,
        source: address,
      }),
    )
    .setTimeout(300)
    .build()
    .toXDR();
}

/**
 * Sanity-checks a signed challenge before it is sent.
 *
 * The backend checks all of this again and is the authority — this is here so a
 * wallet that returns something unexpected produces a legible message in the UI
 * instead of a rejection from the server two steps later.
 */
export function assertSignedChallenge(signedXdr: string, address: string): void {
  const tx = new Transaction(signedXdr, NETWORK_PASSPHRASE);
  if (tx.signatures.length === 0) {
    throw new Error("The wallet returned an unsigned transaction.");
  }
  if (tx.source !== address) {
    throw new Error("The wallet signed with a different account than the one you connected.");
  }
}
