/**
 * src/routes/stats.js
 * GET /api/stats/global — platform-wide totals (donations count, XLM raised, CO2 offset)
 */
"use strict";
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { normalizeXlm } = require("../utils/xlm");

// GET /api/stats/global
router.get("/global", async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(d.id)::int            AS "totalDonations",
        COALESCE(SUM(d.amount), 0)  AS "totalXLMRaised",
        COALESCE(SUM(p.co2_offset_kg), 0)::int AS "totalCO2OffsetKg"
      FROM donations d
      JOIN projects p ON p.id = d.project_id
      WHERE d.currency = 'XLM' OR d.currency IS NULL
    `);

    const row = result.rows[0];
    res.json({
      totalDonations: row.totalDonations,
      // SUM arrives as an exact NUMERIC string; normalize it without a
      // double round-trip so the reported total never drifts by a stroop.
      totalXLMRaised: normalizeXlm(row.totalXLMRaised),
      totalCO2OffsetKg: row.totalCO2OffsetKg,
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
