/**
 * src/routes/subscriptions.js
 * POST /api/subscriptions        — subscribe to project updates
 * GET  /api/subscriptions/:projectId/count — subscriber count
 *
 * Rate limiter per donor email address to prevent subscription spam.
 * despite the name, this file has nothing to do with recurring
 * ("monthly giving") donations — it manages email subscriptions to project
 * update posts (backed by the `project_subscriptions` table). Recurring
 * donation scheduling lives entirely in frontend/lib/monthlyGiving.ts today;
 * there is no backend job that executes monthly-giving charges yet. See
 * docs/monthly-giving-scheduling.md for the audit that established this and
 * backend/src/utils/recurringSchedule.js for the date math a future charge
 * executor should reuse.
 *
 * Rate limit: 3 subscriptions per email per hour to prevent abuse.
 */
"use strict";
const express = require("express");
const router  = express.Router();
const { v4: uuidv4 } = require("uuid");
const pool = require("../db/pool");
const { createRateLimiter } = require("../middleware/rateLimiter");

// Rate limiter for subscription operations per email address
// Prevents subscription spam
const subscriptionLimiter = createRateLimiter(3, 1, "subscription-post"); // 3 subscriptions per email per hour

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = router;
