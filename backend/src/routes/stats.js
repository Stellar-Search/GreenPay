/**
 * src/routes/stats.js
 * GET /api/stats/global — platform-wide donation and claim-record counts.
 */
"use strict";
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");

// GET /api/stats/global
router.get("/global", async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int
           FROM donations d
          WHERE d.status = 'committed'
            AND (d.currency = 'XLM' OR d.currency IS NULL)) AS "totalDonations",
        (SELECT COALESCE(SUM(d.amount_xlm), 0)
           FROM donations d
          WHERE d.status = 'committed'
            AND (d.currency = 'XLM' OR d.currency IS NULL)) AS "totalXLMRaised",
        (SELECT COUNT(*)::int FROM impact_claims) AS "publishedImpactClaims",
        (SELECT COUNT(*)::int
           FROM impact_claims c
          WHERE c.status = 'verified'
            AND EXISTS (
              SELECT 1 FROM impact_attestations a
               WHERE a.claim_id = c.id
                 AND a.status = 'verified'
                 AND a.expires_at > NOW()
            )) AS "verifiedImpactClaims"
    `);

    const row = result.rows[0];
    res.json({
      totalDonations: row.totalDonations,
      totalXLMRaised: parseFloat(row.totalXLMRaised).toFixed(7),
      publishedImpactClaims: row.publishedImpactClaims,
      verifiedImpactClaims: row.verifiedImpactClaims,
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/stats/categories — project count per category
router.get("/categories", async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        category,
        COUNT(*)::int AS count
      FROM projects
      WHERE status = 'active'
      GROUP BY category
      ORDER BY count DESC, category ASC
    `);

    res.json(result.rows);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
