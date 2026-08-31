/**
 * src/schemas/onboarding.js
 *
 * Request schemas for the graduated onboarding endpoints.
 * Mirrors docs/openapi.yml `/api/v1/onboarding/*`.
 */
"use strict";

const { z } = require("zod");
const { stellarPublicKey, uuid } = require("./common");
const { STAGES, PATHS, OUTCOMES } = require("../services/onboarding/funnel");

const onboardingPath = z.enum(PATHS);
const funnelStage = z.enum(STAGES);

const SessionStartSchema = z.object({
  path: onboardingPath.optional().nullable(),
  projectId: uuid.optional().nullable(),
  referrer: z.string().max(500).optional().nullable(),
});

const FunnelEventSchema = z.object({
  sessionId: uuid,
  stage: funnelStage,
  path: onboardingPath.optional().nullable(),
  projectId: uuid.optional().nullable(),
  // Bounded and structured: a free-form blob on a public, unauthenticated
  // endpoint is a storage-abuse vector as much as a privacy one.
  detail: z.record(z.union([z.string().max(200), z.number(), z.boolean()])).optional().nullable(),
});

const SessionCompleteSchema = z.object({
  sessionId: uuid,
  outcome: z.enum(OUTCOMES),
  path: onboardingPath.optional().nullable(),
});

const SponsorshipQuoteSchema = z.object({
  publicKey: stellarPublicKey,
  sessionId: uuid.optional().nullable(),
  trustline: z.boolean().optional().default(false),
});

const SponsorshipRequestSchema = z.object({
  publicKey: stellarPublicKey,
  sessionId: uuid,
  trustline: z.boolean().optional().default(false),
  // The donor must have seen the reserve disclosure before a request is
  // accepted. Enforced at the API rather than only in the UI, so the guarantee
  // survives a client that skips the screen.
  acknowledgedDisclosure: z.literal(true, {
    errorMap: () => ({ message: "The sponsorship trade-offs must be acknowledged before an account is created." }),
  }),
});

const SponsorshipSubmitSchema = z.object({
  signedXdr: z.string().min(1, "signedXdr is required").max(65536),
});

const UpgradeChallengeSchema = z.object({
  fromAddress: stellarPublicKey,
  toAddress: stellarPublicKey,
});

const UpgradeCompleteSchema = z.object({
  upgradeId: uuid,
  /** Raw ed25519 signature over the challenge text, by the starter key. */
  fromSignature: z.string().min(1).max(512),
  /**
   * The destination wallet's signed, unsubmittable challenge envelope. Not a
   * raw signature, because wallet extensions will not sign arbitrary bytes —
   * see accountUpgrade.verifyChallengeEnvelope.
   */
  toChallengeXdr: z.string().min(1).max(8192),
});

const ConversionQuerySchema = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  path: onboardingPath.optional(),
  baselineSince: z.string().datetime().optional(),
  baselineUntil: z.string().datetime().optional(),
});

module.exports = {
  onboardingPath,
  funnelStage,
  SessionStartSchema,
  FunnelEventSchema,
  SessionCompleteSchema,
  SponsorshipQuoteSchema,
  SponsorshipRequestSchema,
  SponsorshipSubmitSchema,
  UpgradeChallengeSchema,
  UpgradeCompleteSchema,
  ConversionQuerySchema,
};
