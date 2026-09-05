"use strict";
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { signToken, adminRequired } = require("../middleware/auth");
const { createRateLimiter, createLayeredRateLimiter } = require("../middleware/rateLimiter");
const { createProgressiveDelay } = require("../middleware/progressiveDelay");
const { validate } = require("../middleware/validate");
const { createApiError } = require("../middleware/apiEnvelope");
const { AdminLoginSchema, AdminRefreshSchema, AdminAuditQuerySchema } = require("../schemas/admin");
const { logAdminAction } = require("../services/audit");
const { enqueueAISummary } = require("../services/summaryQueue");
const { env } = require("../config/env");
const { getUsageSnapshot } = require("../middleware/apiUsage");

// Per-IP floor on login attempts (10 per 15 minutes per address). The real
// anti-brute-force barrier is the per-account progressive delay below, which
// follows the attempted username across any number of source addresses.
const loginLimiter = createRateLimiter(10, 15, "admin-login");

// Progressive delay keyed on the account being attempted: delays kick in after
// a handful of failures and grow exponentially, so a distributed attack that
// rotates IPs is still throttled per account, and a successful login resets
// the counter.
const loginAccountDelay = createProgressiveDelay();

// Bounds every authenticated admin operation per subject (not per IP) so the
// same admin session is constrained regardless of its source address.
const adminSubjectLimiter = createRateLimiter(120, 1, "admin-subject", { keyBy: "subject" });

// Replaying a permanently-failed AI summary job enqueues a paid Claude call,
// so beyond the subject cap this endpoint also carries a global cap that no
// number of distinct clients can exceed.
const summaryRetryLimiter = createLayeredRateLimiter({
  name: "admin-summary-retry",
  windowMinutes: 1,
  ip: 30,
  subject: 10,
  global: 10,
});

const TOKEN_EXPIRY = "1h";
const REFRESH_EXPIRY = "24h";

router.post("/login", loginLimiter, loginAccountDelay, validate(AdminLoginSchema), (req, res) => {
  const { username, password } = req.body || {};

  if (!env.adminPassword) {
    throw createApiError(503, "ADMIN_AUTH_NOT_CONFIGURED", "Admin authentication not configured on this server");
  }

  if (username !== env.adminUsername || password !== env.adminPassword) {
    throw createApiError(401, "INVALID_CREDENTIALS", "Invalid credentials");
  }

  const token = signToken({ role: "admin", sub: env.adminUsername }, TOKEN_EXPIRY);
  const refreshToken = signToken({ role: "admin", sub: env.adminUsername, type: "refresh" }, REFRESH_EXPIRY);

  res.json({
    token,
    refreshToken,
    expiresIn: 3600,
  });
});

const { decodeCursor, formatPaginatedResponse } = require("../utils/pagination");

// Ceiling on the deprecated `offset` path. Matches the bound AdminAuditQuerySchema
// and LeaderboardQuerySchema already enforce, and exists for the same reason the
// cursor path replaced offsets: a deep offset makes Postgres walk and discard every
// skipped row, so an unbounded one is an arbitrarily expensive query for a caller
// to ask for. Requests past it are clamped rather than rejected, so an old client
// paging deep gets a slow-but-correct answer instead of an error.
const MAX_OFFSET = 10000;

// Live operational view of client/version adoption. Durable history comes
// from the matching `event=api_request` structured log records.
router.get("/api-usage", adminRequired, adminSubjectLimiter, (_req, res) => {
  res.json(getUsageSnapshot());
});

