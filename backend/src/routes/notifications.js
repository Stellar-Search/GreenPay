/**
 * src/routes/notifications.js
 * POST /api/notifications/register      — register device token
 * POST /api/notifications/follow        — follow a project
 * POST /api/notifications/unfollow      — unfollow a project
 * GET  /api/notifications/follows       — get user's followed projects
 *
 * Rate limiters per donor address to prevent enumeration/spam.
 */
"use strict";
const express = require("express");
const router = express.Router();
const { randomUUID: uuidv4 } = require("crypto");
const pool = require("../db/pool");
const { createLayeredRateLimiter } = require("../middleware/rateLimiter");
const { createApiError } = require("../middleware/apiEnvelope");

// Rate limiter for follow/unfollow operations: a coarse per-IP floor so donors
// behind a shared egress don't throttle each other, plus the real per-wallet
// cap that prevents enumeration and follow/unfollow spam.
const notificationLimiter = createLayeredRateLimiter({
  name: "notification-follow",
  windowMinutes: 1,
  ip: 30,
  wallet: 10, // 10 follows/unfollows per donor per minute
});

// POST /api/notifications/register
// Register or update a device token
router.post("/register", async (req, res, next) => {
  try {
    const { token, platform, walletAddress } = req.body;

    if (!token || typeof token !== "string") {
      throw createApiError(400, "TOKEN_REQUIRED", "token is required");
    }
    if (!platform || typeof platform !== "string") {
      throw createApiError(400, "PLATFORM_REQUIRED", "platform is required (ios/android)");
    }

    // Check if token exists
    const existingResult = await pool.query(
      "SELECT * FROM device_tokens WHERE token = $1",
      [token]
    );

    if (existingResult.rows[0]) {
      // Update existing token
      await pool.query(
        `UPDATE device_tokens 
         SET platform = $1, wallet_address = $2, last_seen_at = NOW(), updated_at = NOW()
         WHERE token = $3`,
        [platform, walletAddress || null, token]
      );
      res.json({ tokenId: existingResult.rows[0].id });
    } else {
      // Insert new token
      const id = uuidv4();
      await pool.query(
        `INSERT INTO device_tokens (id, token, platform, wallet_address)
         VALUES ($1, $2, $3, $4)`,
        [id, token, platform, walletAddress || null]
      );
      res.json({ tokenId: id });
    }
  } catch (e) {
    next(e);
  }
});

// POST /api/notifications/follow
// Follow a project for push notifications
// Rate-limited per donor address to prevent enumeration/spam
router.post("/follow", notificationLimiter, async (req, res, next) => {
  try {
    const { projectId, token, walletAddress } = req.body;

    if (!projectId || typeof projectId !== "string") {
      throw createApiError(400, "PROJECT_ID_REQUIRED", "projectId is required");
    }
    if (!token || typeof token !== "string") {
      throw createApiError(400, "TOKEN_REQUIRED", "token is required");
    }

    // Get device token ID
    const tokenResult = await pool.query(
      "SELECT id FROM device_tokens WHERE token = $1",
      [token]
    );

    if (!tokenResult.rows[0]) {
      throw createApiError(404, "DEVICE_TOKEN_NOT_FOUND", "Device token not found. Please register first.");
    }

    const deviceId = tokenResult.rows[0].id;

    // Check if project exists
    const projectResult = await pool.query(
      "SELECT id FROM projects WHERE id = $1",
      [projectId]
    );

    if (!projectResult.rows[0]) {
      throw createApiError(404, "PROJECT_NOT_FOUND", "Project not found");
    }

    // Check if already following
    const existingFollow = await pool.query(
      "SELECT * FROM project_follows WHERE project_id = $1 AND device_token_id = $2",
      [projectId, deviceId]
    );

    if (existingFollow.rows[0]) {
      return res.json({ message: "Already following this project" });
    }

    // Create follow relationship
    const followId = uuidv4();
    await pool.query(
      `INSERT INTO project_follows (id, project_id, device_token_id, wallet_address)
       VALUES ($1, $2, $3, $4)`,
      [followId, projectId, deviceId, walletAddress || null]
    );

    res.status(201).json({ followId });
  } catch (e) {
    next(e);
  }
});

// POST /api/notifications/unfollow
// Unfollow a project
// Rate-limited per donor address to prevent enumeration/spam
router.post("/unfollow", notificationLimiter, async (req, res, next) => {
  try {
    const { projectId, token } = req.body;

    if (!projectId || typeof projectId !== "string") {
      throw createApiError(400, "PROJECT_ID_REQUIRED", "projectId is required");
    }
    if (!token || typeof token !== "string") {
      throw createApiError(400, "TOKEN_REQUIRED", "token is required");
    }

    // Get device token ID
    const tokenResult = await pool.query(
      "SELECT id FROM device_tokens WHERE token = $1",
      [token]
    );

    if (!tokenResult.rows[0]) {
      throw createApiError(404, "DEVICE_TOKEN_NOT_FOUND", "Device token not found");
    }

    const deviceId = tokenResult.rows[0].id;

    // Delete follow relationship
    const result = await pool.query(
      "DELETE FROM project_follows WHERE project_id = $1 AND device_token_id = $2",
      [projectId, deviceId]
    );

    res.json({ deleted: result.rowCount > 0 });
  } catch (e) {
    next(e);
  }
});

const { decodeCursor, formatPaginatedResponse } = require("../utils/pagination");

// GET /api/notifications/follows
// Get all projects followed by a device
router.get("/follows", async (req, res, next) => {
  try {
    const { token, cursor } = req.query;
    const parsedLimit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

    if (!token || typeof token !== "string") {
      throw createApiError(400, "TOKEN_REQUIRED", "token query parameter is required");
    }

    // Get device token ID
    const tokenResult = await pool.query(
      "SELECT id FROM device_tokens WHERE token = $1",
      [token]
    );

    if (!tokenResult.rows[0]) {
      throw createApiError(404, "DEVICE_TOKEN_NOT_FOUND", "Device token not found");
    }

    const deviceId = tokenResult.rows[0].id;
    const cursorObj = decodeCursor(cursor);

    const where = ["pf.device_token_id = $1"];
    const values = [deviceId];

    if (cursorObj) {
      if (cursorObj.createdAt && cursorObj.projectId) {
        values.push(cursorObj.createdAt, cursorObj.projectId);
        where.push(`(pf.created_at, pf.project_id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
      } else if (cursorObj.createdAt) {
        values.push(cursorObj.createdAt);
        where.push(`pf.created_at < $${values.length}::timestamptz`);
      }
    }

    values.push(parsedLimit + 1);
    const query = `SELECT p.id, p.name, p.category, p.location, p.description, pf.created_at as followed_at
       FROM project_follows pf
       JOIN projects p ON pf.project_id = p.id
       WHERE ${where.join(" AND ")}
       ORDER BY pf.created_at DESC, pf.project_id DESC
       LIMIT $${values.length}`;

    const result = await pool.query(query, values);
    const { data, meta } = formatPaginatedResponse({
      rows: result.rows,
      limit: parsedLimit,
      getCursorPayload: (row) => ({
        createdAt: row.followed_at,
        projectId: row.id,
      }),
    });

    res.apiMeta(meta);
    res.json(data);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
