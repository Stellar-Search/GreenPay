/**
 * src/services/onboarding/sponsorshipPolicy.test.js
 *
 * The limits are the difference between a donation rail and a free-XLM
 * faucet with a climate logo on it, so each one is tested at its boundary.
 */
"use strict";

const {
  DEFAULT_LIMITS,
  DENIAL_CODES,
  resolveLimits,
  assessRequest,
  assessSponsoredDonation,
  monitoringSignals,
} = require("./sponsorshipPolicy");
const { xlmStringToStroops } = require("./reserveAccounting");

const XLM = (n) => xlmStringToStroops(String(n));

const CLEAR_USAGE = {
  perSession: 0,
  perIpDaily: 0,
  globalDaily: 0,
  globalHourly: 0,
  activeSponsorships: 0,
};

const OPEN_REQUEST = { enabled: true, accountExists: false };

describe("resolveLimits", () => {
  it("falls back to the conservative defaults when nothing is configured", () => {
    expect(resolveLimits()).toEqual(DEFAULT_LIMITS);
  });

  it("ignores unset overrides rather than coercing them to zero", () => {
    // An unset env var arriving as "" must not silently become a limit of 0,
    // which would refuse every request and look like an outage.
    const limits = resolveLimits({ perIpDaily: "", globalDaily: null, globalHourly: undefined });
    expect(limits.perIpDaily).toBe(DEFAULT_LIMITS.perIpDaily);
    expect(limits.globalDaily).toBe(DEFAULT_LIMITS.globalDaily);
  });

  it("accepts a numeric override", () => {
    expect(resolveLimits({ perIpDaily: 7 }).perIpDaily).toBe(7);
  });

  it("refuses a negative limit", () => {
    expect(() => resolveLimits({ perIpDaily: -1 })).toThrow(RangeError);
  });
});

describe("assessRequest", () => {
  it("allows a clean first request", () => {
    const decision = assessRequest(OPEN_REQUEST, CLEAR_USAGE);
    expect(decision.allowed).toBe(true);
    expect(decision.cost.totalXlm).toBe("1.0000000");
  });

  it("refuses when the deployment configured no sponsor", () => {
    const decision = assessRequest({ enabled: false, accountExists: false }, CLEAR_USAGE);
    expect(decision.code).toBe(DENIAL_CODES.DISABLED);
  });

  it("refuses to sponsor an account that already exists", () => {
    // Sponsoring an existing account would lock reserve for nothing.
    const decision = assessRequest({ enabled: true, accountExists: true }, CLEAR_USAGE);
    expect(decision.code).toBe(DENIAL_CODES.ACCOUNT_EXISTS);
    expect(decision.message).toMatch(/already exists/i);
  });

  it("refuses a second sponsorship for the same address", () => {
    const decision = assessRequest({ ...OPEN_REQUEST, alreadySponsored: true }, CLEAR_USAGE);
    expect(decision.code).toBe(DENIAL_CODES.ALREADY_SPONSORED);
  });

  it("allows the last request under the per-IP cap and refuses the next", () => {
    const atLimit = { ...CLEAR_USAGE, perIpDaily: DEFAULT_LIMITS.perIpDaily - 1 };
    expect(assessRequest(OPEN_REQUEST, atLimit).allowed).toBe(true);

    const overLimit = { ...CLEAR_USAGE, perIpDaily: DEFAULT_LIMITS.perIpDaily };
    expect(assessRequest(OPEN_REQUEST, overLimit).code).toBe(DENIAL_CODES.IP_LIMIT);
  });

  it("gives one sponsored account per session", () => {
    const decision = assessRequest(OPEN_REQUEST, { ...CLEAR_USAGE, perSession: 1 });
    expect(decision.code).toBe(DENIAL_CODES.SESSION_LIMIT);
  });

  it("contains a burst on the hourly cap before the daily cap notices", () => {
    const decision = assessRequest(OPEN_REQUEST, {
      ...CLEAR_USAGE,
      globalHourly: DEFAULT_LIMITS.globalHourly,
      globalDaily: 100,
    });
    expect(decision.code).toBe(DENIAL_CODES.GLOBAL_HOURLY_LIMIT);
  });

  it("refuses on the global daily cap", () => {
    const decision = assessRequest(OPEN_REQUEST, {
      ...CLEAR_USAGE,
      globalDaily: DEFAULT_LIMITS.globalDaily,
    });
    expect(decision.code).toBe(DENIAL_CODES.GLOBAL_DAILY_LIMIT);
  });

  it("tells a caller about their own behaviour before it mentions the treasury", () => {
    // A donor over their own limit should not be told the platform is broke.
    const decision = assessRequest(OPEN_REQUEST, {
      ...CLEAR_USAGE,
      perIpDaily: 99,
      treasuryBalanceStroops: 0n,
    });
    expect(decision.code).toBe(DENIAL_CODES.IP_LIMIT);
  });

  it("stops sponsoring while the treasury is inside its floor", () => {
    // 21 XLM of lockable balance against a 20-account floor leaves room for
    // one more; a floor breach must refuse rather than dip into the reserve
    // that pays for revocation.
    const decision = assessRequest(OPEN_REQUEST, {
      ...CLEAR_USAGE,
      treasuryBalanceStroops: XLM(15),
    });
    expect(decision.code).toBe(DENIAL_CODES.TREASURY_EXHAUSTED);
  });

  it("allows a request when the treasury is comfortably above the floor", () => {
    const decision = assessRequest(OPEN_REQUEST, {
      ...CLEAR_USAGE,
      treasuryBalanceStroops: XLM(500),
    });
    expect(decision.allowed).toBe(true);
  });

  it("skips the treasury check when the balance is unknown rather than guessing", () => {
    const decision = assessRequest(OPEN_REQUEST, { ...CLEAR_USAGE, treasuryBalanceStroops: null });
    expect(decision.allowed).toBe(true);
  });

  it("costs a trustline sponsorship higher and consumes treasury faster", () => {
    const plain = assessRequest(OPEN_REQUEST, { ...CLEAR_USAGE, treasuryBalanceStroops: XLM(500) });
    const withTrustline = assessRequest(
      { ...OPEN_REQUEST, trustline: true },
      { ...CLEAR_USAGE, treasuryBalanceStroops: XLM(500) },
    );
    expect(withTrustline.cost.totalStroops).toBeGreaterThan(plain.cost.totalStroops);
  });
});