router.get("/audit", adminRequired, adminSubjectLimiter, validate(AdminAuditQuerySchema, { source: "query" }), async (req, res, next) => {
  try {
    const { actor, action, cursor, offset } = req.query;
    const parsedLimit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);
    const parsedOffset = Math.min(Math.max(Number.parseInt(offset, 10) || 0, 0), MAX_OFFSET);
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

    // The count reflects the actor/action filters only. Snapshotting the
    // values here — before the keyset predicate is appended — is what keeps
    // `total` the size of the filtered set rather than the size of what is
    // left after the cursor, which would shrink on every page.
    const countValues = [...values];
    const countWhereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const cursorObj = decodeCursor(cursor);
    let useOffset = false;

    if (cursorObj) {
      if (cursorObj.createdAt && cursorObj.id) {
        values.push(cursorObj.createdAt, cursorObj.id);
        where.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
      } else if (cursorObj.createdAt) {
        values.push(cursorObj.createdAt);
        where.push(`created_at < $${values.length}::timestamptz`);
      }
    } else if (parsedOffset > 0) {
      useOffset = true;
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    let query;
    if (useOffset) {
      values.push(parsedLimit + 1, parsedOffset);
      query = `SELECT id, actor, action, target_type, target_id, metadata, ip_address, created_at
       FROM admin_audit_log ${whereClause}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`;
    } else {
      values.push(parsedLimit + 1);
      query = `SELECT id, actor, action, target_type, target_id, metadata, ip_address, created_at
       FROM admin_audit_log ${whereClause}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length}`;
    }

    const result = await pool.query(query, values);
    const countResult = await pool.query(
      `SELECT COUNT(*) AS total FROM admin_audit_log ${countWhereClause}`,
      countValues,
    );
    const totalCount = parseInt(countResult.rows[0].total, 10);

    const { data, meta } = formatPaginatedResponse({
      rows: result.rows,
      limit: parsedLimit,
      getCursorPayload: (row) => ({ createdAt: row.created_at, id: row.id }),
      totalCount,
      isTotalExact: true,
    });

    const rows = data.map(row => ({
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
      ...meta,
      pagination: {
        ...meta.pagination,
        total: totalCount,
        offset: parsedOffset,
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
router.get("/ai-summary-failures", adminRequired, adminSubjectLimiter, async (req, res, next) => {
  try {
    const { cursor, offset } = req.query;
    const parsedLimit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);
    const parsedOffset = Math.min(Math.max(Number.parseInt(offset, 10) || 0, 0), MAX_OFFSET);

    const cursorObj = decodeCursor(cursor);
    const where = [];
    const values = [];

    let useOffset = false;
    if (cursorObj) {
      if (cursorObj.createdAt && cursorObj.id) {
        values.push(cursorObj.createdAt, cursorObj.id);
        where.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
      } else if (cursorObj.createdAt) {
        values.push(cursorObj.createdAt);
        where.push(`created_at < $${values.length}::timestamptz`);
      }
    } else if (parsedOffset > 0) {
      useOffset = true;
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    let query;
    if (useOffset) {
      values.push(parsedLimit + 1, parsedOffset);
      query = `SELECT id, project_id, payload, error_message, error_stack, status, created_at, resolved_at
       FROM ai_summary_job_failures ${whereClause}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`;
    } else {
      values.push(parsedLimit + 1);
      query = `SELECT id, project_id, payload, error_message, error_stack, status, created_at, resolved_at
       FROM ai_summary_job_failures ${whereClause}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length}`;
    }

    const result = await pool.query(query, values);
    const countResult = await pool.query(
      "SELECT COUNT(*) AS total FROM ai_summary_job_failures",
    );
    const totalCount = parseInt(countResult.rows[0].total, 10);

    const { data, meta } = formatPaginatedResponse({
      rows: result.rows,
      limit: parsedLimit,
      getCursorPayload: (row) => ({ createdAt: row.created_at, id: row.id }),
      totalCount,
      isTotalExact: true,
    });

    const rows = data.map(row => ({
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
      ...meta,
      pagination: {
        ...meta.pagination,
        total: totalCount,
        offset: parsedOffset,
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
router.post("/ai-summary-failures/:id/retry", adminRequired, summaryRetryLimiter, async (req, res, next) => {
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

router.get("/me", adminRequired, adminSubjectLimiter, (req, res) => {
  res.json({
    username: req.admin.sub,
    role: req.admin.role,
  });
});

module.exports = router;
