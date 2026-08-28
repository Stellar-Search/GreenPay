/**
 * src/routes/profiles.js
 */
"use strict";
const express = require("express");
const router  = express.Router();
const pool = require("../db/pool");
const { mapProfileRow } = require("../services/store");
const { createLayeredRateLimiter } = require("../middleware/rateLimiter");
const { createApiError } = require("../middleware/apiEnvelope");
const { isValidStellarAddress } = require("../../../shared/validators/stellarValidator");

function validateKey(k) {
  if (!k || !isValidStellarAddress(k)) {
    throw createApiError(400, "INVALID_PUBLIC_KEY", "Invalid public key");
  }
}

// Layered: per-IP floor (shared egresses don't starve each other) + per-wallet
// cap so profile writes are bounded per identity, not per address.
const profilePostLimiter = createLayeredRateLimiter({
  name: "profile-post",
  windowMinutes: 1,
  ip: 60,
  wallet: 20,
});

router.get("/:publicKey", async (req, res, next) => {
  try {
    validateKey(req.params.publicKey);
    const result = await pool.query("SELECT * FROM profiles WHERE public_key = $1", [req.params.publicKey]);
    if (!result.rows[0]) {
      throw createApiError(404, "PROFILE_NOT_FOUND", "Profile not found");
    }
    res.json(mapProfileRow(result.rows[0]));
  } catch (e) { next(e); }
});

router.post("/", profilePostLimiter, async (req, res, next) => {
  try {
    const { publicKey, displayName, bio } = req.body;
    validateKey(publicKey);
    const trimmedDisplayName = displayName?.trim().slice(0, 30) || null;
    const trimmedBio = bio?.trim().slice(0, 300) || null;

    const result = await pool.query(
      `INSERT INTO profiles (
        public_key, display_name, bio, total_donated_xlm, projects_supported, badges, created_at, updated_at
      )
      VALUES ($1, $2, $3, 0, 0, '[]'::jsonb, NOW(), NOW())
      ON CONFLICT (public_key) DO UPDATE SET
        display_name = COALESCE($2, profiles.display_name),
        bio = COALESCE($3, profiles.bio),
        updated_at = NOW()
      RETURNING *`,
      [publicKey, trimmedDisplayName, trimmedBio],
    );

    res.json(mapProfileRow(result.rows[0]));
  } catch (e) { next(e); }
});

module.exports = router;
