/**
 * src/services/notificationFailures.js
 *
 * Shared dead-letter recorder for the update-notification queues (email and
 * push, see services/email.js and services/push.js). A batch lands here once
 * pg-boss has exhausted its retries, so it's visible in the database instead
 * of only ever reaching a console.error a fire-and-forget promise swallowed.
 */
"use strict";

const { randomUUID: uuid } = require("crypto");
const pool = require("../db/pool");
const { logger: rootLogger } = require("../utils/logger");

const logger = rootLogger.child({ service: "notification-failures" });

/**
 * @param {Object} params
 * @param {string} params.projectId
 * @param {string} [params.updateId]
 * @param {"email"|"push"} params.channel
 * @param {object} params.payload - The job payload that failed (for replay/debugging).
 * @param {Error} [params.error]
 */
async function recordNotificationFailure({ projectId, updateId, channel, payload, error }) {
  logger.error({
    msg: "notification batch permanently failed after exhausting retries",
    channel,
    projectId,
    updateId,
    error: error?.message || "unknown error",
  });

  try {
    await pool.query(
      `INSERT INTO notification_job_failures (id, project_id, update_id, channel, payload, error_message, error_stack)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        uuid(),
        projectId,
        updateId || null,
        channel,
        JSON.stringify(payload || {}),
        error?.message || null,
        error?.stack || null,
      ],
    );
  } catch (err) {
    logger.error({ msg: "failed to record notification job failure", channel, projectId, error: err.message });
  }
}

module.exports = { recordNotificationFailure };
