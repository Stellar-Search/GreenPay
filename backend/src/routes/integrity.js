"use strict";

const crypto = require("crypto");
const express = require("express");
const { v4: uuid } = require("uuid");
const pool = require("../db/pool");
const cache = require("../services/cache");
const { adminRequired } = require("../middleware/auth");
const { createApiError } = require("../middleware/apiEnvelope");
const { createLayeredRateLimiter } = require("../middleware/rateLimiter");
const {
  REVIEW_SCORE,
  evaluateLabelledSet,
  verifyWalletSignature,
  insertEvent,
  refreshIntegrityWatchlist,
  getIntegrityWorkerStatus,
} = require("../services/donationIntegrity");

const router = express.Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STELLAR_ADDRESS_PATTERN = /^G[A-Z2-7]{55}$/;

const appealLimiter = createLayeredRateLimiter({
  name: "integrity-appeal",
  windowMinutes: 60,
  ip: 10,
  wallet: 3,
  global: 300,
  walletKey: (req) => req.body?.walletAddress || req.body?.appellantWallet || null,
});

function requireUuid(value, field) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw createApiError(400, "INVALID_ID", `${field} must be a UUID`);
  }
  return value;
}

function requireText(value, field, min = 1, max = 2000) {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) {
    throw createApiError(400, "INVALID_TEXT", `${field} must be ${min}-${max} characters`);
  }
  return value.trim();
}

function requireWallet(value, field = "walletAddress") {
  if (typeof value !== "string" || !STELLAR_ADDRESS_PATTERN.test(value)) {
    throw createApiError(400, "INVALID_WALLET", `${field} must be a Stellar public key`);
  }
  return value;
}

function reviewer(req) {
  return req.admin?.sub || req.admin?.email || "admin";
}

async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

router.get("/policy", (_req, res) => {
  res.json({
    version: "donation-integrity-v1",
    approach: "Behavioural signals route donations to human review; signals never penalise an account automatically.",
    disclosedSignals: ["declared wallet relationships", "short-window repeated pairs", "bounded circular-flow paths"],
    thresholdDisclosure: "Versioned live weights and boundaries are public. Human review, labelled evaluation, and appeals limit the cost of threshold gaming.",
    detectionParameters: {
      reviewScore: REVIEW_SCORE,
      repeatWindowMinutes: 10,
      repeatMinimumCount: 3,
      maximumGraphDepth: 3,
      circularWindowHours: 24,
      flowRetentionHours: 72,
    },
    enforcement: {
      leaderboard: "Confirmed donations are excluded from ranking totals only after the evaluation gate is enabled.",
      displayedTotals: "Confirmed donations are excluded from donor-facing funding totals while gross accounting remains auditable.",
      impactFigures: "Confirmed donations do not support impact figures; environmental claims remain project-level and evidence-based.",
    },
    appeal: "Affected donor and project wallets receive a signed-wallet appeal path and independent review.",
  });
});

router.get("/status", adminRequired, async (_req, res, next) => {
  try {
    const [queue, settings] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS pending FROM donation_integrity_queue"),
      pool.query("SELECT * FROM donation_integrity_settings WHERE id = 'global'"),
    ]);
    res.json({
      worker: getIntegrityWorkerStatus(),
      pendingQueue: Number(queue.rows[0]?.pending || 0),
      enforcement: settings.rows[0] || { enforcement_enabled: false },
    });
  } catch (error) {
    next(error);
  }
});

