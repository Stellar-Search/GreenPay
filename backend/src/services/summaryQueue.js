/**
 * src/services/summaryQueue.js
 *
 * pg-boss job queue for async AI summary generation.
 * Keeps the HTTP request lifecycle decoupled from the Claude API call.
 */
"use strict";

const crypto = require("crypto");
const { randomUUID: uuid } = require("crypto");
const PgBoss = require("pg-boss");
const pool = require("../db/pool");
const { env } = require("../config/env");
const { generateProjectSummary } = require("./claude");
const { logAdminAction } = require("./audit");
const { logger: rootLogger, getCorrelationId, runWithCorrelationId } = require("../utils/logger");
const { publish } = require("../realtime");

const logger = rootLogger.child({ service: "summary-queue" });

const QUEUE = "ai-summary";
const DEAD_LETTER_QUEUE = "ai-summary-dlq";
const RETRY_LIMIT = 3;
const RETRY_DELAY = 10;

let boss = null;

/**
 * Start the pg-boss scheduler and register the AI-summary worker.
 * Must be called after database migrations and before the HTTP server starts
 * accepting requests.
 *
 * @param {import('socket.io').Server} io  Socket.IO server instance
 */
async function start(io) {
  const connectionString = env.databaseUrl;

  boss = new PgBoss(connectionString);

  boss.on("error", (err) => logger.error({ msg: "pg-boss error", error: err.message }));

  await boss.start();

  // pg-boss v10 requires queues to be created before send()/work() will do
  // anything with them — createQueue() is what wires up retryLimit/retryDelay
  // and the deadLetter routing below. The dead-letter queue must be created
  // first: pg-boss's own schema has a foreign key from a queue's
  // `dead_letter` column to another queue's name, so ai-summary-dlq has to
  // exist before ai-summary can reference it.
  await boss.createQueue(DEAD_LETTER_QUEUE);
  await boss.createQueue(QUEUE, { retryLimit: RETRY_LIMIT, retryDelay: RETRY_DELAY, deadLetter: DEAD_LETTER_QUEUE });

  await boss.work(QUEUE, { teamSize: 2, teamConcurrency: 1 }, handleSummaryJob(io));
  await boss.work(DEAD_LETTER_QUEUE, { includeMetadata: true }, handlePermanentFailure);

  logger.info({ msg: "pg-boss started, worker registered", queue: QUEUE });
}

function handleSummaryJob(io) {
  // pg-boss v10 always invokes a work() callback with an array of jobs (the
  // fetched batch), even when exactly one job was fetched — never a bare job.
  return async (jobs) => {
    for (const job of jobs) {
      await processSummaryJob(io, job);
    }
  };
}

async function processSummaryJob(io, job) {
  const { projectId, name, category, description, adminAddress, correlationId } = job.data;

  // Re-enter the original correlation context so every log line emitted
  // during this job (including retries in later sessions) carries the id
  // that was set when the HTTP request that triggered the job was handled.
  // runWithCorrelationId is a no-op when correlationId is falsy (jobs
  // enqueued before this change have no id).
  const run = (fn) =>
    correlationId ? runWithCorrelationId(correlationId, fn) : fn();

  await run(async () => {
    const jobLogger = logger.child({ projectId, jobId: job.id });
    jobLogger.info({ msg: "summary job started" });

    let summaryResult;
    try {
      summaryResult = await generateProjectSummary({ name, category, description });
    } catch (err) {
      if (err.code === "MISSING_API_KEY") {
        // Permanent misconfiguration — log and give up without retrying.
        jobLogger.error({ msg: "ANTHROPIC_API_KEY not set; skipping job" });
        return;
      }
      throw err; // pg-boss will retry according to retryLimit, then dead-letter
    }

    const sourceHash = crypto
      .createHash("sha256")
      .update(description || "")
      .digest("hex");

    const updated = await pool.query(
      `UPDATE projects
          SET ai_summary              = $1,
              ai_summary_generated_at = NOW(),
              ai_summary_model        = $2,
              ai_summary_source_hash  = $3,
              updated_at              = NOW()
        WHERE id = $4
        RETURNING ai_summary, ai_summary_generated_at, ai_summary_model`,
      [summaryResult.summary, summaryResult.model, sourceHash, projectId],
    );

    const row = updated.rows[0];
    if (!row) return; // project was deleted while job was queued

    // Same cross-replica problem as the donation feed: the pod running this
    // queue worker is rarely the pod holding the socket of the operator waiting
    // on the summary.
    if (io) {
      await publish("ai_summary_ready", {
        projectId,
        aiSummary:            row.ai_summary,
        aiSummaryGeneratedAt: new Date(row.ai_summary_generated_at).toISOString(),
        aiSummaryModel:       row.ai_summary_model,
      });
    }

    logAdminAction({
      actor: adminAddress || "system",
      action: "project.summary.generated",
      targetType: "project",
      targetId: projectId,
      metadata: { model: summaryResult.model },
      ipAddress: null,
    });

    jobLogger.info({ msg: "summary job completed", model: summaryResult.model });
  });
}

