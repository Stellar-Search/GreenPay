/**
 * src/schemas/donations.js
 *
 * Declarative request schema for the donation recording endpoint.
 * Mirrors docs/openapi.yml `/api/donations` (recordDonation).
 */
"use strict";

const { z } = require("zod");
const { stellarPublicKey, transactionHash } = require("./common");

const DonationCreateSchema = z.object({
  projectId: z.string({ required_error: "projectId is required" }).min(1, "projectId is required"),
  donorAddress: stellarPublicKey,
  transactionHash,
  amountXLM: z.union([z.string(), z.number()]).optional(),
  amount: z.union([z.string(), z.number()]).optional(),
  currency: z.string().trim().min(1).max(8).optional().default("XLM"),
  message: z.string().max(280).optional().nullable(),
});

module.exports = { DonationCreateSchema };
