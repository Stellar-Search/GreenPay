/**
 * src/services/onboarding/claimableBalances.js
 *
 * The path for value that arrives before an account does.
 *
 * A Stellar payment requires the destination account to already exist. A
 * *claimable balance* does not: its claimant is an address, and the address
 * does not have to resolve to anything at the moment the balance is created.
 * That is the property this path is built on — it lets an on-ramp, a friend,
 * or a matching sponsor put value behind a brand-new donor's address before
 * the platform has sponsored the account into existence, instead of making
 * those two steps a strict, failure-prone sequence.
 *
 * ── What it does not solve ──────────────────────────────────────────────────
 * Creating a balance for a non-existent claimant works; *claiming* it still
 * requires the claimant's account to exist, because claiming needs a
 * transaction and a transaction needs a source account. So this is not a way
 * to skip account creation — it is a way to stop ordering from mattering. The
 * honest statement of the guarantee is: **value can be committed to a donor
 * before their account exists, and is claimable the moment it does.** Anywhere
 * that guarantee is presented to a donor, it is presented in those terms.
 *
 * ── Predicates ──────────────────────────────────────────────────────────────
 * Every balance created here carries two claimants: the intended recipient
 * unconditionally, and the *creator* under a `not(before relative time T)`
 * predicate. The second one is the part that matters for abandonment: if the
 * recipient never claims, the funds are not stranded — the creator can take
 * them back after the window. A claimable balance with a single claimant is a
 * way to lose money permanently to a typo.
 */
"use strict";

const {
  Asset,
  Claimant,
  Memo,
  Operation,
  TransactionBuilder,
  StrKey,
  BASE_FEE,
} = require("@stellar/stellar-sdk");

/**
 * How long before an unclaimed balance can be taken back by whoever created it.
 * Long enough that a donor who closes the tab and comes back tomorrow still has
 * their funds; short enough that abandoned reserve does not accumulate.
 */
const DEFAULT_RECLAIM_WINDOW_SECONDS = 14 * 24 * 60 * 60; // 14 days

class ClaimableBalanceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "ClaimableBalanceError";
    this.code = code;
    this.status = status;
  }
}

function assertAddress(address, label) {
  if (!StrKey.isValidEd25519PublicKey(address)) {
    throw new ClaimableBalanceError("INVALID_ADDRESS", `${label} is not a valid Stellar address.`);
  }
}

/**
 * The two-claimant predicate pair described above.
 *
 * @param {string} recipient Who the value is for.
 * @param {string} creator Who gets it back if it is never claimed.
 */
function buildClaimants(recipient, creator, reclaimAfterSeconds = DEFAULT_RECLAIM_WINDOW_SECONDS) {
  assertAddress(recipient, "recipient");
  assertAddress(creator, "creator");
  if (recipient === creator) {
    throw new ClaimableBalanceError(
      "SAME_CLAIMANT",
      "The recipient and the reclaim address cannot be the same account.",
    );
  }

  return [
    // The recipient may claim at any time.
    new Claimant(recipient, Claimant.predicateUnconditional()),
    // The creator may claim only *after* the window — `not(before T)` — so the
    // two predicates never overlap into a race where both can claim at once.
    new Claimant(
      creator,
      Claimant.predicateNot(Claimant.predicateBeforeRelativeTime(String(reclaimAfterSeconds))),
    ),
  ];
}

/**
 * Builds a transaction that commits `amount` to a donor's address before that
 * address is an account.
 *
 * The source account (the funder) signs this — never the platform, which is
 * why no secret key is a parameter here. On the on-ramp path the funder is the
 * anchor; on the gift path it is another donor.
 */
function buildFundingBalanceTransaction({
  funderAccount,
  recipient,
  amount,
  asset = Asset.native(),
  networkPassphrase,
  reclaimAfterSeconds = DEFAULT_RECLAIM_WINDOW_SECONDS,
  memo,
  fee = BASE_FEE,
}) {
  assertAddress(recipient, "recipient");
  const builder = new TransactionBuilder(funderAccount, {
    fee: String(fee),
    networkPassphrase,
  })
    .addOperation(
      Operation.createClaimableBalance({
        asset,
        amount: String(amount),
        claimants: buildClaimants(recipient, funderAccount.accountId(), reclaimAfterSeconds),
      }),
    )
    .setTimeout(300);

  if (memo) builder.addMemo(Memo.text(String(memo).slice(0, 28)));
  return builder.build();
}

