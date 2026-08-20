"use strict";
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { signToken, adminRequired } = require("../middleware/auth");
const { createRateLimiter } = require("../middleware/rateLimiter");

const loginLimiter = createRateLimiter(10, 15, "admin-login");

const TOKEN_EXPIRY = "1h";
const REFRESH_EXPIRY = "24h";

router.post("/login", loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const adminUser = process.env.ADMIN_USERNAME || "admin";
  const adminPass = process.env.ADMIN_PASSWORD;

  if (!adminPass) {
    return res.status(503).json({ error: "Admin authentication not configured on this server" });
  }

  if (username !== adminUser || password !== adminPass) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = signToken({ role: "admin", sub: adminUser }, TOKEN_EXPIRY);
  const refreshToken = signToken({ role: "admin", sub: adminUser, type: "refresh" }, REFRESH_EXPIRY);

  res.json({
    success: true,
    data: {
      token,
      refreshToken,
      expiresIn: 3600,
    },
  });
});

router.get("/audit", adminRequired, async (req, res, next) => {
  try {
    const { actor, action, limit = 50, offset = 0 } = req.query;
    const where = [];
    const values = [];

    if (actor) {
      values.push(actor);
      where.push(`actor = $${values.length}`);
    }
    if (action) {
      values.push(action);
      where.push(`action = $${values.length}`);
    }

    values.push(Math.min(Number.parseInt(limit, 10) || 50, 200));
    values.push(Math.max(Number.parseInt(offset, 10) || 0, 0));

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT id, actor, action, target_type, target_id, metadata, ip_address, created_at
       FROM admin_audit_log ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) AS total FROM admin_audit_log ${whereClause}`,
      values.slice(0, -2),
    );

    const rows = result.rows.map(row => ({
      id: row.id,
      actor: row.actor,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      metadata: row.metadata,
      ipAddress: row.ip_address,
      createdAt: new Date(row.created_at).toISOString(),
    }));

    res.json({
      success: true,
      data: rows,
      pagination: {
        total: parseInt(countResult.rows[0].total, 10),
        limit: Number.parseInt(limit, 10) || 50,
        offset: Number.parseInt(offset, 10) || 0,
      },
    });
  } catch (e) {
    next(e);
  }
});

router.post("/refresh", (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) {
    return res.status(400).json({ error: "refreshToken is required" });
  }

  try {
    const decoded = require("../middleware/auth").verifyToken(refreshToken);
    if (decoded.type !== "refresh") {
      return res.status(401).json({ error: "Invalid refresh token" });
    }
    const token = signToken({ role: "admin", sub: decoded.sub }, TOKEN_EXPIRY);
    res.json({
      success: true,
      data: { token, expiresIn: 3600 },
    });
  } catch {
    return res.status(401).json({ error: "Invalid or expired refresh token" });
  }
});

router.get("/me", adminRequired, (req, res) => {
  res.json({
    success: true,
    data: {
      username: req.admin.sub,
      role: req.admin.role,
    },
  });
});

module.exports = router;
