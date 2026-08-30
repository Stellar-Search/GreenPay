/**
 * src/services/onboarding/sponsorshipPolicy.js
 *
 * Who is allowed a sponsored account, and what stops the treasury being
 * drained by someone who is not a donor.
 *
 * Sponsored account creation gives away a scarce, real resource — locked XLM —
 * to an anonymous caller. That is an abuse surface whether or not anyone
 * abuses it, so the limits are part of the feature rather than something bolted
 * on after the first incident. Two distinct threats are in scope:
 *
 *   1. Reserve exhaustion. Someone requests thousands of accounts, the
 *      treasury's lockable balance hits zero, and *legitimate* first-time
 *      donors stop being able to donate. The attacker gains nothing directly —
 *      they cannot spend the locked reserve, only immobilise it — which makes
 *      this cheap griefing rather than theft, and it is the likelier attack.
 *
 *   2. Laundering. A sponsored account is an account the platform helped bring
 *      into existence. If it can then move arbitrary value to an arbitrary
 *      address, the platform has built a funding rail with its own name on it.
 *      The controls below are what keep it a *donation* rail: value can only
 *      leave toward a verified project, amounts are capped, and every
 *      sponsorship is attributable to the funnel session that requested it.
 *
 * Decisions are pure functions of (limits, usage) so they can be tested
 * exhaustively and reasoned about without a database. `assessRequest` never
 * reads or writes anything; the caller supplies the usage snapshot.
 */
"use strict";

const { sponsorshipCost, treasuryCapacity } = require("./reserveAccounting");

/**
 * Default limits. Deliberately conservative: the cost of a limit that is too
 * tight is a donor who sees "try again tomorrow"; the cost of one that is too
 * loose is a treasury that cannot serve anybody. Every value is overridable
 * per-deployment through the env schema.
 */
const DEFAULT_LIMITS = Object.freeze({
  /** Sponsored accounts one IP may request per rolling day. */
  perIpDaily: 3,
  /** Sponsored accounts one browser-held onboarding session may request. */
  perSessionTotal: 1,
  /** Platform-wide sponsored accounts per rolling day. */
  globalDaily: 500,
  /** Platform-wide sponsored accounts per rolling hour — burst containment. */
  globalHourly: 60,
  /**
   * Stop sponsoring while fewer than this many sponsorships' worth of
   * lockable balance remains, so the treasury never reaches the state where it
   * cannot afford the fee to revoke and reclaim.
   */
  treasuryFloorAccounts: 20,
  /**
   * The largest donation a sponsored account may make before the donor must
   * bring their own funded wallet. Caps how much value can pass through the
   * rail the platform created, which is the laundering control that does not
   * depend on identifying anyone.
   */
  maxSponsoredDonationXlm: 250,
  /**
   * Total value one sponsored account may move through the platform before it
   * must be upgraded to a self-funded wallet.
   */
  maxSponsoredLifetimeXlm: 1000,
  /**
   * A sponsored account that never donates is pure cost. After this many days
   * the reclaim job revokes the sponsorship and takes the reserve back.
   */
  reclaimIdleAfterDays: 30,
});

/** Every reason a sponsorship request can be refused, as stable codes. */
const DENIAL_CODES = Object.freeze({
  IP_LIMIT: "SPONSORSHIP_IP_LIMIT",
  SESSION_LIMIT: "SPONSORSHIP_SESSION_LIMIT",
  GLOBAL_DAILY_LIMIT: "SPONSORSHIP_GLOBAL_DAILY_LIMIT",
  GLOBAL_HOURLY_LIMIT: "SPONSORSHIP_GLOBAL_HOURLY_LIMIT",
  TREASURY_EXHAUSTED: "SPONSORSHIP_TREASURY_EXHAUSTED",
  DISABLED: "SPONSORSHIP_DISABLED",
  ACCOUNT_EXISTS: "SPONSORSHIP_ACCOUNT_EXISTS",
  ALREADY_SPONSORED: "SPONSORSHIP_ALREADY_SPONSORED",
  AMOUNT_ABOVE_CAP: "SPONSORSHIP_AMOUNT_ABOVE_CAP",
  LIFETIME_ABOVE_CAP: "SPONSORSHIP_LIFETIME_ABOVE_CAP",
  DESTINATION_NOT_VERIFIED: "SPONSORSHIP_DESTINATION_NOT_VERIFIED",
});

