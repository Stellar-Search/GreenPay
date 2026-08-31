/**
 * src/routes/onboarding.js
 *
 * The API behind the graduated first-donation paths.
 *
 * Everything here is additive. No existing endpoint changes shape, and a donor
 * who arrives with an installed wallet and a funded account never touches this
 * router — that flow is exactly what it was. See
 * docs/adr/ADR-005-graduated-non-custodial-donor-onboarding.md.
 */
"use strict";

const crypto = require("crypto");
const express = require("express");
const router = express.Router();

const pool = require("../db/pool");
const { env } = require("../config/env");
const { createApiError } = require("../middleware/apiEnvelope");
const { createLayeredRateLimiter } = require("../middleware/rateLimiter");
const { validateBody, validate } = require("../middleware/validate");
const { adminRequired } = require("../middleware/auth");
const { logger: rootLogger } = require("../utils/logger");

const funnel = require("../services/onboarding/funnel");
const sponsored = require("../services/onboarding/sponsoredAccounts");
const policy = require("../services/onboarding/sponsorshipPolicy");
const onramp = require("../services/onboarding/onramp");
const upgrade = require("../services/onboarding/accountUpgrade");
const reserves = require("../services/onboarding/reserveAccounting");

const {
  SessionStartSchema,
  FunnelEventSchema,
  SessionCompleteSchema,
  SponsorshipQuoteSchema,
  SponsorshipRequestSchema,
  SponsorshipSubmitSchema,
  UpgradeChallengeSchema,
  UpgradeCompleteSchema,
  ConversionQuerySchema,
} = require("../schemas/onboarding");

const logger = rootLogger.child({ service: "onboarding-route" });

/**
 * Funnel telemetry is high-volume and cheap; sponsorship is low-volume and
 * expensive. They get very different limits, because one shared limit would
 * either throttle instrumentation or leave the treasury open.
 */
const funnelLimiter = createLayeredRateLimiter({
  name: "onboarding-funnel",
  windowMinutes: 1,
  ip: 120,
  global: 3000,
});

const sponsorshipLimiter = createLayeredRateLimiter({
  name: "onboarding-sponsorship",
  windowMinutes: 60,
  ip: 10,
  global: 200,
});

const upgradeLimiter = createLayeredRateLimiter({
  name: "onboarding-upgrade",
  windowMinutes: 60,
  ip: 20,
  global: 200,
});

/**
 * Rate-limit records must not be a de-facto IP log.
 *
 * The hash is salted per-deployment and truncated: enough entropy to count
 * distinct sources, not enough to enumerate the IPv4 space back out of it. When
 * no salt is configured the hash falls back to the process-lifetime random
 * value below, which degrades the limit across restarts rather than degrading
 * privacy — the right direction for a value the operator forgot to set.
 */
const EPHEMERAL_SALT = crypto.randomBytes(32).toString("hex");

function hashSource(value) {
  if (!value) return null;
  const salt = env.onboardingIpHashSalt || EPHEMERAL_SALT;
  return crypto.createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 32);
}

// ── Path discovery ───────────────────────────────────────────────────────────

/**
 * GET /api/v1/onboarding/paths
 *
 * What this deployment can actually offer, with the trade-offs attached to
 * each. The disclosures ship with the options rather than being fetched
 * separately, so a client cannot render the choice without the cost of it.
 */
router.get("/paths", async (req, res, next) => {
  try {
    const sponsorshipEnabled = sponsored.isSponsorshipEnabled();
    const providers = onramp.availableProviders({
      anchorUrl: env.onrampAnchorUrl,
      anchorHomeDomain: env.onrampAnchorHomeDomain,
    });
    const limits = policy.resolveLimits({
      maxSponsoredDonationXlm: env.sponsorshipMaxDonationXlm,
      maxSponsoredLifetimeXlm: env.sponsorshipMaxLifetimeXlm,
    });

    res.json({
      paths: [
        {
          id: "connected_wallet",
          title: "I already have a Stellar wallet",
          available: true,
          requires: ["A wallet extension or app", "An account with XLM in it"],
          // Named explicitly so nobody has to infer from silence that the
          // existing flow survived this change.
          unchanged: true,
          tradeoffs: {
            keep: [
              "Full control of your key, your account and your history, exactly as today.",
              "No caps beyond what your own balance allows.",
            ],
            giveUp: [],
          },
        },
        {
          id: "sponsored_account",
          title: "I have XLM coming, but no Stellar account yet",
          available: sponsorshipEnabled,
          unavailableReason: sponsorshipEnabled
            ? null
            : "This deployment has no sponsorship treasury configured.",
          requires: ["A few seconds", "Somewhere to keep a key"],
          quote: reserves.sponsorshipQuote({}),
          limits: {
            maxDonationXlm: limits.maxSponsoredDonationXlm,
            maxLifetimeXlm: limits.maxSponsoredLifetimeXlm,
          },
          tradeoffs: {
            keep: upgrade.STARTER_ACCOUNT_DISCLOSURES.keep,
            giveUp: upgrade.STARTER_ACCOUNT_DISCLOSURES.giveUp,
            mitigation: upgrade.STARTER_ACCOUNT_DISCLOSURES.mitigation,
          },
        },
        {
          id: "onramp",
          title: "I have no wallet and no XLM",
          available: providers.length > 0,
          unavailableReason:
            providers.length > 0 ? null : "No fiat on-ramp provider is configured for this deployment.",
          requires: ["A payment method", "Identity verification by the provider, not by GreenPay"],
          providers: providers.map((p) => ({
            id: p.id,
            name: p.name,
            kind: p.kind,
            disclosure: onramp.handoffDisclosure(p),
          })),
          tradeoffs: {
            keep: upgrade.STARTER_ACCOUNT_DISCLOSURES.keep,
            giveUp: [
              ...upgrade.STARTER_ACCOUNT_DISCLOSURES.giveUp,
              "The provider will ask for identity documents. That is their legal requirement, and GreenPay never sees them.",
            ],
            mitigation: upgrade.STARTER_ACCOUNT_DISCLOSURES.mitigation,
          },
        },
      ],
      // Restated at the top level so a client rendering only a summary still
      // carries the guarantee the whole design rests on.
      guarantee:
        "GreenPay never holds your key and never holds your money. Every donation goes from an account you control straight to the project.",
    });
  } catch (e) {
    next(e);
  }
});

