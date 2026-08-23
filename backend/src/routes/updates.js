/**
 * src/routes/updates.js
 * GET  /api/updates/:projectId        — list updates for a project
 * POST /api/updates                   — create update + notify subscribers (admin)
 * POST /api/updates/:updateId/like — toggle like
 * GET  /api/updates/:updateId/likes — get like count and user's like status
 *
 * Rate limiters prevent admin update spam and like enumeration/spam.
 */
"use strict";
const express = require("express");
const router  = express.Router();
const { v4: uuidv4 } = require("uuid");
const pool = require("../db/pool");
const { createLayeredRateLimiter } = require("../middleware/rateLimiter");
const { mapProjectUpdateRow, mapProjectRow } = require("../services/store");
const { sendUpdateNotifications } = require("../services/email");
const { sendUpdatePushNotifications } = require("../services/push");

const { adminRequired } = require("../middleware/auth");
const { createApiError } = require("../middleware/apiEnvelope");

// Rate limiter for admin update creation: an IP floor plus the real cap on the
// authenticated subject, so the same admin account is bounded regardless of
// which address it logs in from. 5 updates per admin per hour.
const updateCreationLimiter = createLayeredRateLimiter({
  name: "update-create",
  windowMinutes: 60,
  ip: 30,
  subject: 5,
});

// Rate limiter for like operations: coarse per-IP floor plus the real
// per-wallet cap. Prevents like enumeration/spam: 20 likes per donor per hour.
const likeLimiter = createLayeredRateLimiter({
  name: "update-like",
  windowMinutes: 1,
  ip: 60,
  wallet: 20,
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GET /api/updates/:projectId — list updates for a project, newest first
router.get("/:projectId", async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT * FROM project_updates WHERE project_id = $1 ORDER BY created_at DESC",
      [req.params.projectId],
    );
    res.json(result.rows.map(mapProjectUpdateRow));
  } catch (e) {
    next(e);
  }
});

// POST /api/updates  (admin only)
// Rate-limited to prevent update spam
router.post("/", adminRequired, updateCreationLimiter, async (req, res, next) => {
  try {
    const { projectId, title, body } = req.body;

    if (!projectId || typeof projectId !== "string") {
      throw createApiError(400, "PROJECT_ID_REQUIRED", "projectId is required");
    }
    if (!title || typeof title !== "string" || !title.trim()) {
      throw createApiError(400, "TITLE_REQUIRED", "title is required");
    }
    if (!body || typeof body !== "string" || !body.trim()) {
      throw createApiError(400, "BODY_REQUIRED", "body is required");
    }

    // Verify project exists
    const projResult = await pool.query("SELECT * FROM projects WHERE id = $1", [projectId]);
    if (!projResult.rows[0]) {
      throw createApiError(404, "PROJECT_NOT_FOUND", "Project not found");
    }
    const project = mapProjectRow(projResult.rows[0]);

    // Insert update
    const id = uuidv4();
    const insertResult = await pool.query(
      `INSERT INTO project_updates (id, project_id, title, body)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, projectId, title.trim(), body.trim()],
    );
    const update = mapProjectUpdateRow(insertResult.rows[0]);

    // Fetch subscriber emails and send notifications (non-blocking)
    pool.query(
      "SELECT email FROM project_subscriptions WHERE project_id = $1",
      [projectId],
    ).then(({ rows }) => {
      const emails = rows.map((r) => r.email);
      return sendUpdateNotifications({ project, update, emails });
    }).catch((err) => {
      console.error("[updates] Failed to send email notifications:", err.message);
    });

    // Send push notifications (non-blocking)
    sendUpdatePushNotifications({ project, update }).catch((err) => {
      console.error("[updates] Failed to send push notifications:", err.message);
    });

    res.status(201).json(update);
  } catch (e) {
    next(e);
  }
});

// GET /api/updates/:projectId — list updates for a project, most recent first
router.get("/:projectId", async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT * FROM project_updates WHERE project_id = $1 ORDER BY created_at DESC",
      [req.params.projectId],
    );
    res.json(result.rows.map(mapProjectUpdateRow));
  } catch (e) {
    next(e);
  }
});

// POST /api/updates/:updateId/like — toggle like
// Rate-limited per donor to prevent like enumeration/spam
router.post("/:updateId/like", likeLimiter, async (req, res, next) => {
  try {
    const { donorAddress } = req.body || {};
    if (!donorAddress || typeof donorAddress !== "string") {
      throw createApiError(400, "DONOR_ADDRESS_REQUIRED", "donorAddress is required");
    }

    const updateResult = await pool.query(
      "SELECT id FROM project_updates WHERE id = $1",
      [req.params.updateId],
    );
    if (!updateResult.rows[0]) {
      throw createApiError(404, "UPDATE_NOT_FOUND", "Update not found");
    }

    // Check if already liked
    const existing = await pool.query(
      "SELECT id FROM update_likes WHERE update_id = $1 AND donor_address = $2",
      [req.params.updateId, donorAddress],
    );

    if (existing.rows[0]) {
      // Unlike
      await pool.query(
        "DELETE FROM update_likes WHERE update_id = $1 AND donor_address = $2",
        [req.params.updateId, donorAddress],
      );
    } else {
      // Like
      await pool.query(
        "INSERT INTO update_likes (id, update_id, donor_address, created_at) VALUES ($1, $2, $3, NOW())",
        [require("uuid").v4(), req.params.updateId, donorAddress],
      );
    }

    // Get updated like count
    const countResult = await pool.query(
      "SELECT COUNT(*) as count FROM update_likes WHERE update_id = $1",
      [req.params.updateId],
    );

    res.json({
      liked: !existing.rows[0],
      likeCount: parseInt(countResult.rows[0].count),
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/updates/:updateId/likes — get like count and user's like status
router.get("/:updateId/likes", async (req, res, next) => {
  try {
    const { donorAddress } = req.query;
    const countResult = await pool.query(
      "SELECT COUNT(*) as count FROM update_likes WHERE update_id = $1",
      [req.params.updateId],
    );
    let liked = false;
    if (donorAddress) {
      const existing = await pool.query(
        "SELECT id FROM update_likes WHERE update_id = $1 AND donor_address = $2",
        [req.params.updateId, donorAddress],
      );
      liked = !!existing.rows[0];
    }
    res.json({
      likeCount: parseInt(countResult.rows[0].count),
      liked,
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