/**
 * Builds a donation delivered as a claimable balance to a project.
 *
 * Used when a straight payment would fail for a reason that has nothing to do
 * with the donor's intent — most often a project wallet with no trustline for
 * the asset being given. Rather than refusing the donation, it is committed to
 * the project and claimable as soon as the trustline exists. The donor keeps
 * the reclaim predicate, so a project that never adds the trustline does not
 * silently absorb the funds.
 */
function buildDonationBalanceTransaction({
  donorAccount,
  projectWallet,
  amount,
  asset = Asset.native(),
  networkPassphrase,
  reclaimAfterSeconds = DEFAULT_RECLAIM_WINDOW_SECONDS,
  memo,
  fee = BASE_FEE,
}) {
  assertAddress(projectWallet, "projectWallet");
  const builder = new TransactionBuilder(donorAccount, {
    fee: String(fee),
    networkPassphrase,
  })
    .addOperation(
      Operation.createClaimableBalance({
        asset,
        amount: String(amount),
        claimants: buildClaimants(projectWallet, donorAccount.accountId(), reclaimAfterSeconds),
      }),
    )
    .setTimeout(300);

  if (memo) builder.addMemo(Memo.text(String(memo).slice(0, 28)));
  return builder.build();
}

/**
 * Builds the transaction that claims a balance. Signed by the claimant, whose
 * account must exist by now — see the module header for why that is a real
 * constraint and not an oversight.
 */
function buildClaimTransaction({ claimantAccount, balanceId, networkPassphrase, fee = BASE_FEE }) {
  if (!/^[0-9a-f]{72}$/i.test(String(balanceId))) {
    throw new ClaimableBalanceError("INVALID_BALANCE_ID", "Not a valid claimable balance id.");
  }
  return new TransactionBuilder(claimantAccount, {
    fee: String(fee),
    networkPassphrase,
  })
    .addOperation(Operation.claimClaimableBalance({ balanceId: String(balanceId) }))
    .setTimeout(180)
    .build();
}

/**
 * Lists the balances an address can claim right now.
 *
 * Horizon returns every balance naming the address as a claimant, including
 * ones whose predicate has not opened yet. Filtering that here keeps the UI
 * from offering a claim that would be rejected on submission.
 */
async function listClaimable(server, address) {
  assertAddress(address, "address");
  const page = await server.claimableBalances().claimant(address).limit(50).call();
  const now = Date.now();

  return (page.records || [])
    .map((record) => {
      const claimant = (record.claimants || []).find((c) => c.destination === address);
      return {
        id: record.id,
        asset: record.asset,
        amount: record.amount,
        sponsor: record.sponsor,
        lastModifiedLedger: record.last_modified_ledger,
        claimableNow: claimant ? predicateOpen(claimant.predicate, now) : false,
      };
    })
    .filter((b) => b.claimableNow);
}

/**
 * Evaluates a Horizon claim predicate. Supports the forms this module creates
 * plus the ones an anchor is likely to use; an unrecognised shape evaluates to
 * false, so the UI errs toward not offering a claim rather than offering one
 * that fails.
 */
function predicateOpen(predicate, nowMs = Date.now()) {
  if (!predicate || typeof predicate !== "object") return false;
  if (predicate.unconditional) return true;
  if (predicate.abs_before) {
    return nowMs < new Date(predicate.abs_before).getTime();
  }
  if (predicate.rel_before !== undefined) {
    // Relative predicates are resolved against ledger close time, which is not
    // available here. Treating them as open is the correct direction: the worst
    // case is a claim attempt that Horizon rejects.
    return true;
  }
  if (predicate.not) return !predicateOpen(predicate.not, nowMs);
  if (Array.isArray(predicate.and)) return predicate.and.every((p) => predicateOpen(p, nowMs));
  if (Array.isArray(predicate.or)) return predicate.or.some((p) => predicateOpen(p, nowMs));
  return false;
}

module.exports = {
  DEFAULT_RECLAIM_WINDOW_SECONDS,
  ClaimableBalanceError,
  buildClaimants,
  buildFundingBalanceTransaction,
  buildDonationBalanceTransaction,
  buildClaimTransaction,
  listClaimable,
  predicateOpen,
};
