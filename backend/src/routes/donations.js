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
const { publish } = require("../realtime");
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

    if (!result.deduplicated) {
      // publish() rather than io.emit(): the latter reaches only the clients
      // this pod happens to be holding, which at two or more replicas is a
      // fraction of the donors watching. It also records the event so a client
      // that reconnects can recover it. Awaited so a replay-log failure is
      // logged against this request; it never throws.
      await publish("donation_event", {
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

const { decodeCursor, formatPaginatedResponse } = require("../utils/pagination");

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
    const { cursor } = req.query;
    const parsedLimit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
    const cursorObj = decodeCursor(cursor);

    const where = [
      "project_id = $1",
      "message IS NOT NULL",
      "length(trim(message)) > 0",
    ];
    const values = [req.params.projectId];

    if (cursorObj && cursorObj.amount !== undefined && cursorObj.createdAt && cursorObj.id) {
      values.push(cursorObj.amount, cursorObj.createdAt, cursorObj.id);
      const cAmt = `$${values.length - 2}`;
      const cTime = `$${values.length - 1}::timestamptz`;
      const cId = `$${values.length}::uuid`;
      where.push(`(
        amount < ${cAmt}
        OR (amount = ${cAmt} AND created_at < ${cTime})
        OR (amount = ${cAmt} AND created_at = ${cTime} AND id < ${cId})
      )`);
    }

    values.push(parsedLimit + 1);
    const query = `SELECT *
       FROM donations
       WHERE ${where.join(" AND ")}
       ORDER BY amount DESC, created_at DESC, id DESC
       LIMIT $${values.length}`;

    const result = await pool.query(query, values);
    const { data, meta } = formatPaginatedResponse({
      rows: result.rows,
      limit: parsedLimit,
      getCursorPayload: (row) => ({
        amount: row.amount,
        createdAt: row.created_at,
        id: row.id,
      }),
    });

    res.apiMeta(meta);
    res.json(data.map(mapDonationRow));
  } catch (e) {
    next(e);
  }
});

router.get("/project/:projectId", async (req, res, next) => {
  try {
    const { cursor } = req.query;
    const parsedLimit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const cursorObj = decodeCursor(cursor);

    const where = ["project_id = $1"];
    const values = [req.params.projectId];

    if (cursorObj) {
      if (cursorObj.createdAt && cursorObj.id) {
        values.push(cursorObj.createdAt, cursorObj.id);
        where.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
      } else if (cursorObj.createdAt) {
        values.push(cursorObj.createdAt);
        where.push(`created_at < $${values.length}::timestamptz`);
      }
    }

    values.push(parsedLimit + 1);
    const query = `SELECT * FROM donations
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length}`;

    const result = await pool.query(query, values);
    const { data, meta } = formatPaginatedResponse({
      rows: result.rows,
      limit: parsedLimit,
      getCursorPayload: (row) => ({ createdAt: row.created_at, id: row.id }),
    });

    const mappedDonations = data.map(mapDonationRow);
    res.apiMeta({
      ...meta,
      nextCursor: meta.nextCursor,
    });
    res.json(mappedDonations);
  } catch (e) {
    next(e);
  }
});

// GET /api/donations/donor/:publicKey
router.get("/donor/:publicKey", validate(donorKeyParamsSchema, { source: "params" }), async (req, res, next) => {
  try {
    const { cursor } = req.query;
    const parsedLimit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const cursorObj = decodeCursor(cursor);

    const where = ["donor_address = $1"];
    const values = [req.params.publicKey];

    if (cursorObj) {
      if (cursorObj.createdAt && cursorObj.id) {
        values.push(cursorObj.createdAt, cursorObj.id);
        where.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
      } else if (cursorObj.createdAt) {
        values.push(cursorObj.createdAt);
        where.push(`created_at < $${values.length}::timestamptz`);
      }
    }

    values.push(parsedLimit + 1);
    const query = `SELECT * FROM donations
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length}`;

    const result = await pool.query(query, values);
    const { data, meta } = formatPaginatedResponse({
      rows: result.rows,
      limit: parsedLimit,
      getCursorPayload: (row) => ({ createdAt: row.created_at, id: row.id }),
    });

    res.apiMeta(meta);
    res.json(data.map(mapDonationRow));
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.recordDonation = recordDonation;
