/**
 * src/routes/donations.js
 */
"use strict";
const express = require("express");
const router  = express.Router();
const { v4: uuid } = require("uuid");
const pool = require("../db/pool");
const { createRateLimiter } = require("../middleware/rateLimiter");
const { computeBadges, mapDonationRow } = require("../services/store");
const donationLimiter = createRateLimiter(10, 1, "donation-post");
const { execute } = require("../eventSourcing/commandBus");
const { DonationRecordedEvent, MatchAppliedEvent } = require("../eventSourcing/events"); // 10 requests per minute

function validateKey(k) {
  if (!k || !/^G[A-Z0-9]{55}$/.test(k)) { const e = new Error("Invalid Stellar public key"); e.status = 400; throw e; }
}

function validateTxHash(h) {
  if (!h || !/^[a-fA-F0-9]{64}$/.test(h)) { const e = new Error("Invalid transaction hash"); e.status = 400; throw e; }
}

// POST /api/donations — record a donation after on-chain tx via Event Sourcing CQRS
async function recordDonation(req, res, next) {
  try {
    const { projectId, donorAddress, amountXLM, amount, currency = "XLM", message, transactionHash } = req.body;

    if (!donorAddress || !/^G[A-Z0-9]{55}$/.test(donorAddress)) {
      const e = new Error("Invalid Stellar public key");
      e.status = 400;
      throw e;
    }
    if (!transactionHash || !/^[a-fA-F0-9]{64}$/.test(transactionHash)) {
      const e = new Error("Invalid transaction hash");
      e.status = 400;
      throw e;
    }

    const projectResult = await pool.query("SELECT id FROM projects WHERE id = $1", [projectId]);
    if (!projectResult.rows[0]) {
      const e = new Error("Project not found");
      e.status = 404;
      throw e;
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
          return res.json({ success: true, data: { id: existing.rows[0].event_id, ...existing.rows[0].payload.data }, deduplicated: true });
        }
      }
      throw err;
    }

    if (result.deduplicated) {
      return res.json({ success: true, data: result.data, deduplicated: true });
    }

    const donationEvents = result.events || [];
    const mainEvent = donationEvents.find((e) => e.eventType === "DonationRecorded");
    if (!mainEvent) {
      const e = new Error("Expected DonationRecorded event not produced");
      e.status = 500;
      throw e;
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

    res.status(201).json({ success: true, data: { id: mainEvent.eventId, ...mainEvent.data } });
  } catch (e) {
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
    res.json({ success: true, data: result.rows.map(mapDonationRow) });
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

    res.json({ success: true, data: result, nextCursor });
  } catch (e) {
    next(e);
  }
});

// GET /api/donations/donor/:publicKey
router.get("/donor/:publicKey", async (req, res, next) => {
  try {
    validateKey(req.params.publicKey);
    const result = await pool.query(
      `SELECT * FROM donations
       WHERE donor_address = $1
       ORDER BY created_at DESC`,
      [req.params.publicKey],
    );
    res.json({ success: true, data: result.rows.map(mapDonationRow) });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.recordDonation = recordDonation;
