/**
 * src/schemas/leaderboard.js
 *
 * Declarative query schema for GET /api/leaderboard.
 * Mirrors schemas/admin.js's AdminAuditQuerySchema for limit/offset bounds.
 */
"use strict";

const { z } = require("zod");

const LeaderboardQuerySchema = z
  .object({
    period: z.enum(["all", "month", "year"]).optional().default("all"),
    limit: z.coerce.number().int().min(1).max(200).optional().default(20),
    cursor: z.string().optional(),
    offset: z.coerce.number().int().min(0).max(10000).optional().default(0),
  })
  .strip();

module.exports = {
  LeaderboardQuerySchema,
};
