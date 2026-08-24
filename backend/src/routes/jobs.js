/**
 * src/routes/jobs.js — Escrow job metadata (on-chain release is separate).
 */
"use strict";

const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { mapJobRow } = require("../services/store");
const { createApiError } = require("../middleware/apiEnvelope");

function validateTxHash(h) {
  if (!h || !/^[a-fA-F0-9]{64}$/.test(h)) {
    throw createApiError(400, "INVALID_TRANSACTION_HASH", "Invalid transaction hash");
  }
}

router.get("/", async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50",
    );
    res.json(result.rows.map(mapJobRow));
  } catch (e) {
    next(e);
  }
});

router.patch("/:id/release", async (req, res, next) => {
  try {
    const { releaseTransactionHash } = req.body;
    validateTxHash(releaseTransactionHash);

    const found = await pool.query("SELECT * FROM jobs WHERE id = $1", [
      req.params.id,
    ]);
    if (!found.rows[0]) {
      throw createApiError(404, "JOB_NOT_FOUND", "Job not found");
    }
    if (found.rows[0].status !== "in_escrow") {
      throw createApiError(400, "JOB_NOT_AWAITING_RELEASE", "Job is not awaiting release");
    }

    const updated = await pool.query(
      `UPDATE jobs
       SET status = 'completed',
           release_transaction_hash = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [releaseTransactionHash, req.params.id],
    );

    res.json(mapJobRow(updated.rows[0]));
  } catch (e) {
    next(e);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const result = await pool.query("SELECT * FROM jobs WHERE id = $1", [
      req.params.id,
    ]);
    if (!result.rows[0]) {
      throw createApiError(404, "JOB_NOT_FOUND", "Job not found");
    }
    res.json(mapJobRow(result.rows[0]));
  } catch (e) {
    next(e);
  }
});

module.exports = router;
