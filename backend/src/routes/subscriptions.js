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
const { randomUUID: uuidv4 } = require("crypto");
const pool = require("../db/pool");
const { createRateLimiter } = require("../middleware/rateLimiter");
const { createApiError } = require("../middleware/apiEnvelope");
const { requireContentLanguage } = require("../services/contentLanguage");

// Rate limiter for subscription operations per email address
// Prevents subscription spam
const subscriptionLimiter = createRateLimiter(3, 1, "subscription-post"); // 3 subscriptions per email per hour

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post("/", subscriptionLimiter, async (req, res, next) => {
  try {
    const { projectId, email, donorAddress } = req.body || {};
    if (!projectId || typeof projectId !== "string") {
      throw createApiError(400, "PROJECT_ID_REQUIRED", "projectId is required");
    }
    const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(normalizedEmail)) {
      throw createApiError(400, "EMAIL_INVALID", "A valid email is required");
    }
    const preferredLanguage = req.body?.preferredLanguage === undefined
      ? "en"
      : requireContentLanguage(req.body.preferredLanguage);
    const project = await pool.query("SELECT id FROM projects WHERE id = $1", [projectId]);
    if (!project.rows[0]) {
      throw createApiError(404, "PROJECT_NOT_FOUND", "Project not found");
    }
    await pool.query(
      `INSERT INTO project_subscriptions
        (id, project_id, email, donor_address, preferred_language)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id, email) DO UPDATE SET
         donor_address = COALESCE(EXCLUDED.donor_address, project_subscriptions.donor_address),
         preferred_language = EXCLUDED.preferred_language`,
      [uuidv4(), projectId, normalizedEmail, donorAddress || null, preferredLanguage],
    );
    res.status(201).json({ message: "Subscribed", preferredLanguage });
  } catch (e) {
    next(e);
  }
});

router.get("/:projectId/count", async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT COUNT(*) AS count FROM project_subscriptions WHERE project_id = $1",
      [req.params.projectId],
    );
    res.json({ count: Number.parseInt(result.rows[0]?.count || "0", 10) });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