/** Human-readable copy for each denial, shown to the donor as-is. */
const DENIAL_MESSAGES = Object.freeze({
  [DENIAL_CODES.IP_LIMIT]:
    "This network has already set up the maximum number of new accounts today. You can still donate with an existing Stellar wallet.",
  [DENIAL_CODES.SESSION_LIMIT]:
    "This browser has already been given a sponsored account. Use that account, or connect an existing wallet.",
  [DENIAL_CODES.GLOBAL_DAILY_LIMIT]:
    "GreenPay has reached its daily limit for sponsoring new accounts. Please try again tomorrow, or donate with an existing wallet.",
  [DENIAL_CODES.GLOBAL_HOURLY_LIMIT]:
    "GreenPay is sponsoring new accounts faster than usual right now. Please try again shortly.",
  [DENIAL_CODES.TREASURY_EXHAUSTED]:
    "GreenPay cannot sponsor new accounts at the moment. Donations from existing wallets are unaffected.",
  [DENIAL_CODES.DISABLED]:
    "Sponsored account creation is not enabled on this deployment.",
  [DENIAL_CODES.ACCOUNT_EXISTS]:
    "This Stellar account already exists on the network — you can donate from it directly.",
  [DENIAL_CODES.ALREADY_SPONSORED]:
    "GreenPay already sponsors this account.",
  [DENIAL_CODES.AMOUNT_ABOVE_CAP]:
    "This donation is above the limit for a sponsored account. Connect a funded wallet to give more.",
  [DENIAL_CODES.LIFETIME_ABOVE_CAP]:
    "This sponsored account has reached its lifetime limit. Move to a wallet you fund yourself to keep giving.",
  [DENIAL_CODES.DESTINATION_NOT_VERIFIED]:
    "A sponsored account can only send to a verified GreenPay project.",
});

function resolveLimits(overrides = {}) {
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const value = overrides[key];
    if (value === undefined || value === null || value === "") continue;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw new RangeError(`sponsorship limit "${key}" must be a non-negative number`);
    }
    limits[key] = numeric;
  }
  return Object.freeze(limits);
}

function deny(code, details) {
  return {
    allowed: false,
    code,
    message: DENIAL_MESSAGES[code] || "Sponsorship refused.",
    details: details || undefined,
  };
}

/**
 * Decide whether one sponsorship request may proceed.
 *
 * @param {object} request
 * @param {boolean} request.enabled Whether the deployment configured a sponsor.
 * @param {boolean} request.accountExists Whether the donor's address already
 *   resolves on-chain (in which case they need no sponsorship at all).
 * @param {boolean} [request.alreadySponsored]
 * @param {boolean} [request.trustline]
 * @param {object} usage Counter snapshot from sponsorshipUsage().
 * @param {object} [limitOverrides]
 * @returns {{allowed: boolean, code?: string, message?: string, cost?: object}}
 */
function assessRequest(request, usage, limitOverrides) {
  const limits = resolveLimits(limitOverrides);

  if (!request.enabled) return deny(DENIAL_CODES.DISABLED);
  if (request.accountExists) return deny(DENIAL_CODES.ACCOUNT_EXISTS);
  if (request.alreadySponsored) return deny(DENIAL_CODES.ALREADY_SPONSORED);

  if (usage.perSession >= limits.perSessionTotal) {
    return deny(DENIAL_CODES.SESSION_LIMIT, { limit: limits.perSessionTotal });
  }
  if (usage.perIpDaily >= limits.perIpDaily) {
    return deny(DENIAL_CODES.IP_LIMIT, { limit: limits.perIpDaily, windowHours: 24 });
  }
  if (usage.globalHourly >= limits.globalHourly) {
    return deny(DENIAL_CODES.GLOBAL_HOURLY_LIMIT, { limit: limits.globalHourly, windowHours: 1 });
  }
  if (usage.globalDaily >= limits.globalDaily) {
    return deny(DENIAL_CODES.GLOBAL_DAILY_LIMIT, { limit: limits.globalDaily, windowHours: 24 });
  }

  // Treasury check last: it is the most expensive to compute and the least
  // likely to trip, and a caller already over a counter limit should be told
  // about their own behaviour rather than the platform's balance.
  if (usage.treasuryBalanceStroops !== undefined && usage.treasuryBalanceStroops !== null) {
    const perAccount = sponsorshipCost({ trustline: Boolean(request.trustline) }).totalStroops;
    const capacity = treasuryCapacity({
      treasuryBalanceStroops: usage.treasuryBalanceStroops,
      activeSponsorships: usage.activeSponsorships || 0,
      trustline: Boolean(request.trustline),
      bufferStroops: BigInt(Math.trunc(limits.treasuryFloorAccounts)) * perAccount,
    });
    if (capacity.capacity < 1) {
      return deny(DENIAL_CODES.TREASURY_EXHAUSTED, {
        remainingAccounts: capacity.capacity,
      });
    }
  }

  return {
    allowed: true,
    limits,
    cost: sponsorshipCost({ trustline: Boolean(request.trustline) }),
  };
}

