/**
 * Project update publication, moderation, reporting, history, and reactions.
 *
 * New updates from fully verified projects are visible while awaiting review;
 * all other projects use pre-publication review. Subscriber notifications are
 * held until approval in both cases.
 */
"use strict";

const express = require("express");
const { v4: uuidv4 } = require("uuid");
const pool = require("../db/pool");
const { adminRequired } = require("../middleware/auth");
const { createApiError } = require("../middleware/apiEnvelope");
const { createRateLimiter, createLayeredRateLimiter } = require("../middleware/rateLimiter");
const { STELLAR_PUBLIC_KEY, UUID } = require("../schemas/common");
const { mapProjectUpdateRow } = require("../services/store");
const { requireContentLanguage, updateLocalizationSelect } = require("../services/contentLanguage");
const {
  dispatchPublicationNotifications,
  dispatchRemovalNotifications,
} = require("../services/updateNotifications");
const { decodeCursor, formatPaginatedResponse } = require("../utils/pagination");

const router = express.Router();

const PUBLIC_STATUSES = ["published", "published_pending_review"];
const QUEUE_STATUSES = ["pending", "published_pending_review", "appealed"];
const REPORT_REASONS = new Set([
  "fraudulent_claim", "abuse", "spam", "off_topic_solicitation",
  "dangerous_content", "privacy", "other",
]);

const updateCreationLimiter = createLayeredRateLimiter({
  name: "update-create", windowMinutes: 60, ip: 30, subject: 5,
});
const projectPostingLimiter = createRateLimiter(3, 60, "update-create-project", {
  keyBy: (req) => {
    const id = req.body?.projectId;
    return `project:${typeof id === "string" && UUID.test(id) ? id : "unknown"}`;
  },
});
const updateEditLimiter = createLayeredRateLimiter({
  name: "update-edit", windowMinutes: 60, ip: 30, subject: 10,
});
const reportLimiter = createLayeredRateLimiter({
  name: "update-report", windowMinutes: 24 * 60, ip: 20, wallet: 5,
});
const likeLimiter = createLayeredRateLimiter({
  name: "update-like", windowMinutes: 1, ip: 60, wallet: 20,
});
const moderationLimiter = createLayeredRateLimiter({
  name: "update-moderation", windowMinutes: 60, ip: 120, subject: 60,
});

function requireUuid(value, field) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw createApiError(400, "INVALID_IDENTIFIER", `${field} must be a UUID`);
  }
  return value;
}

