"use strict";
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { signToken, adminRequired } = require("../middleware/auth");
const { createRateLimiter } = require("../middleware/rateLimiter");
const { validate } = require("../middleware/validate");
const { createApiError } = require("../middleware/apiEnvelope");
const { AdminLoginSchema, AdminRefreshSchema, AdminAuditQuerySchema } = require("../schemas/admin");
const { logAdminAction } = require("../services/audit");
const { enqueueAISummary } = require("../services/summaryQueue");

const loginLimiter = createRateLimiter(10, 15, "admin-login");

const TOKEN_EXPIRY = "1h";
const REFRESH_EXPIRY = "24h";

router.post("/login", loginLimiter, validate(AdminLoginSchema), (req, res) => {
  const { username, password } = req.body || {};
  const adminUser = process.env.ADMIN_USERNAME || "admin";
  const adminPass = process.env.ADMIN_PASSWORD;

  if (!adminPass) {
    throw createApiError(503, "ADMIN_AUTH_NOT_CONFIGURED", "Admin authentication not configured on this server");
  }

  if (username !== adminUser || password !== adminPass) {
    throw createApiError(401, "INVALID_CREDENTIALS", "Invalid credentials");
  }

  const token = signToken({ role: "admin", sub: adminUser }, TOKEN_EXPIRY);
  const refreshToken = signToken({ role: "admin", sub: adminUser, type: "refresh" }, REFRESH_EXPIRY);

  res.json({
    token,
    refreshToken,
    expiresIn: 3600,
  });
});

router.get("/audit", adminRequired, validate(AdminAuditQuerySchema, { source: "query" }), async (req, res, next) => {
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

    res.apiMeta({
      pagination: {
        total: parseInt(countResult.rows[0].total, 10),
        limit: Number.parseInt(limit, 10) || 50,
        offset: Number.parseInt(offset, 10) || 0,
      },
    });
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/admin/ai-summary-failures
 *
 * Operator view of AI summary generation jobs that exhausted every pg-boss
 * retry and were recorded by summaryQueue's recordPermanentFailure. Without
 * this a permanently-failed job is only visible by querying pg-boss's own
 * tables directly.
 */
router.get("/ai-summary-failures", adminRequired, async (req, res, next) => {
  try {
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);

    const result = await pool.query(
      `SELECT id, project_id, payload, error_message, error_stack, status, created_at, resolved_at
       FROM ai_summary_job_failures
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    const countResult = await pool.query(
      "SELECT COUNT(*) AS total FROM ai_summary_job_failures",
    );

    const rows = result.rows.map(row => ({
      id: row.id,
      projectId: row.project_id,
      payload: row.payload || {},
      errorMessage: row.error_message,
      errorStack: row.error_stack,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
      resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    }));

    res.apiMeta({
      pagination: {
        total: parseInt(countResult.rows[0].total, 10),
        limit,
        offset,
      },
    });
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/admin/ai-summary-failures/:id/retry
 *
 * Re-enqueues a permanently-failed summary job from its recorded payload and
 * marks the failure retried, so the same record cannot be replayed twice.
 */
router.post("/ai-summary-failures/:id/retry", adminRequired, async (req, res, next) => {
  try {
    const failureResult = await pool.query(
      "SELECT id, project_id, payload, status FROM ai_summary_job_failures WHERE id = $1",
      [req.params.id],
    );
    const failure = failureResult.rows[0];
    if (!failure) {
      throw createApiError(404, "AI_SUMMARY_FAILURE_NOT_FOUND", "Failure record not found");
    }
    if (failure.status === "retried") {
      throw createApiError(409, "AI_SUMMARY_FAILURE_ALREADY_RETRIED", "Failure has already been retried");
    }

    await enqueueAISummary(failure.project_id, failure.payload || {});

    await pool.query(
      `UPDATE ai_summary_job_failures
       SET status = 'retried',
           resolved_at = NOW()
       WHERE id = $1`,
      [failure.id],
    );

    logAdminAction({
      actor: req.admin.sub,
      action: "ai_summary.failure.retried",
      targetType: "ai_summary_job_failure",
      targetId: failure.id,
      metadata: { projectId: failure.project_id },
      ipAddress: req.ip,
    });

    res.json({ status: "retried" });
  } catch (e) {
    next(e);
  }
});

router.post("/refresh", validate(AdminRefreshSchema), (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) {
    throw createApiError(400, "REFRESH_TOKEN_REQUIRED", "refreshToken is required");
  }

  try {
    const decoded = require("../middleware/auth").verifyToken(refreshToken);
    if (decoded.type !== "refresh") {
      throw createApiError(401, "INVALID_REFRESH_TOKEN", "Invalid refresh token");
    }
    const token = signToken({ role: "admin", sub: decoded.sub }, TOKEN_EXPIRY);
    res.json({ token, expiresIn: 3600 });
  } catch {
    throw createApiError(401, "INVALID_REFRESH_TOKEN", "Invalid or expired refresh token");
  }
});

router.get("/me", adminRequired, (req, res) => {
  res.json({
    username: req.admin.sub,
    role: req.admin.role,
  });
});

module.exports = router;
