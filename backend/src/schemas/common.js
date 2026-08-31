/**
 * src/schemas/common.js
 *
 * Reusable, declarative field schemas shared across route validators.
 * This is the single source of truth for cross-cutting request shapes
 * (Stellar keys, transaction hashes, identifiers). Routes must not hand-roll
 * these regexes inline — import them from here instead.
 */
"use strict";

const { z } = require("zod");

const { isValidStellarAddress } = require("../../../shared/validators/stellarValidator");

const STELLAR_PUBLIC_KEY = /^G[A-Z0-9]{55}$/; // Legacy export maintained for compatibility
const TRANSACTION_HASH = /^[a-fA-F0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const stellarPublicKey = z
  .string({ required_error: "Invalid Stellar public key" })
  .refine(isValidStellarAddress, "Invalid Stellar public key");

const transactionHash = z
  .string({ required_error: "Invalid transaction hash" })
  .regex(TRANSACTION_HASH, "Invalid transaction hash");

const uuid = z
  .string({ required_error: "Invalid identifier" })
  .regex(UUID, "Invalid identifier");

module.exports = {
  STELLAR_PUBLIC_KEY,
  TRANSACTION_HASH,
  UUID,
  stellarPublicKey,
  transactionHash,
  uuid,
};