describe("assessSponsoredDonation — the laundering control", () => {
  it("allows a normal donation to a verified project", () => {
    const decision = assessSponsoredDonation({ amountXlm: 25, destinationVerified: true });
    expect(decision.allowed).toBe(true);
  });

  it("refuses any donation to an unverified destination, whatever the amount", () => {
    // Destination, not identity, is the control that actually holds for an
    // anonymous donor: value that can only reach a verified climate project
    // is not a laundering channel.
    const decision = assessSponsoredDonation({ amountXlm: 1, destinationVerified: false });
    expect(decision.code).toBe(DENIAL_CODES.DESTINATION_NOT_VERIFIED);
  });

  it("allows exactly the per-donation cap and refuses one above it", () => {
    const cap = DEFAULT_LIMITS.maxSponsoredDonationXlm;
    expect(assessSponsoredDonation({ amountXlm: cap, destinationVerified: true }).allowed).toBe(true);
    expect(assessSponsoredDonation({ amountXlm: cap + 1, destinationVerified: true }).code).toBe(
      DENIAL_CODES.AMOUNT_ABOVE_CAP,
    );
  });

  it("refuses once the lifetime cap would be crossed", () => {
    const decision = assessSponsoredDonation({
      amountXlm: 100,
      lifetimeXlm: DEFAULT_LIMITS.maxSponsoredLifetimeXlm - 50,
      destinationVerified: true,
    });
    expect(decision.code).toBe(DENIAL_CODES.LIFETIME_ABOVE_CAP);
    expect(decision.message).toMatch(/wallet you fund yourself/i);
  });

  it("allows a donation that lands exactly on the lifetime cap", () => {
    const decision = assessSponsoredDonation({
      amountXlm: 50,
      lifetimeXlm: DEFAULT_LIMITS.maxSponsoredLifetimeXlm - 50,
      destinationVerified: true,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.remainingLifetimeXlm).toBe(0);
  });

  it("refuses a zero or negative amount", () => {
    expect(assessSponsoredDonation({ amountXlm: 0, destinationVerified: true }).allowed).toBe(false);
    expect(assessSponsoredDonation({ amountXlm: -5, destinationVerified: true }).allowed).toBe(false);
  });
});

describe("monitoringSignals", () => {
  it("stays quiet on a healthy window", () => {
    expect(
      monitoringSignals({
        sponsoredCreated: 100,
        sponsoredDonated: 80,
        distinctIps: 90,
        treasuryRemainingAccounts: 400,
      }),
    ).toEqual([]);
  });

  it("flags reserve being locked without donations arriving", () => {
    const signals = monitoringSignals({ sponsoredCreated: 100, sponsoredDonated: 5, distinctIps: 100 });
    expect(signals.map((s) => s.code)).toContain("LOW_SPONSORSHIP_CONVERSION");
  });

  it("flags a handful of sources accounting for most sponsorships", () => {
    const signals = monitoringSignals({ sponsoredCreated: 100, sponsoredDonated: 90, distinctIps: 3 });
    expect(signals.map((s) => s.code)).toContain("SPONSORSHIP_IP_CONCENTRATION");
  });

  it("escalates the treasury warning to critical as the floor approaches", () => {
    const warning = monitoringSignals({ treasuryRemainingAccounts: 40 });
    const critical = monitoringSignals({ treasuryRemainingAccounts: 5 });
    expect(warning[0].severity).toBe("warning");
    expect(critical[0].severity).toBe("critical");
  });

  it("treats failing reclaims as critical, because locked reserve is not coming back", () => {
    const signals = monitoringSignals({ reclaimFailures: 3 });
    expect(signals[0]).toMatchObject({ code: "RECLAIM_FAILING", severity: "critical" });
  });

  it("does not cry wolf on a tiny sample", () => {
    // Two accounts and no donations is a Tuesday, not an attack.
    expect(monitoringSignals({ sponsoredCreated: 2, sponsoredDonated: 0, distinctIps: 2 })).toEqual([]);
  });
});
