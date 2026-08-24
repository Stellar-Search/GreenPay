/**
 * src/routes/leaderboard.js
 */
"use strict";
const express = require("express");
const router  = express.Router();
const pool = require("../db/pool");
const { validate } = require("../middleware/validate");
const { LeaderboardQuerySchema } = require("../schemas/leaderboard");

// period=all reads from donor_stats, the aggregate donation projections.js
// keeps current on every DonationRecorded/MatchApplied/MigratedDonation
// (unlike profiles.total_donated_xlm, which is dead and only ever 0).
const ALL_TIME_QUERY = `
  SELECT ds.public_key, p.display_name, ds.badges,
         ds.total_donated_xlm, ds.projects_supported,
         ROW_NUMBER() OVER (ORDER BY ds.total_donated_xlm DESC, ds.public_key ASC) AS rank
  FROM donor_stats ds
  JOIN profiles p ON p.public_key = ds.public_key
  ORDER BY ds.total_donated_xlm DESC, ds.public_key ASC
  LIMIT $1 OFFSET $2
`;

const ALL_TIME_COUNT_QUERY = "SELECT COUNT(*) AS total FROM donor_stats";

// period=month/year has no equivalent in donor_stats (it isn't keyed by
// donation timestamp), so this path still joins donations directly.
function periodQuery(period) {
  const interval = period === "month" ? "30 days" : "1 year";
  return `
    SELECT p.public_key, p.display_name, p.badges,
           COALESCE(SUM(d.amount_xlm), 0)::NUMERIC AS total_donated_xlm,
           COUNT(DISTINCT d.project_id)::INTEGER AS projects_supported,
           ROW_NUMBER() OVER (
             ORDER BY COALESCE(SUM(d.amount_xlm), 0) DESC, p.public_key ASC
           ) AS rank
    FROM profiles p
    LEFT JOIN donations d
      ON p.public_key = d.donor_address
      AND d.created_at >= NOW() - INTERVAL '${interval}'
    GROUP BY p.public_key, p.display_name, p.badges
    ORDER BY total_donated_xlm DESC, p.public_key ASC
    LIMIT $1 OFFSET $2
  `;
}

// The LEFT JOIN above never drops a profile regardless of the period filter,
// so every profile appears in the paginated result exactly once and the
// total is just the profile count — no need to repeat the aggregation.
const PERIOD_COUNT_QUERY = "SELECT COUNT(*) AS total FROM profiles";

router.get("/", validate(LeaderboardQuerySchema, { source: "query" }), async (req, res, next) => {
  try {
    const { limit, offset, period } = req.query;

    const [result, countResult] = await Promise.all(
      period === "all"
        ? [pool.query(ALL_TIME_QUERY, [limit, offset]), pool.query(ALL_TIME_COUNT_QUERY)]
        : [pool.query(periodQuery(period), [limit, offset]), pool.query(PERIOD_COUNT_QUERY)]
    );

    const entries = result.rows.map((p) => ({
      rank: Number(p.rank),
      publicKey: p.public_key,
      displayName: p.display_name || null,
      totalDonatedXLM: p.total_donated_xlm?.toString() || "0",
      projectsSupported: p.projects_supported,
      topBadge: p.badges?.[0]?.tier || null,
    }));

    res.apiMeta({
      pagination: {
        total: parseInt(countResult.rows[0]?.total ?? 0, 10),
        limit,
        offset,
      },
    });
    res.json(entries);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
