/**
 * src/services/onboarding/reserveAccounting.js
 *
 * The sponsorship economics, modelled before any UI depends on them.
 *
 * Stellar will not let an account exist below its minimum balance. That
 * minimum is `(2 + numSubEntries + numSponsoring - numSponsored) * baseReserve`
 * and it is the reason a first-time donor cannot donate: the account they would
 * donate *from* cannot be created until somebody puts XLM behind it.
 *
 * Sponsored reserves move that requirement onto the platform without moving
 * custody: `beginSponsoringFutureReserves` makes the sponsor's account carry
 * the ledger entry's reserve while the sponsored account owns the entry and
 * holds its own signing key. The sponsor's XLM is *locked*, not spent — it
 * comes back when the sponsorship is revoked or the entry is removed.
 *
 * "Locked, not spent" is the whole viability question, so it is modelled here
 * as explicit numbers rather than assumed: how much a single donor costs, how
 * many the treasury can carry at once, and what fraction of that is
 * recoverable. Every consumer (policy, routes, UI, docs) reads these numbers
 * from this module — there is no second copy of the arithmetic.
 *
 * All amounts in this module are integer **stroops** (1 XLM = 10,000,000
 * stroops). Floating-point XLM is never used for reserve arithmetic: a reserve
 * decision that is off by a rounding error is a decision that strands funds.
 */
"use strict";

/** 1 XLM expressed in stroops. */
const STROOPS_PER_XLM = 10_000_000n;

/**
 * The network's base reserve. 0.5 XLM on both testnet and mainnet today, and
 * changeable only by validator vote — which is exactly why it is a parameter
 * here and not a literal sprinkled through the codebase. A vote that doubled
 * it would otherwise silently double the platform's locked capital while every
 * quote in the UI kept claiming the old number.
 */
const DEFAULT_BASE_RESERVE_STROOPS = 5_000_000n; // 0.5 XLM

/**
 * Every account carries two base reserves before it owns anything at all.
 */
const BASE_ENTRIES_PER_ACCOUNT = 2n;

/**
 * A trustline is one additional subentry, so one additional base reserve. A
 * donor giving in USDC needs one; a donor giving in XLM does not.
 */
const ENTRIES_PER_TRUSTLINE = 1n;

/**
 * A claimable balance costs its *sponsor* two base reserves for as long as it
 * is unclaimed. Claiming it returns them.
 */
const ENTRIES_PER_CLAIMABLE_BALANCE = 2n;

/**
 * Stellar's per-operation base fee floor. Fees are genuinely spent, never
 * returned, so they are tracked separately from reserves throughout.
 */
const BASE_FEE_STROOPS = 100n;