function requireText(value, field, maxLength, minLength = 1) {
  if (typeof value !== "string" || value.trim().length < minLength) {
    throw createApiError(400, `${field.toUpperCase()}_REQUIRED`, `${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw createApiError(400, `${field.toUpperCase()}_TOO_LONG`, `${field} must be at most ${maxLength} characters`);
  }
  return trimmed;
}

function adminActor(req) {
  return typeof req.admin?.sub === "string" && req.admin.sub
    ? req.admin.sub.slice(0, 256)
    : "admin";
}

function projectFromJoinedRow(row) {
  return {
    id: row.project_id,
    name: row.project_name,
    verified: row.project_verified,
    onChainVerified: row.project_on_chain_verified,
  };
}

async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertModerationEvent(client, event) {
  await client.query(
    `INSERT INTO project_update_moderation_events (
       id, update_id, actor, actor_type, action, from_status, to_status, reason, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      uuidv4(), event.updateId, event.actor, event.actorType, event.action,
      event.fromStatus, event.toStatus, event.reason, JSON.stringify(event.metadata || {}),
    ],
  );
}

function runNotification(promise, label) {
  promise.catch((error) => console.error(`[updates] ${label}:`, error.message));
}

router.get("/moderation/queue", adminRequired, moderationLimiter, async (req, res, next) => {
  try {
    const statuses = req.query.status ? [req.query.status] : QUEUE_STATUSES;
    if (statuses.some((status) => !QUEUE_STATUSES.includes(status))) {
      throw createApiError(400, "INVALID_MODERATION_STATUS", "Unsupported moderation queue status");
    }
    const result = await pool.query(
      `SELECT u.*, p.name AS project_name,
              COUNT(r.id) FILTER (WHERE r.status = 'open')::int AS open_report_count
       FROM project_updates u
       JOIN projects p ON p.id = u.project_id
       LEFT JOIN project_update_reports r ON r.update_id = u.id
       WHERE u.moderation_status = ANY($1::text[])
       GROUP BY u.id, p.name
       ORDER BY open_report_count DESC, u.created_at ASC
       LIMIT 200`,
      [statuses],
    );
    res.json(result.rows.map((row) => ({
      ...mapProjectUpdateRow(row),
      projectName: row.project_name,
      openReportCount: row.open_report_count,
      moderationReason: row.moderation_reason || null,
      moderationActor: row.moderation_actor || null,
    })));
  } catch (error) {
    next(error);
  }
});

router.get("/moderation/appeals", adminRequired, moderationLimiter, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT a.*, u.title, u.project_id
       FROM project_update_appeals a
       JOIN project_updates u ON u.id = a.update_id
       WHERE a.status = 'pending'
       ORDER BY a.created_at ASC LIMIT 200`,
    );
    res.json(result.rows.map((row) => ({
      id: row.id,
      updateId: row.update_id,
      projectId: row.project_id,
      updateTitle: row.title,
      filedBy: row.filed_by,
      reason: row.reason,
      priorStatus: row.prior_status,
      status: row.status,
      createdAt: row.created_at,
    })));
  } catch (error) {
    next(error);
  }
});

router.post("/appeals/:appealId/decision", adminRequired, moderationLimiter, async (req, res, next) => {
  try {
    const appealId = requireUuid(req.params.appealId, "appealId");
    const outcome = req.body?.outcome;
    if (!["granted", "denied"].includes(outcome)) {
      throw createApiError(400, "INVALID_APPEAL_OUTCOME", "outcome must be granted or denied");
    }
    const reason = requireText(req.body?.reason, "reason", 2000, 10);
    const actor = adminActor(req);

    const decision = await withTransaction(async (client) => {
      const result = await client.query(
        `SELECT a.id AS appeal_id, a.update_id, a.filed_by, a.prior_status,
                a.status AS appeal_status, u.*, p.name AS project_name,
                p.verified AS project_verified,
                p.on_chain_verified AS project_on_chain_verified
         FROM project_update_appeals a
         JOIN project_updates u ON u.id = a.update_id
         JOIN projects p ON p.id = u.project_id
         WHERE a.id = $1 FOR UPDATE OF a, u`,
        [appealId],
      );
      const row = result.rows[0];
      if (!row) throw createApiError(404, "APPEAL_NOT_FOUND", "Appeal not found");
      if (row.appeal_status !== "pending") {
        throw createApiError(409, "APPEAL_ALREADY_DECIDED", "Appeal has already been decided");
      }
      if (row.filed_by === actor) {
        throw createApiError(409, "INDEPENDENT_REVIEW_REQUIRED", "A different moderator must decide the appeal");
      }
      const toStatus = outcome === "granted" ? "published" : row.prior_status;
      await client.query(
        `UPDATE project_update_appeals
         SET status = $2, decided_by = $3, decision_reason = $4, decided_at = NOW()
         WHERE id = $1`,
        [appealId, outcome, actor, reason],
      );
      const updated = await client.query(
        `UPDATE project_updates
         SET moderation_status = $2, moderation_reason = $3,
             moderation_actor = $4, moderation_updated_at = NOW(),
             published_at = CASE WHEN $2 = 'published' THEN COALESCE(published_at, NOW()) ELSE published_at END,
             removed_at = CASE WHEN $2 = 'published' THEN NULL ELSE removed_at END
         WHERE id = $1 RETURNING *`,
        [row.update_id, toStatus, reason, actor],
      );
      await insertModerationEvent(client, {
        updateId: row.update_id,
        actor,
        actorType: "moderator",
        action: outcome === "granted" ? "appeal_granted" : "appeal_denied",
        fromStatus: "appealed",
        toStatus,
        reason,
        metadata: { appealId },
      });
      return { update: mapProjectUpdateRow(updated.rows[0]), project: projectFromJoinedRow(row) };
    });

    if (outcome === "granted") {
      runNotification(dispatchPublicationNotifications(decision), "Failed to queue appeal publication notifications");
    }
    res.json({ ...decision.update, appealOutcome: outcome });
  } catch (error) {
    next(error);
  }
});

router.get("/:updateId/moderation-history", adminRequired, moderationLimiter, async (req, res, next) => {
  try {
    const updateId = requireUuid(req.params.updateId, "updateId");
    const result = await pool.query(
      `SELECT id, actor, actor_type, action, from_status, to_status, reason, metadata, created_at
       FROM project_update_moderation_events WHERE update_id = $1
       ORDER BY created_at ASC, id ASC`,
      [updateId],
    );
    res.json(result.rows.map((row) => ({
      id: row.id,
      actor: row.actor,
      actorType: row.actor_type,
      action: row.action,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      reason: row.reason,
      metadata: row.metadata || {},
      createdAt: row.created_at,
    })));
  } catch (error) {
    next(error);
  }
});

router.get("/:updateId/history", async (req, res, next) => {
  try {
    const updateId = requireUuid(req.params.updateId, "updateId");
    const current = await pool.query(
      `SELECT id, revision, edited_at FROM project_updates
       WHERE id = $1 AND moderation_status = ANY($2::text[])`,
      [updateId, PUBLIC_STATUSES],
    );
    if (!current.rows[0]) throw createApiError(404, "UPDATE_NOT_FOUND", "Published update not found");
    const result = await pool.query(
      `SELECT revision, title, body, source_language, edit_reason, created_at
       FROM project_update_revisions
       WHERE update_id = $1 AND was_public IS TRUE AND content_visible IS TRUE
       ORDER BY revision DESC`,
      [updateId],
    );
    res.json({
      currentRevision: Number(current.rows[0].revision),
      editedAt: current.rows[0].edited_at,
      revisions: result.rows.map((row) => ({
        revision: Number(row.revision),
        title: row.title,
        body: row.body,
        sourceLanguage: row.source_language,
        editReason: row.edit_reason,
        replacedAt: row.created_at,
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/", adminRequired, updateCreationLimiter, projectPostingLimiter, async (req, res, next) => {
  try {
    const projectId = requireUuid(req.body?.projectId, "projectId");
    const title = requireText(req.body?.title, "title", 200);
    const body = requireText(req.body?.body, "body", 20000);
    const sourceLanguage = req.body?.sourceLanguage === undefined
      ? "en"
      : requireContentLanguage(req.body.sourceLanguage);
    const actor = adminActor(req);

    const update = await withTransaction(async (client) => {
      const projectResult = await client.query(
        "SELECT id, name, verified, on_chain_verified FROM projects WHERE id = $1",
        [projectId],
      );
      const project = projectResult.rows[0];
      if (!project) throw createApiError(404, "PROJECT_NOT_FOUND", "Project not found");
      const trusted = project.verified === true && project.on_chain_verified === true;
      const status = trusted ? "published_pending_review" : "pending";
      const id = uuidv4();
      const insertResult = await client.query(
        `INSERT INTO project_updates (
           id, project_id, title, body, source_language, moderation_status,
           moderation_updated_at, created_by, published_at
         ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7,
                   CASE WHEN $6 = 'published_pending_review' THEN NOW() ELSE NULL END)
         RETURNING *`,
        [id, projectId, title, body, sourceLanguage, status, actor],
      );
      await insertModerationEvent(client, {
        updateId: id,
        actor,
        actorType: "project_admin",
        action: "created",
        fromStatus: null,
        toStatus: status,
        reason: trusted
          ? "Trusted project: visible during post-publication review; notifications held"
          : "Standard project: pre-publication review required",
        metadata: { trustedAtCreation: trusted },
      });
      return mapProjectUpdateRow(insertResult.rows[0]);
    });
    res.status(201).json(update);
  } catch (error) {
    next(error);
  }
});

router.patch("/:updateId", adminRequired, updateEditLimiter, async (req, res, next) => {
  try {
    const updateId = requireUuid(req.params.updateId, "updateId");
    const title = req.body?.title === undefined ? null : requireText(req.body.title, "title", 200);
    const body = req.body?.body === undefined ? null : requireText(req.body.body, "body", 20000);
    if (title === null && body === null) {
      throw createApiError(400, "UPDATE_FIELDS_REQUIRED", "title or body is required");
    }
    const editReason = requireText(req.body?.editReason, "editReason", 1000, 5);
    const actor = adminActor(req);

    const update = await withTransaction(async (client) => {
      const currentResult = await client.query(
        "SELECT * FROM project_updates WHERE id = $1 FOR UPDATE",
        [updateId],
      );
      const current = currentResult.rows[0];
      if (!current) throw createApiError(404, "UPDATE_NOT_FOUND", "Update not found");
      if (["rejected", "removed", "appealed"].includes(current.moderation_status)) {
        throw createApiError(409, "UPDATE_NOT_EDITABLE", "Resolve the moderation decision before editing");
      }
      const wasPublic = PUBLIC_STATUSES.includes(current.moderation_status);
      const nextStatus = wasPublic ? "published_pending_review" : "pending";
      await client.query(
        `INSERT INTO project_update_revisions (
           id, update_id, revision, title, body, source_language,
           moderation_status, was_public, edited_by, edit_reason
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          uuidv4(), updateId, current.revision, current.title, current.body,
          current.source_language, current.moderation_status, wasPublic, actor, editReason,
        ],
      );
      const updated = await client.query(
        `UPDATE project_updates
         SET title = COALESCE($2, title), body = COALESCE($3, body),
             revision = revision + 1, edited_at = NOW(), moderation_status = $4,
             moderation_reason = NULL, moderation_actor = NULL, moderation_updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [updateId, title, body, nextStatus],
      );
      await insertModerationEvent(client, {
        updateId,
        actor,
        actorType: "project_admin",
        action: "edited",
        fromStatus: current.moderation_status,
        toStatus: nextStatus,
        reason: editReason,
        metadata: { fromRevision: current.revision, toRevision: Number(current.revision) + 1 },
      });
      return mapProjectUpdateRow(updated.rows[0]);
    });
    res.json(update);
  } catch (error) {
    next(error);
  }
});

router.post("/:updateId/moderation", adminRequired, moderationLimiter, async (req, res, next) => {
  try {
    const updateId = requireUuid(req.params.updateId, "updateId");
    const action = req.body?.action;
    const reason = requireText(req.body?.reason, "reason", 2000, 10);
    const actor = adminActor(req);
    let transition = null;
    if (action === "approve") {
      transition = { from: ["pending", "published_pending_review"], to: "published", event: "approved" };
    } else if (action === "reject") {
      transition = { from: ["pending"], to: "rejected", event: "rejected" };
    } else if (action === "remove") {
      transition = { from: ["published", "published_pending_review"], to: "removed", event: "removed" };
    } else if (action === "reinstate") {
      transition = { from: ["removed"], to: "published", event: "reinstated" };
    }
    if (!transition) {
      throw createApiError(400, "INVALID_MODERATION_ACTION", "action must be approve, reject, remove, or reinstate");
    }

    const decision = await withTransaction(async (client) => {
      const result = await client.query(
        `SELECT u.*, p.name AS project_name,
                p.verified AS project_verified,
                p.on_chain_verified AS project_on_chain_verified
         FROM project_updates u JOIN projects p ON p.id = u.project_id
         WHERE u.id = $1 FOR UPDATE OF u`,
        [updateId],
      );
      const current = result.rows[0];
      if (!current) throw createApiError(404, "UPDATE_NOT_FOUND", "Update not found");
      if (!transition.from.includes(current.moderation_status)) {
        throw createApiError(409, "INVALID_MODERATION_TRANSITION", `${action} is not valid from ${current.moderation_status}`);
      }
      const updated = await client.query(
        `UPDATE project_updates
         SET moderation_status = $2, moderation_reason = $3,
             moderation_actor = $4, moderation_updated_at = NOW(),
             published_at = CASE WHEN $2 = 'published' THEN COALESCE(published_at, NOW()) ELSE published_at END,
             removed_at = CASE WHEN $2 = 'removed' THEN NOW()
                               WHEN $2 = 'published' THEN NULL ELSE removed_at END
         WHERE id = $1 RETURNING *`,
        [updateId, transition.to, reason, actor],
      );
      await insertModerationEvent(client, {
        updateId,
        actor,
        actorType: "moderator",
        action: transition.event,
        fromStatus: current.moderation_status,
        toStatus: transition.to,
        reason,
      });
      await client.query(
        `UPDATE project_update_reports
         SET status = $2, reviewed_by = $3, reviewed_at = NOW(), resolution = $4
         WHERE update_id = $1 AND status = 'open'`,
        [
          updateId,
          action === "remove" || action === "reject" ? "actioned" : "reviewed",
          actor,
          reason,
        ],
      );
      return { update: mapProjectUpdateRow(updated.rows[0]), project: projectFromJoinedRow(current) };
    });

    if (["approve", "reinstate"].includes(action)) {
      runNotification(dispatchPublicationNotifications(decision), "Failed to queue publication notifications");
    } else if (action === "remove") {
      runNotification(
        dispatchRemovalNotifications({ ...decision, reason }),
        "Failed to queue removal follow-up notifications",
      );
    }
    res.json(decision.update);
  } catch (error) {
    next(error);
  }
});

router.post("/:updateId/notifications/retry", adminRequired, moderationLimiter, async (req, res, next) => {
  try {
    const updateId = requireUuid(req.params.updateId, "updateId");
    const result = await pool.query(
      `SELECT u.*, p.name AS project_name,
              p.verified AS project_verified,
              p.on_chain_verified AS project_on_chain_verified
       FROM project_updates u JOIN projects p ON p.id = u.project_id
       WHERE u.id = $1 AND u.moderation_status = 'published'`,
      [updateId],
    );
    const row = result.rows[0];
    if (!row) throw createApiError(404, "PUBLISHED_UPDATE_NOT_FOUND", "Published update not found");
    await dispatchPublicationNotifications({
      project: projectFromJoinedRow(row),
      update: mapProjectUpdateRow(row),
    });
    res.json({ message: "Missing notification channels queued" });
  } catch (error) {
    next(error);
  }
});

router.get("/:updateId/reports", adminRequired, moderationLimiter, async (req, res, next) => {
  try {
    const updateId = requireUuid(req.params.updateId, "updateId");
    const result = await pool.query(
      `SELECT id, reporter_address, reason, details, status,
              reviewed_by, reviewed_at, resolution, created_at
       FROM project_update_reports WHERE update_id = $1
       ORDER BY created_at ASC, id ASC`,
      [updateId],
    );
    res.json(result.rows.map((row) => ({
      id: row.id,
      reporterAddress: row.reporter_address,
      reason: row.reason,
      details: row.details,
      status: row.status,
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at,
      resolution: row.resolution,
      createdAt: row.created_at,
    })));
  } catch (error) {
    next(error);
  }
});

router.post("/:updateId/reports", reportLimiter, async (req, res, next) => {
  try {
    const updateId = requireUuid(req.params.updateId, "updateId");
    const donorAddress = typeof req.body?.donorAddress === "string"
      ? req.body.donorAddress.trim().toUpperCase()
      : "";
    if (!STELLAR_PUBLIC_KEY.test(donorAddress)) {
      throw createApiError(400, "INVALID_DONOR_ADDRESS", "donorAddress must be a Stellar public key");
    }
    const reason = req.body?.reason;
    if (!REPORT_REASONS.has(reason)) {
      throw createApiError(400, "INVALID_REPORT_REASON", "Unsupported report reason");
    }
    const details = req.body?.details === undefined || req.body.details === ""
      ? null
      : requireText(req.body.details, "details", 2000, 5);
    const eligibility = await pool.query(
      `SELECT u.id,
              EXISTS (
                SELECT 1 FROM donations d
                WHERE d.project_id = u.project_id
                  AND d.donor_address = $2 AND d.status = 'committed'
              ) AS is_donor
       FROM project_updates u
       WHERE u.id = $1 AND u.moderation_status = ANY($3::text[])`,
      [updateId, donorAddress, PUBLIC_STATUSES],
    );
    if (!eligibility.rows[0]) throw createApiError(404, "UPDATE_NOT_FOUND", "Published update not found");
    if (!eligibility.rows[0].is_donor) {
      throw createApiError(403, "DONOR_REQUIRED", "Only a donor to this project may report its update");
    }
    const inserted = await pool.query(
      `INSERT INTO project_update_reports (id, update_id, reporter_address, reason, details)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (update_id, reporter_address) DO NOTHING
       RETURNING id, status, created_at`,
      [uuidv4(), updateId, donorAddress, reason, details],
    );
    if (!inserted.rows[0]) {
      throw createApiError(409, "REPORT_ALREADY_SUBMITTED", "You already reported this update");
    }
    res.status(201).json({
      id: inserted.rows[0].id,
      status: inserted.rows[0].status,
      createdAt: inserted.rows[0].created_at,
      message: "Report submitted for moderator review",
    });
  } catch (error) {
    next(error);
  }
});

router.post("/:updateId/appeals", adminRequired, moderationLimiter, async (req, res, next) => {
  try {
    const updateId = requireUuid(req.params.updateId, "updateId");
    const reason = requireText(req.body?.reason, "reason", 3000, 20);
    const actor = adminActor(req);
    const appeal = await withTransaction(async (client) => {
      const result = await client.query("SELECT * FROM project_updates WHERE id = $1 FOR UPDATE", [updateId]);
      const current = result.rows[0];
      if (!current) throw createApiError(404, "UPDATE_NOT_FOUND", "Update not found");
      if (!["rejected", "removed"].includes(current.moderation_status)) {
        throw createApiError(409, "UPDATE_NOT_APPEALABLE", "Only rejected or removed updates may be appealed");
      }
      const appealId = uuidv4();
      try {
        await client.query(
          `INSERT INTO project_update_appeals (id, update_id, filed_by, reason, prior_status)
           VALUES ($1, $2, $3, $4, $5)`,
          [appealId, updateId, actor, reason, current.moderation_status],
        );
      } catch (error) {
        if (error.code === "23505") {
          throw createApiError(409, "APPEAL_ALREADY_PENDING", "An appeal is already pending");
        }
        throw error;
      }
      await client.query(
        `UPDATE project_updates
         SET moderation_status = 'appealed', moderation_reason = $2,
             moderation_actor = $3, moderation_updated_at = NOW() WHERE id = $1`,
        [updateId, reason, actor],
      );
      await insertModerationEvent(client, {
        updateId,
        actor,
        actorType: "project_admin",
        action: "appealed",
        fromStatus: current.moderation_status,
        toStatus: "appealed",
        reason,
        metadata: { appealId },
      });
      return { id: appealId, updateId, status: "pending", priorStatus: current.moderation_status };
    });
    res.status(201).json(appeal);
  } catch (error) {
    next(error);
  }
});

router.post("/:updateId/like", likeLimiter, async (req, res, next) => {
  try {
    const updateId = requireUuid(req.params.updateId, "updateId");
    const donorAddress = req.body?.donorAddress;
    if (typeof donorAddress !== "string") {
      throw createApiError(400, "DONOR_ADDRESS_REQUIRED", "donorAddress is required");
    }
    const updateResult = await pool.query(
      "SELECT id FROM project_updates WHERE id = $1 AND moderation_status = ANY($2::text[])",
      [updateId, PUBLIC_STATUSES],
    );
    if (!updateResult.rows[0]) throw createApiError(404, "UPDATE_NOT_FOUND", "Published update not found");
    const existing = await pool.query(
      "SELECT id FROM update_likes WHERE update_id = $1 AND donor_address = $2",
      [updateId, donorAddress],
    );
    if (existing.rows[0]) {
      await pool.query("DELETE FROM update_likes WHERE update_id = $1 AND donor_address = $2", [updateId, donorAddress]);
    } else {
      await pool.query(
        "INSERT INTO update_likes (id, update_id, donor_address, created_at) VALUES ($1, $2, $3, NOW())",
        [uuidv4(), updateId, donorAddress],
      );
    }
    const countResult = await pool.query("SELECT COUNT(*) as count FROM update_likes WHERE update_id = $1", [updateId]);
    res.json({ liked: !existing.rows[0], likeCount: parseInt(countResult.rows[0].count, 10) });
  } catch (error) {
    next(error);
  }
});

router.get("/:updateId/likes", async (req, res, next) => {
  try {
    const updateId = requireUuid(req.params.updateId, "updateId");
    const { donorAddress } = req.query;
    const countResult = await pool.query("SELECT COUNT(*) as count FROM update_likes WHERE update_id = $1", [updateId]);
    let liked = false;
    if (donorAddress) {
      const existing = await pool.query(
        "SELECT id FROM update_likes WHERE update_id = $1 AND donor_address = $2",
        [updateId, donorAddress],
      );
      liked = Boolean(existing.rows[0]);
    }
    res.json({ likeCount: parseInt(countResult.rows[0].count, 10), liked });
  } catch (error) {
    next(error);
  }
});

router.get("/:projectId", async (req, res, next) => {
  try {
    const projectId = requireUuid(req.params.projectId, "projectId");
    const parsedLimit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const language = req.query.lang === undefined ? null : requireContentLanguage(req.query.lang);
    const cursorObj = decodeCursor(req.query.cursor);
    const where = ["u.project_id = $1", "u.moderation_status = ANY($2::text[])"];
    const values = [projectId, PUBLIC_STATUSES];
    if (cursorObj?.createdAt && cursorObj?.id) {
      values.push(cursorObj.createdAt, cursorObj.id);
      where.push(`(u.created_at, u.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
    } else if (cursorObj?.createdAt) {
      values.push(cursorObj.createdAt);
      where.push(`u.created_at < $${values.length}::timestamptz`);
    }
    let languageParam = null;
    if (language) {
      values.push(language);
      languageParam = `$${values.length}`;
    }
    const localization = updateLocalizationSelect(languageParam);
    values.push(parsedLimit + 1);
    const result = await pool.query(
      `SELECT u.*${localization.columns}${languageParam ? `, ${languageParam}::text AS requested_language` : ""}
       FROM project_updates u${localization.join}
       WHERE ${where.join(" AND ")}
       ORDER BY u.created_at DESC, u.id DESC LIMIT $${values.length}`,
      values,
    );
    const { data, meta } = formatPaginatedResponse({
      rows: result.rows,
      limit: parsedLimit,
      getCursorPayload: (row) => ({ createdAt: row.created_at, id: row.id }),
    });
    res.apiMeta(meta);
    res.json(data.map(mapProjectUpdateRow));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