router.post("/relationships", adminRequired, async (req, res, next) => {
  try {
    const projectId = requireUuid(req.body?.projectId, "projectId");
    const walletAddress = requireWallet(req.body?.walletAddress);
    const allowedTypes = ["owner", "operator", "treasury", "beneficiary", "declared_related"];
    const relationshipType = req.body?.relationshipType;
    if (!allowedTypes.includes(relationshipType)) {
      throw createApiError(400, "INVALID_RELATIONSHIP_TYPE", `relationshipType must be one of: ${allowedTypes.join(", ")}`);
    }
    const evidenceSummary = requireText(req.body?.evidenceSummary, "evidenceSummary", 10, 1000);
    const confidence = req.body?.confidence === undefined ? 1 : Number(req.body.confidence);
    if (!Number.isFinite(confidence) || confidence < 0.5 || confidence > 1) {
      throw createApiError(400, "INVALID_CONFIDENCE", "confidence must be between 0.5 and 1");
    }
    const result = await pool.query(
      `INSERT INTO project_wallet_relationships (
         id, project_id, wallet_address, relationship_type, source,
         confidence, active, recorded_by, evidence
       ) VALUES ($1, $2, $3, $4, 'admin_evidence', $5, TRUE, $6, $7::jsonb)
       ON CONFLICT (project_id, wallet_address, relationship_type) DO UPDATE SET
         confidence = EXCLUDED.confidence,
         active = TRUE,
         recorded_by = EXCLUDED.recorded_by,
         evidence = EXCLUDED.evidence,
         updated_at = NOW()
       RETURNING *`,
      [
        uuid(), projectId, walletAddress, relationshipType,
        confidence, reviewer(req),
        JSON.stringify({ summary: evidenceSummary }),
      ],
    );
    await refreshIntegrityWatchlist();
    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.get("/reviews", adminRequired, async (req, res, next) => {
  try {
    const allowedStatuses = ["monitoring", "pending_review", "confirmed", "dismissed", "appealed"];
    const status = req.query.status || "pending_review";
    if (!allowedStatuses.includes(status)) {
      throw createApiError(400, "INVALID_REVIEW_STATUS", "Unsupported review status");
    }
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const result = await pool.query(
      `SELECT a.*,
              p.name AS project_name,
              COALESCE(jsonb_agg(
                jsonb_build_object(
                  'type', s.signal_type,
                  'confidence', s.confidence,
                  'evidence', s.evidence
                ) ORDER BY s.confidence DESC
              ) FILTER (WHERE s.id IS NOT NULL), '[]'::jsonb) AS signals
         FROM donation_integrity_assessments a
         JOIN projects p ON p.id = a.project_id
         LEFT JOIN donation_integrity_signals s ON s.assessment_id = a.id
        WHERE a.review_status = $1
        GROUP BY a.id, p.name
        ORDER BY a.confidence_score DESC, a.observed_at ASC
        LIMIT $2`,
      [status, limit],
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.get("/reviews/:id", adminRequired, async (req, res, next) => {
  try {
    const id = requireUuid(req.params.id, "review id");
    const [assessment, signals, events, appeals] = await Promise.all([
      pool.query("SELECT * FROM donation_integrity_assessments WHERE id = $1", [id]),
      pool.query("SELECT * FROM donation_integrity_signals WHERE assessment_id = $1 ORDER BY confidence DESC", [id]),
      pool.query("SELECT * FROM donation_integrity_events WHERE assessment_id = $1 ORDER BY created_at ASC", [id]),
      pool.query("SELECT * FROM donation_integrity_appeals WHERE assessment_id = $1 ORDER BY submitted_at ASC", [id]),
    ]);
    if (!assessment.rows[0]) throw createApiError(404, "REVIEW_NOT_FOUND", "Integrity review not found");
    res.json({ assessment: assessment.rows[0], signals: signals.rows, events: events.rows, appeals: appeals.rows });
  } catch (error) {
    next(error);
  }
});

router.post("/reviews/:id/decision", adminRequired, async (req, res, next) => {
  try {
    const id = requireUuid(req.params.id, "review id");
    const action = req.body?.action;
    if (!["confirm", "dismiss"].includes(action)) {
      throw createApiError(400, "INVALID_DECISION", "action must be confirm or dismiss");
    }
    const reason = requireText(req.body?.reason, "reason", 20, 2000);
    const actor = reviewer(req);
    const result = await withTransaction(async (client) => {
      const currentResult = await client.query(
        "SELECT * FROM donation_integrity_assessments WHERE id = $1 FOR UPDATE",
        [id],
      );
      const current = currentResult.rows[0];
      if (!current) throw createApiError(404, "REVIEW_NOT_FOUND", "Integrity review not found");
      if (!["pending_review", "monitoring"].includes(current.review_status)) {
        throw createApiError(409, "REVIEW_ALREADY_DECIDED", "Review is not awaiting a decision");
      }
      const settings = await client.query(
        "SELECT enforcement_enabled FROM donation_integrity_settings WHERE id = 'global' FOR UPDATE",
      );
      const applyEnforcement = action === "confirm" && settings.rows[0]?.enforcement_enabled === true;
      const nextStatus = action === "confirm" ? "confirmed" : "dismissed";
      const updated = await client.query(
        `UPDATE donation_integrity_assessments
            SET review_status = $2,
                exclude_from_leaderboard = $3,
                exclude_from_displayed_totals = $3,
                exclude_from_impact_figures = $3,
                decision_reason = $4,
                decided_by = $5,
                decided_at = NOW(),
                updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [id, nextStatus, applyEnforcement, reason, actor],
      );
      await insertEvent(client, {
        assessmentId: id,
        actor,
        actorType: "reviewer",
        action,
        fromStatus: current.review_status,
        toStatus: nextStatus,
        reason,
        metadata: { enforcementApplied: applyEnforcement },
      });
      return updated.rows[0];
    });
    cache.clear();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/reviews/:id/appeal-challenge", appealLimiter, async (req, res, next) => {
  try {
    const id = requireUuid(req.params.id, "review id");
    const walletAddress = requireWallet(req.body?.walletAddress);
    const affected = await pool.query(
      `SELECT a.id
         FROM donation_integrity_assessments a
        WHERE a.id = $1
          AND a.review_status = 'confirmed'
          AND (
            a.donor_address = $2
            OR EXISTS (
              SELECT 1 FROM project_wallet_relationships r
               WHERE r.project_id = a.project_id
                 AND r.wallet_address = $2
                 AND r.active = TRUE
                 AND r.valid_from <= NOW()
                 AND (r.valid_until IS NULL OR r.valid_until > NOW())
            )
          )`,
      [id, walletAddress],
    );
    if (!affected.rows[0]) {
      throw createApiError(403, "APPEAL_WALLET_NOT_AFFECTED", "Wallet is not an affected party for this review");
    }
    const challengeId = uuid();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const nonce = crypto.randomBytes(24).toString("hex");
    const challenge = `integrity-appeal:${id}:${walletAddress}:${nonce}:${expiresAt.toISOString()}`;
    await pool.query(
      `INSERT INTO donation_integrity_appeal_challenges (
         id, assessment_id, wallet_address, challenge, expires_at
       ) VALUES ($1, $2, $3, $4, $5)`,
      [challengeId, id, walletAddress, challenge, expiresAt],
    );
    res.status(201).json({ challengeId, challenge, expiresAt: expiresAt.toISOString() });
  } catch (error) {
    next(error);
  }
});

router.post("/reviews/:id/appeals", appealLimiter, async (req, res, next) => {
  try {
    const id = requireUuid(req.params.id, "review id");
    const challengeId = requireUuid(req.body?.challengeId, "challengeId");
    const signature = requireText(req.body?.signature, "signature", 20, 500);
    const reason = requireText(req.body?.reason, "reason", 20, 2000);
    const result = await withTransaction(async (client) => {
      const challengeResult = await client.query(
        `SELECT * FROM donation_integrity_appeal_challenges
          WHERE id = $1 AND assessment_id = $2
            AND used_at IS NULL AND expires_at > NOW()
          FOR UPDATE`,
        [challengeId, id],
      );
      const challenge = challengeResult.rows[0];
      if (!challenge) throw createApiError(409, "APPEAL_CHALLENGE_INVALID", "Appeal challenge is missing, expired, or used");
      if (!verifyWalletSignature(challenge.wallet_address, challenge.challenge, signature)) {
        throw createApiError(403, "APPEAL_SIGNATURE_INVALID", "Signature does not verify against the affected wallet");
      }
      const currentResult = await client.query(
        "SELECT * FROM donation_integrity_assessments WHERE id = $1 FOR UPDATE",
        [id],
      );
      const current = currentResult.rows[0];
      if (!current || current.review_status !== "confirmed") {
        throw createApiError(409, "REVIEW_NOT_APPEALABLE", "Only a confirmed review can be appealed");
      }
      const appealId = uuid();
      await client.query(
        `INSERT INTO donation_integrity_appeals (
           id, assessment_id, appellant_wallet, reason
         ) VALUES ($1, $2, $3, $4)`,
        [appealId, id, challenge.wallet_address, reason],
      );
      await client.query("UPDATE donation_integrity_appeal_challenges SET used_at = NOW() WHERE id = $1", [challengeId]);
      await client.query(
        `UPDATE donation_integrity_assessments
            SET review_status = 'appealed',
                exclude_from_leaderboard = FALSE,
                exclude_from_displayed_totals = FALSE,
                exclude_from_impact_figures = FALSE,
                updated_at = NOW()
          WHERE id = $1`,
        [id],
      );
      await insertEvent(client, {
        assessmentId: id,
        actor: challenge.wallet_address,
        actorType: "appellant",
        action: "appealed",
        fromStatus: "confirmed",
        toStatus: "appealed",
        reason,
        metadata: { enforcementSuspended: true },
      });
      return { id: appealId, assessmentId: id, status: "pending" };
    });
    cache.clear();
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

router.get("/appeals", adminRequired, async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ap.*, a.transaction_hash, a.project_id, a.donor_address,
              a.confidence_score, a.decided_by AS original_reviewer
         FROM donation_integrity_appeals ap
         JOIN donation_integrity_assessments a ON a.id = ap.assessment_id
        WHERE ap.status = 'pending'
        ORDER BY ap.submitted_at ASC`,
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.post("/appeals/:id/decision", adminRequired, async (req, res, next) => {
  try {
    const appealId = requireUuid(req.params.id, "appeal id");
    const outcome = req.body?.outcome;
    if (!["grant", "deny"].includes(outcome)) {
      throw createApiError(400, "INVALID_APPEAL_DECISION", "outcome must be grant or deny");
    }
    const reason = requireText(req.body?.reason, "reason", 20, 2000);
    const actor = reviewer(req);
    const result = await withTransaction(async (client) => {
      const appealResult = await client.query(
        `SELECT ap.*, a.decided_by AS original_reviewer
           FROM donation_integrity_appeals ap
           JOIN donation_integrity_assessments a ON a.id = ap.assessment_id
          WHERE ap.id = $1 FOR UPDATE OF ap, a`,
        [appealId],
      );
      const appeal = appealResult.rows[0];
      if (!appeal || appeal.status !== "pending") {
        throw createApiError(409, "APPEAL_NOT_PENDING", "Appeal is missing or already decided");
      }
      if (appeal.original_reviewer === actor) {
        throw createApiError(409, "INDEPENDENT_REVIEWER_REQUIRED", "A different reviewer must decide the appeal");
      }
      const settings = await client.query("SELECT enforcement_enabled FROM donation_integrity_settings WHERE id = 'global'");
      const enforcement = outcome === "deny" && settings.rows[0]?.enforcement_enabled === true;
      const nextStatus = outcome === "grant" ? "dismissed" : "confirmed";
      await client.query(
        `UPDATE donation_integrity_appeals
            SET status = $2, decided_by = $3, decision_reason = $4, decided_at = NOW()
          WHERE id = $1`,
        [appealId, outcome === "grant" ? "granted" : "denied", actor, reason],
      );
      const updated = await client.query(
        `UPDATE donation_integrity_assessments
            SET review_status = $2,
                exclude_from_leaderboard = $3,
                exclude_from_displayed_totals = $3,
                exclude_from_impact_figures = $3,
                updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [appeal.assessment_id, nextStatus, enforcement],
      );
      await insertEvent(client, {
        assessmentId: appeal.assessment_id,
        actor,
        actorType: "reviewer",
        action: outcome === "grant" ? "appeal_granted" : "appeal_denied",
        fromStatus: "appealed",
        toStatus: nextStatus,
        reason,
        metadata: { enforcementApplied: enforcement },
      });
      return updated.rows[0];
    });
    cache.clear();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/reviews/:id/label", adminRequired, async (req, res, next) => {
  try {
    const assessmentId = requireUuid(req.params.id, "review id");
    const label = req.body?.label;
    if (!["legitimate", "confirmed_abuse", "uncertain"].includes(label)) {
      throw createApiError(400, "INVALID_LABEL", "Unsupported labelled-set value");
    }
    const rationale = requireText(req.body?.rationale, "rationale", 20, 2000);
    const result = await pool.query(
      `INSERT INTO donation_integrity_labels (
         assessment_id, label, labelled_by, rationale
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (assessment_id) DO UPDATE SET
         label = EXCLUDED.label,
         labelled_by = EXCLUDED.labelled_by,
         rationale = EXCLUDED.rationale,
         labelled_at = NOW()
       RETURNING *`,
      [assessmentId, label, reviewer(req), rationale],
    );
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.get("/evaluation", adminRequired, async (_req, res, next) => {
  try {
    res.json(await evaluateLabelledSet());
  } catch (error) {
    next(error);
  }
});

router.post("/enforcement/enable", adminRequired, async (req, res, next) => {
  try {
    const reason = requireText(req.body?.reason, "reason", 20, 2000);
    const actor = reviewer(req);
    const result = await withTransaction(async (client) => {
      const evaluation = await evaluateLabelledSet(client);
      if (!evaluation.enforcementReady) {
        throw createApiError(409, "EVALUATION_GATE_NOT_MET", "Labelled-set quality gate has not been met", evaluation);
      }
      const settings = await client.query(
        `UPDATE donation_integrity_settings
            SET enforcement_enabled = TRUE,
                enabled_by = $1,
                enabled_at = NOW(),
                evaluation_snapshot = $2::jsonb,
                updated_at = NOW()
          WHERE id = 'global'
          RETURNING *`,
        [actor, JSON.stringify({ ...evaluation, reason })],
      );
      const cases = await client.query(
        `UPDATE donation_integrity_assessments
            SET exclude_from_leaderboard = TRUE,
                exclude_from_displayed_totals = TRUE,
                exclude_from_impact_figures = TRUE,
                updated_at = NOW()
          WHERE review_status = 'confirmed'
          RETURNING id`,
      );
      for (const row of cases.rows) {
        await insertEvent(client, {
          assessmentId: row.id,
          actor,
          actorType: "reviewer",
          action: "enforcement_enabled",
          fromStatus: "confirmed",
          toStatus: "confirmed",
          reason,
          metadata: { evaluation },
        });
      }
      return { settings: settings.rows[0], affectedCases: cases.rows.length };
    });
    cache.clear();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/enforcement/disable", adminRequired, async (req, res, next) => {
  try {
    const reason = requireText(req.body?.reason, "reason", 20, 2000);
    const actor = reviewer(req);
    const result = await withTransaction(async (client) => {
      const settings = await client.query(
        `UPDATE donation_integrity_settings
            SET enforcement_enabled = FALSE,
                evaluation_snapshot = COALESCE(evaluation_snapshot, '{}'::jsonb) || $1::jsonb,
                updated_at = NOW()
          WHERE id = 'global'
          RETURNING *`,
        [JSON.stringify({ disabledBy: actor, disabledAt: new Date().toISOString(), disableReason: reason })],
      );
      const cases = await client.query(
        `UPDATE donation_integrity_assessments
            SET exclude_from_leaderboard = FALSE,
                exclude_from_displayed_totals = FALSE,
                exclude_from_impact_figures = FALSE,
                updated_at = NOW()
          WHERE exclude_from_leaderboard = TRUE
             OR exclude_from_displayed_totals = TRUE
             OR exclude_from_impact_figures = TRUE
          RETURNING id, review_status`,
      );
      for (const row of cases.rows) {
        await insertEvent(client, {
          assessmentId: row.id,
          actor,
          actorType: "reviewer",
          action: "enforcement_disabled",
          fromStatus: row.review_status,
          toStatus: row.review_status,
          reason,
        });
      }
      return { settings: settings.rows[0], affectedCases: cases.rows.length };
    });
    cache.clear();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