function toBigInt(value, label) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new TypeError(`${label} must be an integer number of stroops, got ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  throw new TypeError(`${label} must be an integer, bigint, or integer string`);
}

/** Formats stroops as a fixed 7-decimal XLM string, without floating point. */
function stroopsToXlmString(stroops) {
  const value = toBigInt(stroops, "stroops");
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / STROOPS_PER_XLM;
  const fraction = (abs % STROOPS_PER_XLM).toString().padStart(7, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** Parses a decimal XLM string into integer stroops (truncating past 7dp). */
function xlmStringToStroops(xlm) {
  const text = String(xlm).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new TypeError(`Not a decimal XLM amount: "${xlm}"`);
  }
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = (negative ? text.slice(1) : text).split(".");
  const stroops = BigInt(whole) * STROOPS_PER_XLM + BigInt(fraction.slice(0, 7).padEnd(7, "0"));
  return negative ? -stroops : stroops;
}

/**
 * The reserve a sponsor locks to bring one donor onto the network.
 *
 * @param {object} [options]
 * @param {boolean} [options.trustline=false] Donor will give in a non-native
 *   asset and therefore needs a trustline subentry.
 * @param {number}  [options.claimableBalances=0] Claimable balances the sponsor
 *   also carries for this donor (the on-ramp path creates one).
 * @param {bigint|number|string} [options.baseReserveStroops]
 * @returns {{
 *   accountStroops: bigint,
 *   trustlineStroops: bigint,
 *   claimableBalanceStroops: bigint,
 *   totalStroops: bigint,
 *   totalXlm: string,
 *   recoverableStroops: bigint,
 *   entries: bigint
 * }}
 */
function sponsorshipCost({
  trustline = false,
  claimableBalances = 0,
  baseReserveStroops = DEFAULT_BASE_RESERVE_STROOPS,
} = {}) {
  const baseReserve = toBigInt(baseReserveStroops, "baseReserveStroops");
  if (baseReserve <= 0n) throw new RangeError("baseReserveStroops must be positive");
  const balances = toBigInt(claimableBalances, "claimableBalances");
  if (balances < 0n) throw new RangeError("claimableBalances cannot be negative");

  const accountEntries = BASE_ENTRIES_PER_ACCOUNT;
  const trustlineEntries = trustline ? ENTRIES_PER_TRUSTLINE : 0n;
  const balanceEntries = balances * ENTRIES_PER_CLAIMABLE_BALANCE;
  const entries = accountEntries + trustlineEntries + balanceEntries;

  const accountStroops = accountEntries * baseReserve;
  const trustlineStroops = trustlineEntries * baseReserve;
  const claimableBalanceStroops = balanceEntries * baseReserve;
  const totalStroops = accountStroops + trustlineStroops + claimableBalanceStroops;

  return {
    entries,
    accountStroops,
    trustlineStroops,
    claimableBalanceStroops,
    totalStroops,
    totalXlm: stroopsToXlmString(totalStroops),
    // Reserves are locked, not spent. Every stroop above comes back on
    // revocation or entry removal — the recovery path in sponsoredAccounts.js.
    // Fees are the only unrecoverable part and are counted by sponsorshipFees().
    recoverableStroops: totalStroops,
  };
}

/**
 * Network fees the sponsor genuinely spends per sponsored donor. Unlike
 * reserves these never come back, so they are the true marginal cost.
 *
 * Two transactions are paid for by the sponsor across an account's life: the
 * three-operation creation transaction, and the one-operation revocation that
 * reclaims the reserve.
 */
function sponsorshipFees({ baseFeeStroops = BASE_FEE_STROOPS, feeMultiplier = 1 } = {}) {
  const baseFee = toBigInt(baseFeeStroops, "baseFeeStroops");
  const multiplier = toBigInt(feeMultiplier, "feeMultiplier");
  if (multiplier < 1n) throw new RangeError("feeMultiplier must be at least 1");

  const creationOps = 3n; // begin / createAccount / end
  const reclaimOps = 1n; // revokeAccountSponsorship
  const totalStroops = (creationOps + reclaimOps) * baseFee * multiplier;

  return {
    creationStroops: creationOps * baseFee * multiplier,
    reclaimStroops: reclaimOps * baseFee * multiplier,
    totalStroops,
    totalXlm: stroopsToXlmString(totalStroops),
  };
}

/**
 * How many concurrent sponsorships a treasury of a given size can carry.
 *
 * The treasury must keep its own minimum balance *and* an operating buffer
 * on top; only what is left over can be locked behind donors. Getting this
 * wrong does not merely stop new sponsorships — it wedges the treasury below
 * its own minimum, at which point it cannot even pay the fee to revoke the
 * sponsorships that would free the funds.
 *
 * @returns {{
 *   perAccountStroops: bigint,
 *   lockableStroops: bigint,
 *   capacity: number,
 *   treasuryMinimumStroops: bigint,
 *   exhausted: boolean
 * }}
 */
function treasuryCapacity({
  treasuryBalanceStroops,
  bufferStroops = 0,
  activeSponsorships = 0,
  baseReserveStroops = DEFAULT_BASE_RESERVE_STROOPS,
  trustline = false,
} = {}) {
  const balance = toBigInt(treasuryBalanceStroops, "treasuryBalanceStroops");
  const buffer = toBigInt(bufferStroops, "bufferStroops");
  const active = toBigInt(activeSponsorships, "activeSponsorships");
  const baseReserve = toBigInt(baseReserveStroops, "baseReserveStroops");

  const perAccount = sponsorshipCost({ trustline, baseReserveStroops: baseReserve }).totalStroops;

  // The treasury's own floor: two base reserves for itself, plus the reserve
  // for every entry it is already sponsoring (numSponsoring raises the
  // sponsor's own minimum balance by exactly what the sponsored entries cost).
  const treasuryMinimum = BASE_ENTRIES_PER_ACCOUNT * baseReserve + active * perAccount;

  const lockable = balance - treasuryMinimum - buffer;
  if (lockable <= 0n) {
    return {
      perAccountStroops: perAccount,
      lockableStroops: 0n,
      capacity: 0,
      treasuryMinimumStroops: treasuryMinimum,
      exhausted: true,
    };
  }

  const capacity = lockable / perAccount;
  return {
    perAccountStroops: perAccount,
    lockableStroops: lockable,
    capacity: Number(capacity),
    treasuryMinimumStroops: treasuryMinimum,
    exhausted: capacity === 0n,
  };
}

/**
 * The base-reserve boundary for an account that already exists: can it send
 * `amountStroops` and still satisfy its own minimum balance?
 *
 * This is the check the donation flow needs. A donor with 1.6 XLM and a
 * trustline "has enough" by naive arithmetic and will still have their payment
 * rejected with `tx_insufficient_balance`, because 1.5 XLM of that is locked.
 *
 * `numSponsored` is subtracted from the entry count: an account whose entries
 * someone else sponsors carries no reserve for them, which is precisely what
 * makes a sponsored donor able to spend their whole balance.
 *
 * @returns {{
 *   minimumBalanceStroops: bigint,
 *   spendableStroops: bigint,
 *   sufficient: boolean,
 *   shortfallStroops: bigint
 * }}
 */
function accountSpendCheck({
  balanceStroops,
  amountStroops = 0,
  numSubEntries = 0,
  numSponsoring = 0,
  numSponsored = 0,
  feeStroops = BASE_FEE_STROOPS,
  baseReserveStroops = DEFAULT_BASE_RESERVE_STROOPS,
} = {}) {
  const balance = toBigInt(balanceStroops, "balanceStroops");
  const amount = toBigInt(amountStroops, "amountStroops");
  const subEntries = toBigInt(numSubEntries, "numSubEntries");
  const sponsoring = toBigInt(numSponsoring, "numSponsoring");
  const sponsored = toBigInt(numSponsored, "numSponsored");
  const fee = toBigInt(feeStroops, "feeStroops");
  const baseReserve = toBigInt(baseReserveStroops, "baseReserveStroops");

  // The protocol's own formula. numSponsored subtracts, which is the point of
  // sponsorship: an account whose two base entries are both sponsored has a
  // minimum balance of zero and can spend down to nothing. The clamp at zero
  // only guards against a malformed input, never a real Horizon account.
  const entries = BASE_ENTRIES_PER_ACCOUNT + subEntries + sponsoring - sponsored;
  const minimumBalance = (entries < 0n ? 0n : entries) * baseReserve;

  const spendable = balance - minimumBalance - fee;
  const usable = spendable < 0n ? 0n : spendable;
  const sufficient = amount > 0n ? usable >= amount : usable > 0n;

  return {
    minimumBalanceStroops: minimumBalance,
    spendableStroops: usable,
    sufficient,
    shortfallStroops: sufficient ? 0n : amount - usable,
  };
}

/**
 * Reads Horizon's account representation into the shape accountSpendCheck
 * wants. Kept here so the Horizon field names are decoded in exactly one place.
 */
function fromHorizonAccount(account) {
  const native = (account.balances || []).find((b) => b.asset_type === "native");
  return {
    balanceStroops: xlmStringToStroops(native ? native.balance : "0"),
    numSubEntries: BigInt(account.subentry_count ?? 0),
    numSponsoring: BigInt(account.num_sponsoring ?? 0),
    numSponsored: BigInt(account.num_sponsored ?? 0),
  };
}

/**
 * Converts a `sponsorshipCost` result into a shape that survives JSON.
 *
 * The cost model works in BigInt because a reserve decision that is off by a
 * rounding error is a decision that strands funds. BigInt does not serialize —
 * `JSON.stringify` throws "Do not know how to serialize a BigInt" — so anything
 * crossing the HTTP boundary must pass through here first. Doing the conversion
 * in one named function, rather than at each route, is what stops the next
 * endpoint reintroducing the same 500.
 */
function serializeCost(cost) {
  return {
    entries: Number(cost.entries),
    accountXlm: stroopsToXlmString(cost.accountStroops),
    trustlineXlm: stroopsToXlmString(cost.trustlineStroops),
    claimableBalanceXlm: stroopsToXlmString(cost.claimableBalanceStroops),
    totalXlm: cost.totalXlm,
    totalStroops: cost.totalStroops.toString(),
    recoverableStroops: cost.recoverableStroops.toString(),
  };
}

/**
 * A donor-facing summary of one sponsorship: what it costs the platform, what
 * comes back, and what the donor is accepting. The UI renders this verbatim
 * rather than paraphrasing it, so the disclosure and the arithmetic cannot
 * drift apart.
 */
function sponsorshipQuote({ trustline = false, claimableBalances = 0, baseReserveStroops } = {}) {
  const cost = sponsorshipCost({ trustline, claimableBalances, baseReserveStroops });
  const fees = sponsorshipFees();
  return {
    lockedXlm: cost.totalXlm,
    lockedStroops: cost.totalStroops.toString(),
    entries: Number(cost.entries),
    unrecoverableFeeXlm: fees.totalXlm,
    recoverable: true,
    // Plain-language, donor-facing. Deliberately states the constraint before
    // the benefit: a donor who is surprised later is worse than one who
    // declines now.
    disclosure: [
      `GreenPay locks ${cost.totalXlm} XLM of its own funds to create your account. It is a reserve, not a gift — the platform gets it back when the sponsorship ends.`,
      "You hold your own key. GreenPay cannot sign for you, spend your balance, or recover your key if you lose it.",
      "While GreenPay sponsors your account you can spend your whole balance; if the sponsorship is later handed back to you, you will need to keep 1 XLM in the account yourself.",
    ],
  };
}

module.exports = {
  STROOPS_PER_XLM,
  DEFAULT_BASE_RESERVE_STROOPS,
  BASE_ENTRIES_PER_ACCOUNT,
  ENTRIES_PER_TRUSTLINE,
  ENTRIES_PER_CLAIMABLE_BALANCE,
  BASE_FEE_STROOPS,
  stroopsToXlmString,
  xlmStringToStroops,
  sponsorshipCost,
  serializeCost,
  sponsorshipFees,
  treasuryCapacity,
  accountSpendCheck,
  fromHorizonAccount,
  sponsorshipQuote,
};
