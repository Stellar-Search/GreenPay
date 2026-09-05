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

const { decodeCursor, formatPaginatedResponse } = require("../utils/pagination");

router.get("/", async (req, res, next) => {
  try {
    const { cursor } = req.query;
    const parsedLimit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const cursorObj = decodeCursor(cursor);

    const where = [];
    const values = [];

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
    const whereClause = where.length ? `WHERE ${where.join(" AND ")} ` : "";
    const query = `SELECT * FROM jobs ${whereClause}ORDER BY created_at DESC, id DESC LIMIT $${values.length}`;

    const result = await pool.query(query, values);
    const { data, meta } = formatPaginatedResponse({
      rows: result.rows,
      limit: parsedLimit,
      getCursorPayload: (row) => ({ createdAt: row.created_at, id: row.id }),
    });

    res.apiMeta(meta);
    res.json(data.map(mapJobRow));
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