// ── Funnel instrumentation ───────────────────────────────────────────────────

router.post("/sessions", funnelLimiter, async (req, res, next) => {
  try {
    const body = validateBody(SessionStartSchema, req.body || {});
    const result = await funnel.startSession(
      { path: body.path || null, projectId: body.projectId || null, referrer: body.referrer },
      pool,
    );
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

router.post("/events", funnelLimiter, async (req, res, next) => {
  try {
    const body = validateBody(FunnelEventSchema, req.body || {});
    const result = await funnel.recordStage(body, pool);
    res.status(202).json(result);
  } catch (e) {
    // Telemetry must never be able to break a donation. An unknown stage is a
    // client bug worth logging, not a reason to fail the donor's request.
    if (e instanceof funnel.FunnelError) {
      logger.warn({ msg: "funnel event rejected", error: e.message });
      return res.status(202).json({ recorded: false, reason: e.message });
    }
    next(e);
  }
});

router.post("/sessions/complete", funnelLimiter, async (req, res, next) => {
  try {
    const body = validateBody(SessionCompleteSchema, req.body || {});
    res.json(await funnel.completeSession(body, pool));
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/v1/onboarding/funnel/conversion
 *
 * Admin-only: conversion is operational data, and publishing the exact stage
 * where donors give up is also publishing where to aim an attack.
 */
router.get("/funnel/conversion", adminRequired, validate(ConversionQuerySchema, { source: "query" }), async (req, res, next) => {
  try {
    const { since, until, path, baselineSince, baselineUntil } = req.query;

    if (baselineSince && baselineUntil) {
      const comparison = await funnel.compareToBaseline(
        {
          baselineSince,
          baselineUntil,
          currentSince: since || baselineUntil,
          currentUntil: until || null,
        },
        pool,
      );
      return res.json(comparison);
    }

    const report = await funnel.conversionReport(
      { sinceIso: since || null, untilIso: until || null, path: path || null },
      pool,
    );
    res.json({ ...report, biggestDropOffs: funnel.biggestDropOffs(report) });
  } catch (e) {
    next(e);
  }
});

// ── Sponsored account creation ───────────────────────────────────────────────

/**
 * POST /api/v1/onboarding/sponsorship/quote
 *
 * Costed, but non-committal. A donor sees exactly what the platform locks and
 * what they are accepting before any state exists anywhere.
 */
router.post("/sponsorship/quote", sponsorshipLimiter, async (req, res, next) => {
  try {
    const body = validateBody(SponsorshipQuoteSchema, req.body || {});
    const result = await sponsored.quoteSponsorship({
      publicKey: body.publicKey,
      sessionId: body.sessionId || null,
      ipHash: hashSource(req.ip),
      trustline: body.trustline,
    });
    res.json(result);
  } catch (e) {
    next(toApiError(e));
  }
});

/**
 * POST /api/v1/onboarding/sponsorship
 *
 * Returns a transaction the sponsor has already signed and the donor must
 * co-sign. The platform cannot submit it alone; the donor cannot get their
 * reserve sponsored without agreeing to this exact transaction.
 */
router.post("/sponsorship", sponsorshipLimiter, async (req, res, next) => {
  try {
    const body = validateBody(SponsorshipRequestSchema, req.body || {});
    const result = await sponsored.requestSponsorship({
      publicKey: body.publicKey,
      sessionId: body.sessionId,
      ipHash: hashSource(req.ip),
      userAgentHash: hashSource(req.get("user-agent")),
      trustline: body.trustline,
    });
    res.status(201).json(result);
  } catch (e) {
    next(toApiError(e));
  }
});

router.post("/sponsorship/:id/submit", sponsorshipLimiter, async (req, res, next) => {
  try {
    const body = validateBody(SponsorshipSubmitSchema, req.body || {});
    const result = await sponsored.submitSponsorship({ id: req.params.id, signedXdr: body.signedXdr });
    res.json(result);
  } catch (e) {
    next(toApiError(e));
  }
});

/**
 * POST /api/v1/onboarding/sponsorship/:id/abandon
 *
 * The donor closed the flow. Releases the reserved treasury capacity and leaves
 * nothing behind but an audit row — the whole point being that walking away
 * mid-flow costs the platform nothing and leaves the donor with no half-created
 * account to be confused by later.
 */
router.post("/sponsorship/:id/abandon", sponsorshipLimiter, async (req, res, next) => {
  try {
    res.json(await sponsored.abandonSponsorship(req.params.id, pool));
  } catch (e) {
    next(toApiError(e));
  }
});

/** GET /api/v1/onboarding/sponsorship/ledger — the reserve position. */
router.get("/sponsorship/ledger", adminRequired, async (req, res, next) => {
  try {
    const ledger = await sponsored.reserveLedger(pool);
    let treasury = null;
    if (sponsored.isSponsorshipEnabled()) {
      try {
        const balance = await sponsored.readTreasuryBalanceStroops();
        const capacity = reserves.treasuryCapacity({
          treasuryBalanceStroops: balance,
          activeSponsorships: ledger.activeSponsorships,
        });
        treasury = {
          publicKey: sponsored.sponsorPublicKey(),
          balanceXlm: reserves.stroopsToXlmString(balance),
          remainingAccounts: capacity.capacity,
          lockableXlm: reserves.stroopsToXlmString(capacity.lockableStroops),
        };
      } catch (err) {
        treasury = { error: err.message };
      }
    }

    res.json({
      ...ledger,
      enabled: sponsored.isSponsorshipEnabled(),
      treasury,
      perAccountCostXlm: reserves.sponsorshipCost({}).totalXlm,
      perAccountFeeXlm: reserves.sponsorshipFees().totalXlm,
      signals: policy.monitoringSignals({
        treasuryRemainingAccounts: treasury?.remainingAccounts,
        reclaimFailures: ledger.reclaimFailures,
      }),
    });
  } catch (e) {
    next(toApiError(e));
  }
});

/** POST /api/v1/onboarding/sponsorship/:id/reclaim — the recovery path. */
router.post("/sponsorship/:id/reclaim", adminRequired, async (req, res, next) => {
  try {
    res.json(await sponsored.reclaimSponsorship(req.params.id, { pool }));
  } catch (e) {
    next(toApiError(e));
  }
});

// ── On-ramp ──────────────────────────────────────────────────────────────────

router.get("/onramp/providers", async (req, res, next) => {
  try {
    const providers = onramp.availableProviders({
      anchorUrl: env.onrampAnchorUrl,
      anchorHomeDomain: env.onrampAnchorHomeDomain,
    });
    res.json({
      providers: providers.map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        anchorUrl: p.anchorUrl,
        anchorHomeDomain: p.anchorHomeDomain,
        disclosure: onramp.handoffDisclosure(p),
        compliance: onramp.complianceMatrix(p),
      })),
      // An empty list is a configuration answer, not an error. The UI needs to
      // say "not available here" rather than spin.
      configured: providers.length > 0,
    });
  } catch (e) {
    next(e);
  }
});

// ── Account upgrade ──────────────────────────────────────────────────────────

router.get("/upgrade/disclosures", (req, res) => {
  res.json({
    starterAccount: upgrade.STARTER_ACCOUNT_DISCLOSURES,
    upgrade: upgrade.UPGRADE_LIMITATIONS,
  });
});

router.post("/upgrade/challenge", upgradeLimiter, async (req, res, next) => {
  try {
    const body = validateBody(UpgradeChallengeSchema, req.body || {});
    res.status(201).json(await upgrade.createUpgradeChallenge(body, pool));
  } catch (e) {
    next(toApiError(e));
  }
});

router.post("/upgrade/complete", upgradeLimiter, async (req, res, next) => {
  try {
    const body = validateBody(UpgradeCompleteSchema, req.body || {});
    res.json(await upgrade.completeUpgrade(body, { pool }));
  } catch (e) {
    next(toApiError(e));
  }
});

/**
 * Service errors already carry a code, a message and a status. Converting them
 * here keeps the shared error envelope as the single response format instead of
 * letting each service invent one.
 */
function toApiError(err) {
  if (err && typeof err.status === "number" && err.code) {
    return createApiError(err.status, err.code, err.message, err.details);
  }
  return err;
}

module.exports = router;
module.exports.hashSource = hashSource;
