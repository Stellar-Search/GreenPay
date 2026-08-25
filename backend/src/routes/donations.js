/**
 * src/routes/donations.js
 */
"use strict";
const express = require("express");
const router  = express.Router();
const { v4: uuid } = require("uuid");
const pool = require("../db/pool");
const { createLayeredRateLimiter } = require("../middleware/rateLimiter");
const { createApiError } = require("../middleware/apiEnvelope");
const { z } = require("zod");
const { validateBody, validate } = require("../middleware/validate");
const { DonationCreateSchema } = require("../schemas/donations");
const { stellarPublicKey } = require("../schemas/common");
const donorKeyParamsSchema = z.object({ publicKey: stellarPublicKey });
const { computeBadges, mapDonationRow } = require("../services/store");
// Layered: a coarse per-IP floor (so donors behind a shared NAT/carrier egress
// don't starve each other), the real per-wallet cap, and a global cap on this
// expensive endpoint so a distributed flood is bounded even when no single
// client breaks its own limits.
const donationLimiter = createLayeredRateLimiter({
  name: "donation-post",
  windowMinutes: 1,
  ip: 30,
  wallet: 10,
  global: 120,
});
const { execute, DonationReplayConflictError } = require("../eventSourcing/commandBus");
const { DonationRecordedEvent, MatchAppliedEvent } = require("../eventSourcing/events"); // 10 requests per minute
const { logger: rootLogger } = require("../utils/logger");

const logger = rootLogger.child({ service: "donations-route" });

function publicDonationData(data) {
  return { ...data, amountXlm: Number.parseFloat(data.amountXlm) };
}

// POST /api/donations — record a donation after on-chain tx via Event Sourcing CQRS
async function recordDonation(req, res, next) {
  try {
    // Declarative, centrally-reviewed validation (src/schemas/donations.js).
    const {
      projectId,
      donorAddress,
      amountXLM,
      amount,
      // currency defaults to "XLM" inside the schema
      currency = "XLM",
      message,
      transactionHash,
    } = validateBody(DonationCreateSchema, req.body || {});

    logger.info({
      msg: "donation attempt",
      projectId,
      donorAddress,
      transactionHash,
    });

    const projectResult = await pool.query("SELECT id FROM projects WHERE id = $1", [projectId]);
    if (!projectResult.rows[0]) {
      throw createApiError(404, "PROJECT_NOT_FOUND", "Project not found");
    }

    let result;
    try {
      result = await execute(
        new (require("../eventSourcing/commands").RecordDonationCommand)({
          actor: donorAddress,
          projectId,
          donorAddress,
          amountXLM,
          amount,
          currency,
          message,
          transactionHash,
        })
      );
    } catch (err) {
      if (err instanceof DonationReplayConflictError) {
        // Same transaction hash, different payload: tampering, not a retry.
        logger.warn({
          msg: "suspicious donation replay rejected",
          transactionHash,
          donorAddress,
          projectId,
          mismatches: err.mismatches,
        });
        throw createApiError(409, "DONATION_TX_CONFLICT",
          "Transaction hash already recorded with different details",
          { transactionHash, mismatches: err.mismatches });
      }
      throw err;
    }

    if (result.deduplicated) {
      logger.info({ msg: "donation deduplicated", transactionHash });
      res.apiMeta({ deduplicated: true });
      return res.json(result.data);
    }

    const donationEvents = result.events || [];
    const mainEvent = donationEvents.find((e) => e.eventType === "DonationRecorded");
    if (!mainEvent) {
      throw createApiError(500, "DONATION_EVENT_MISSING", "Expected DonationRecorded event not produced");
    }

    const io = req.app?.get("io");
    if (io && !result.deduplicated) {
      io.emit("donation_event", {
        projectId,
        donorAddress,
        amountXLM: Number.parseFloat(mainEvent.data.amountXlm),
        transactionHash,
        timestamp: new Date().toISOString(),
      });
    }

    logger.info({
      msg: "donation recorded",
      donationId: mainEvent.eventId,
      projectId,
      amountXlm: mainEvent.data.amountXlm,
      transactionHash,
    });

    res.status(201).json({ id: mainEvent.eventId, ...mainEvent.data });
  } catch (e) {
    logger.error({ msg: "donation failed", error: e.message, status: e.status || 500 });
    next(e);
  }
}

router.post("/", donationLimiter, recordDonation);

// GET /api/donations - fetch donations for backfill after reconnect
router.get("/", async (req, res, next) => {
  try {
    const { since, projectId } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

    if (!since) {
      throw createApiError(400, "SINCE_REQUIRED", "Query parameter 'since' is required");
    }

    if (!projectId) {
      throw createApiError(400, "PROJECT_ID_REQUIRED", "Query parameter 'projectId' is required");
    }

    const sinceDate = new Date(since);
    if (isNaN(sinceDate.getTime())) {
      throw createApiError(400, "INVALID_TIMESTAMP", "Query parameter 'since' must be a valid ISO timestamp");
    }

    const result = await pool.query(
      `SELECT * FROM donations
       WHERE project_id = $1
         AND created_at > $2::timestamptz
       ORDER BY created_at ASC
       LIMIT $3`,
      [projectId, sinceDate.toISOString(), limit],
    );

    res.json(result.rows.map(publicDonationData));
  } catch (e) {
    next(e);
  }
});

// GET /api/donations/project/:id
router.get("/project/:projectId/messages", async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
    const result = await pool.query(
      `SELECT *
       FROM donations
       WHERE project_id = $1
         AND message IS NOT NULL
         AND length(trim(message)) > 0
       ORDER BY amount DESC, created_at DESC
       LIMIT $2`,
      [req.params.projectId, limit],
    );
    res.json(result.rows.map(mapDonationRow));
  } catch (e) {
    next(e);
  }
});

router.get("/project/:projectId", async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const hasCursor = Boolean(req.query.cursor);
    const values = hasCursor
      ? [req.params.projectId, req.query.cursor, limit + 1]
      : [req.params.projectId, limit + 1];

    const query = hasCursor
      ? `SELECT * FROM donations
         WHERE project_id = $1
           AND created_at < $2::timestamptz
         ORDER BY created_at DESC
         LIMIT $3`
      : `SELECT * FROM donations
         WHERE project_id = $1
         ORDER BY created_at DESC
         LIMIT $2`;

    const donations = (await pool.query(query, values)).rows.map(mapDonationRow);
    const hasMore = donations.length > limit;
    const result = hasMore ? donations.slice(0, limit) : donations;
    const nextCursor = hasMore ? result[result.length - 1].createdAt : null;

    res.apiMeta({ nextCursor });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// GET /api/donations/donor/:publicKey
router.get("/donor/:publicKey", validate(donorKeyParamsSchema, { source: "params" }), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM donations
       WHERE donor_address = $1
       ORDER BY created_at DESC`,
      [req.params.publicKey],
    );
    res.json(result.rows.map(mapDonationRow));
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.recordDonation = recordDonation;