/**
 * Runs once a summary-generation job has exhausted RETRY_LIMIT attempts and
 * pg-boss has routed it to the dead-letter queue. Records the failure where
 * project admins can see it, logs it distinctly from a normal in-progress
 * retry, and fires the alerting hook.
 */
async function handlePermanentFailure(jobs) {
  for (const job of jobs) {
    await recordPermanentFailure(job);
  }
}

async function recordPermanentFailure(job) {
  const { projectId, ...payload } = job.data || {};
  const error = job.output || {};
  const correlationId = payload.correlationId;

  const failLogger = logger.child({ projectId, ...(correlationId && { correlationId }) });

  failLogger.error({
    msg: "job permanently failed after exhausting retries",
    error: error.message || "unknown error",
  });

  try {
    await pool.query(
      `INSERT INTO ai_summary_job_failures (id, project_id, payload, error_message, error_stack)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuid(), projectId, JSON.stringify(payload), error.message || null, error.stack || null],
    );
  } catch (err) {
    failLogger.error({ msg: "failed to record permanent job failure", error: err.message });
  }

  await module.exports.notifyRepeatedFailure({
    projectId,
    errorMessage: error.message || "unknown error",
    retryLimit: RETRY_LIMIT,
  });
}

/**
 * Alerting hook for a summary-generation job that has permanently failed
 * (i.e. failed repeatedly, exhausting every retry). No third-party alerting
 * provider exists in this codebase today, so this posts to a generic webhook
 * when one is configured (mirroring the RESEND_API_KEY-gated pattern in
 * services/email.js) and otherwise just logs — a clear extension point for
 * whichever alerting provider is wired up later.
 */
async function notifyRepeatedFailure({ projectId, errorMessage, retryLimit }) {
  if (!env.summaryFailureAlertWebhookUrl) {
    logger.warn({ msg: "SUMMARY_FAILURE_ALERT_WEBHOOK_URL not set — skipping alert", projectId });
    return;
  }

  try {
    await fetch(env.summaryFailureAlertWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "ai_summary_generation_permanently_failed",
        projectId,
        errorMessage,
        retryLimit,
      }),
    });
  } catch (err) {
    logger.error({ msg: "failed to deliver failure alert", error: err.message });
  }
}

/**
 * Enqueue an AI summary generation job.
 *
 * @param {string} projectId
 * @param {{ name: string, category: string, description: string, adminAddress?: string }} projectData
 * @returns {Promise<string>} job ID
 */
async function enqueueAISummary(projectId, projectData) {
  if (!boss) {
    throw new Error("summaryQueue not started — call start(io) first");
  }
  // Capture the correlation id from the current HTTP-request context
  // (AsyncLocalStorage) and embed it in the job payload so the background
  // worker can re-enter the same context even sessions later.
  const correlationId = getCorrelationId();
  const jobId = await boss.send(
    QUEUE,
    { projectId, ...projectData, ...(correlationId && { correlationId }) },
    { retryLimit: RETRY_LIMIT, retryDelay: RETRY_DELAY, deadLetter: DEAD_LETTER_QUEUE },
  );
  logger.info({ msg: "AI summary job enqueued", projectId, jobId });
  return jobId;
}

module.exports = { start, enqueueAISummary, notifyRepeatedFailure };
