/**
 * src/routes/realtime.js — reconnect recovery and per-pod delivery visibility.
 *
 * Socket.IO delivery is best-effort: a client whose connection drops during a
 * deploy, a network blip, or a laptop lid closing simply does not receive what
 * was broadcast while it was away. Previously that gap was invisible — the feed
 * resumed and the missing donations were never shown.
 *
 * These endpoints make the gap recoverable and the delivery observable.
 */
"use strict";

const express = require("express");
const router = express.Router();

const { describeStatus, getEventLog, metrics } = require("../realtime");
const { createApiError } = require("../middleware/apiEnvelope");

/**
 * GET /api/v1/realtime/replay?cursor=<cursor>&limit=<n>
 *
 * Returns the events broadcast after `cursor`. Every live event carries the
 * cursor identifying it, so a client stores the last one it saw and presents it
 * here on reconnect.
 *
 * `reset: true` means this endpoint cannot prove the reply is complete — the
 * cursor is unparseable, was issued by a pod that has since restarted, or has
 * aged out of the retention window. The client's contract is to refetch current
 * state from the REST resources rather than stitch a partial replay into its
 * timeline. Saying so explicitly is the whole point: an empty `events` array
 * would otherwise be indistinguishable from "nothing happened".
 */
router.get("/replay", async (req, res, next) => {
  try {
    const { cursor, limit } = req.query;

    if (cursor !== undefined && typeof cursor !== "string") {
      throw createApiError(400, "INVALID_CURSOR", "cursor must be a string");
    }

    const result = await getEventLog().replay(cursor || null, limit);
    metrics.replayRequested(result.reset);

    res.apiMeta({
      reset: result.reset,
      reason: result.reason,
      degraded: result.degraded,
      nextCursor: result.nextCursor,
      // Spelled out so a client author does not have to infer the contract
      // from field names alone.
      recovery: result.reset
        ? "Cursor could not be honoured; refetch current state from REST before resuming the live feed."
        : "Replay is complete; resume the live feed from nextCursor.",
    });
    res.json(result.events);
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/v1/realtime/status
 *
 * Per-pod delivery counters. Deliberately per-instance: the bug this guards
 * against was invisible precisely because aggregate numbers looked healthy
 * while individual pods received nothing. Scrape it from every replica —
 * `fanoutObserved` staying at zero on a pod that holds connections, while other
 * pods are publishing, is the failure signature.
 */
router.get("/status", (req, res) => {
  res.json({
    ...describeStatus(),
    metrics: metrics.snapshot(),
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
