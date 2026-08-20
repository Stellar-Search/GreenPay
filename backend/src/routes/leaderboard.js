/**
 * src/routes/leaderboard.js
 */
"use strict";
const express = require("express");
const router  = express.Router();
const pool = require("../db/pool");

router.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const period = req.query.period || "all";

    const periodFilter =
      period === "month"
        ? " AND d.created_at >= NOW() - INTERVAL '30 days' "
        : period === "year"
          ? " AND d.created_at >= NOW() - INTERVAL '1 year' "
          : "";

    const query = `
      SELECT p.public_key, p.display_name, p.badges,
             COALESCE(SUM(d.amount_xlm), 0)::NUMERIC AS total_donated_xlm,
             COUNT(DISTINCT d.project_id)::INTEGER AS projects_supported
      FROM profiles p
      LEFT JOIN donations d ON p.public_key = d.donor_address
      ${periodFilter}
      GROUP BY p.public_key, p.display_name, p.badges
      ORDER BY total_donated_xlm DESC
      LIMIT $1 OFFSET $2
    `;

    const result = await pool.query(query, [limit, offset]);
    const entries = result.rows.map((p, i) => ({
      rank: i + 1,
      publicKey: p.public_key,
      displayName: p.display_name || null,
      totalDonatedXLM: p.total_donated_xlm?.toString() || "0",
      projectsSupported: p.projects_supported,
      topBadge: p.badges?.[0]?.tier || null,
    }));
    res.json({ success: true, data: entries });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