/**
 * Decide whether a *donation* from an already-sponsored account may proceed.
 *
 * This is the laundering control, and it is deliberately strict about
 * destination rather than about identity. The platform cannot know who a
 * pseudonymous donor is, and pretending otherwise would be theatre. What it
 * can know for certain is where the money goes: a sponsored account may only
 * pay a verified project wallet, and only up to a cap. Value that can only
 * ever reach a verified climate project is not a laundering channel, however
 * anonymous its source.
 */
function assessSponsoredDonation({ amountXlm, lifetimeXlm = 0, destinationVerified }, limitOverrides) {
  const limits = resolveLimits(limitOverrides);
  const amount = Number(amountXlm);

  if (!destinationVerified) return deny(DENIAL_CODES.DESTINATION_NOT_VERIFIED);
  if (!Number.isFinite(amount) || amount <= 0) {
    return deny(DENIAL_CODES.AMOUNT_ABOVE_CAP, { limit: limits.maxSponsoredDonationXlm });
  }
  if (amount > limits.maxSponsoredDonationXlm) {
    return deny(DENIAL_CODES.AMOUNT_ABOVE_CAP, { limit: limits.maxSponsoredDonationXlm });
  }
  if (Number(lifetimeXlm) + amount > limits.maxSponsoredLifetimeXlm) {
    return deny(DENIAL_CODES.LIFETIME_ABOVE_CAP, {
      limit: limits.maxSponsoredLifetimeXlm,
      used: Number(lifetimeXlm),
    });
  }

  return { allowed: true, limits, remainingLifetimeXlm: limits.maxSponsoredLifetimeXlm - Number(lifetimeXlm) - amount };
}

/**
 * Signals worth alerting on. None of these is proof of abuse on its own —
 * they are the shapes that distinguish an attack from a good week, so that a
 * spike is investigated rather than celebrated.
 */
function monitoringSignals(window) {
  const signals = [];
  const created = Number(window.sponsoredCreated || 0);
  const donated = Number(window.sponsoredDonated || 0);
  const distinctIps = Number(window.distinctIps || 0);

  if (created >= 10 && donated / Math.max(created, 1) < 0.2) {
    signals.push({
      code: "LOW_SPONSORSHIP_CONVERSION",
      severity: "warning",
      detail:
        "Fewer than one in five sponsored accounts went on to donate. Reserve is being locked without donations arriving — the likeliest cause is automated requests.",
      value: donated / Math.max(created, 1),
    });
  }
  if (created >= 10 && distinctIps > 0 && created / distinctIps > 5) {
    signals.push({
      code: "SPONSORSHIP_IP_CONCENTRATION",
      severity: "warning",
      detail: "A small number of source addresses account for most sponsorships.",
      value: created / distinctIps,
    });
  }
  if (window.treasuryRemainingAccounts !== undefined && Number(window.treasuryRemainingAccounts) < 50) {
    signals.push({
      code: "TREASURY_LOW",
      severity: Number(window.treasuryRemainingAccounts) < 20 ? "critical" : "warning",
      detail: "Treasury lockable balance is approaching the floor; sponsorship will start refusing.",
      value: Number(window.treasuryRemainingAccounts),
    });
  }
  if (Number(window.reclaimFailures || 0) > 0) {
    signals.push({
      code: "RECLAIM_FAILING",
      severity: "critical",
      detail: "Sponsorship revocation is failing — locked reserve is not returning to the treasury.",
      value: Number(window.reclaimFailures),
    });
  }
  return signals;
}

module.exports = {
  DEFAULT_LIMITS,
  DENIAL_CODES,
  DENIAL_MESSAGES,
  resolveLimits,
  assessRequest,
  assessSponsoredDonation,
  monitoringSignals,
};
