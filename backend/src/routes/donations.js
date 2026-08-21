/**
 * src/routes/donations.js
 */
"use strict";
const express = require("express");
const router  = express.Router();
const { v4: uuid } = require("uuid");
const pool = require("../db/pool");
const { createRateLimiter } = require("../middleware/rateLimiter");
const { createApiError } = require("../middleware/apiEnvelope");
const { z } = require("zod");
const { validateBody, validate } = require("../middleware/validate");
const { DonationCreateSchema } = require("../schemas/donations");
const { stellarPublicKey } = require("../schemas/common");
const donorKeyParamsSchema = z.object({ publicKey: stellarPublicKey });
const { computeBadges, mapDonationRow } = require("../services/store");
const donationLimiter = createRateLimiter(10, 1, "donation-post");
const { execute } = require("../eventSourcing/commandBus");
const { DonationRecordedEvent, MatchAppliedEvent } = require("../eventSourcing/events"); // 10 requests per minute
const { logger: rootLogger } = require("../utils/logger");

const logger = rootLogger.child({ service: "donations-route" });

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
      if (err.message && (err.message.includes("Duplicate event") || err.message.includes("already exists"))) {
        const existing = await pool.query(
          `SELECT event_id, payload FROM event_stream
           WHERE event_type = 'DonationRecorded'
             AND payload->'data'->>'transactionHash' = $1`,
          [transactionHash]
        );
        if (existing.rows[0]) {
          logger.info({ msg: "donation deduplicated", transactionHash, donationId: existing.rows[0].event_id });
          res.apiMeta({ deduplicated: true });
          return res.json({ id: existing.rows[0].event_id, ...existing.rows[0].payload.data });
        }
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
        amountXLM: mainEvent.data.amountXlm,
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
