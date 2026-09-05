/**
 * src/services/onboarding/onramp.js
 *
 * Fiat on-ramp handoff, and an explicit split of who owes which compliance
 * obligation.
 *
 * ── The decision this file encodes ──────────────────────────────────────────
 * GreenPay does not take fiat. Every path here hands the donor to a licensed
 * anchor over SEP-24 (interactive deposit): the donor authenticates to the
 * anchor with SEP-10, the anchor collects the money, performs its own KYC, and
 * delivers XLM to the donor's Stellar address. GreenPay's involvement is
 * limited to knowing *which* anchor and *when the asset arrived*.
 *
 * That boundary is not a technical convenience — it is the reason the platform
 * can offer a fiat path at all. Taking card payments would make GreenPay a
 * money services business in most jurisdictions it operates in, with
 * registration, sanctions screening, transaction monitoring, suspicious
 * activity reporting and record-retention duties attached. Delegating to an
 * anchor that already holds those licences moves the obligation to the party
 * that is regulated for it.
 *
 * ── Why the matrix is code and not a wiki page ──────────────────────────────
 * "Which obligations sit with the provider and which with us" is the kind of
 * answer that is written once, believed for two years, and turns out to be
 * wrong at the worst moment. Encoding it means the split for each provider is
 * versioned, reviewable in a diff, asserted by tests, and rendered to donors
 * and operators from a single source. An entry that does not account for every
 * obligation fails validation rather than quietly leaving a gap.
 */
"use strict";

/**
 * Every compliance obligation a fiat-to-crypto flow attracts. A provider entry
 * must assign each one to `provider`, `platform`, or `shared` — there is no
 * default, because an unassigned obligation is precisely the failure mode.
 */
const OBLIGATIONS = Object.freeze([
  "kyc_identity_verification",
  "sanctions_screening",
  "transaction_monitoring",
  "suspicious_activity_reporting",
  "travel_rule",
  "fiat_custody",
  "chargeback_liability",
  "consumer_disclosures",
  "data_retention",
  "tax_reporting",
  "jurisdiction_restriction",
  "donor_support",
]);

const OWNERS = Object.freeze(["provider", "platform", "shared", "not_applicable"]);

/**
 * The obligations GreenPay keeps regardless of provider. Kept as an explicit
 * list so a new provider entry cannot accidentally delegate something the
 * platform cannot in fact delegate — a platform does not stop owing its own
 * users clear disclosures because its anchor has a licence.
 */
const NON_DELEGABLE = Object.freeze([
  "consumer_disclosures",
  "donor_support",
]);

/**
 * Provider registry.
 *
 * Only SEP-24 anchors appear here. A provider that would require GreenPay to
 * take card details, hold fiat, or receive funds on the donor's behalf is out
 * of scope by construction and cannot be added without changing ADR-002.
 *
 * `enabled: false` entries are documented but not offered — the compliance
 * split is reviewed before a provider goes live, not after.
 */
const PROVIDERS = Object.freeze([
  Object.freeze({
    id: "sep24-anchor",
    name: "SEP-24 anchor (generic)",
    kind: "sep24",
    /**
     * Set per-deployment. A deployment with no anchor configured simply does
     * not offer the fiat path, and the UI says so rather than dead-ending.
     */
    enabled: false,
    custodiesFiat: true,
    custodiesDonorKeys: false,
    deliversTo: "donor_address",
    /**
     * Where the anchor is licensed to operate. The platform does not attempt to
     * geolocate donors itself; the anchor refuses out-of-scope jurisdictions
     * during its own onboarding, which is the only place that check is reliable.
     */
    jurisdictionScope: "provider_declared",
    obligations: Object.freeze({
      kyc_identity_verification: "provider",
      sanctions_screening: "provider",
      transaction_monitoring: "provider",
      suspicious_activity_reporting: "provider",
      travel_rule: "provider",
      fiat_custody: "provider",
      chargeback_liability: "provider",
      // Not delegable: GreenPay's own UI makes the claims a donor relies on.
      consumer_disclosures: "platform",
      donor_support: "shared",
      // GreenPay retains donation records; the anchor retains identity records.
      data_retention: "shared",
      // Donation receipts are the platform's; fiat purchase records are the
      // anchor's. Neither issues tax advice.
      tax_reporting: "shared",
      jurisdiction_restriction: "provider",
    }),
    notes: [
      "GreenPay never receives, holds, or refunds fiat. A donor disputing a card payment disputes it with the anchor.",
      "GreenPay learns the donor's Stellar address and the on-chain arrival of the asset. It does not receive the donor's identity documents, name, or payment instrument.",
      "The anchor delivers to an address the donor controls. If that account does not exist yet, delivery is made as a claimable balance (see claimableBalances.js) rather than failing.",
    ],
  }),
]);

class OnrampConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "OnrampConfigError";
  }
}

/**
 * Validates one provider entry's compliance matrix. Exported and tested so a
 * future provider cannot be added with a gap in it.
 */
function validateProvider(provider) {
  const errors = [];

  for (const obligation of OBLIGATIONS) {
    const owner = provider.obligations?.[obligation];
    if (!owner) {
      errors.push(`obligation "${obligation}" is unassigned`);
      continue;
    }
    if (!OWNERS.includes(owner)) {
      errors.push(`obligation "${obligation}" has unknown owner "${owner}"`);
    }
  }

  for (const obligation of NON_DELEGABLE) {
    const owner = provider.obligations?.[obligation];
    if (owner === "provider") {
      errors.push(
        `obligation "${obligation}" cannot be delegated entirely to the provider — it must be "platform" or "shared"`,
      );
    }
  }

  const extra = Object.keys(provider.obligations || {}).filter((k) => !OBLIGATIONS.includes(k));
  if (extra.length) {
    errors.push(`unknown obligation key(s): ${extra.join(", ")}`);
  }

  if (provider.custodiesDonorKeys) {
    errors.push("a provider that custodies donor keys is incompatible with the platform's non-custodial guarantee");
  }

  if (errors.length) {
    throw new OnrampConfigError(
      `on-ramp provider "${provider.id}" has an incomplete compliance matrix:\n` +
        errors.map((e) => `  - ${e}`).join("\n"),
    );
  }
  return true;
}

/** Validates every registered provider. Called at module load. */
function validateRegistry(providers = PROVIDERS) {
  providers.forEach(validateProvider);
  return true;
}

validateRegistry();

/**
 * Providers this deployment will actually offer.
 *
 * A provider is offered only when it is both marked enabled in the registry
 * and configured with an anchor URL. Configuration alone is not enough: the
 * registry entry is where the compliance review is recorded, so an
 * un-reviewed provider cannot be switched on by an environment variable.
 */
function availableProviders({ anchorUrl, anchorHomeDomain } = {}) {
  return PROVIDERS.filter((p) => p.enabled).map((p) => ({
    ...p,
    anchorUrl: anchorUrl || null,
    anchorHomeDomain: anchorHomeDomain || null,
  }));
}

/**
 * What the donor is told before they leave for the anchor.
 *
 * Written as statements of fact about what happens next, not reassurance. A
 * donor who is about to hand identity documents to a third party is entitled to
 * know that before they click, not in a footer afterwards.
 */
function handoffDisclosure(provider) {
  return {
    providerId: provider.id,
    providerName: provider.name,
    statements: [
      `You will be handed to ${provider.name} to buy XLM. They take the payment, not GreenPay.`,
      "They will ask you to verify your identity. That is their requirement as a regulated provider, and GreenPay never sees what you give them.",
      "The XLM they send goes to an address only you hold the key for. GreenPay cannot spend it, and cannot get it back for you if you lose the key.",
      "If something goes wrong with the payment itself — a wrong amount, a card dispute, a refund — that is between you and the provider. GreenPay never holds your money and cannot reverse it.",
      "GreenPay will see that XLM arrived at your address. It will not see your name, your documents, or your card.",
    ],
    obligations: provider.obligations,
    notes: provider.notes,
  };
}

/**
 * The whole matrix, for docs and the admin view. Grouped by owner so the
 * question "what do we actually own?" has a one-line answer.
 */
function complianceMatrix(provider) {
  const byOwner = { provider: [], platform: [], shared: [], not_applicable: [] };
  for (const obligation of OBLIGATIONS) {
    const owner = provider.obligations[obligation];
    byOwner[owner].push(obligation);
  }
  return { providerId: provider.id, byOwner, obligations: provider.obligations };
}

module.exports = {
  OBLIGATIONS,
  OWNERS,
  NON_DELEGABLE,
  PROVIDERS,
  OnrampConfigError,
  validateProvider,
  validateRegistry,
  availableProviders,
  handoffDisclosure,
  complianceMatrix,
};
