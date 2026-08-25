/**
 * src/services/email.js — Transactional email via Resend
 *
 * Update-notification fan-out runs through a dedicated pg-boss queue instead
 * of being sent inline from the request that created the update: subscriber
 * lists are read from the database in bounded chunks (never "SELECT * and
 * hold it all in memory") and each chunk becomes one retryable, observable
 * job rather than one giant fire-and-forget promise.
 */
"use strict";

const PgBoss = require("pg-boss");
const pool = require("../db/pool");
const { env } = require("../config/env");
const { logger: rootLogger } = require("../utils/logger");
const { recordNotificationFailure } = require("./notificationFailures");

const logger = rootLogger.child({ service: "email-notify-queue" });

const QUEUE = "update-email-notify";
const DEAD_LETTER_QUEUE = "update-email-notify-dlq";
const RETRY_LIMIT = 3;
const RETRY_DELAY = 30;
// Resend accepts at most 50 "to" recipients per call — chunking the DB read
// at the same size means each queued job maps to exactly one Resend request,
// so a retry can't re-send a batch that already partially succeeded.
const EMAIL_CHUNK_SIZE = 50;

let boss = null;

/**
 * Start the pg-boss scheduler and register the update-email-notify worker.
 * Must be called once before enqueueUpdateNotifications can queue jobs.
 */
async function start() {
  boss = new PgBoss(env.databaseUrl);
  boss.on("error", (err) => logger.error({ msg: "pg-boss error", error: err.message }));

  await boss.start();
  await boss.createQueue(DEAD_LETTER_QUEUE);
  await boss.createQueue(QUEUE, { retryLimit: RETRY_LIMIT, retryDelay: RETRY_DELAY, deadLetter: DEAD_LETTER_QUEUE });

  // pg-boss v10 always invokes a work() callback with an array of jobs (the
  // fetched batch), even when exactly one job was fetched — never a bare job.
  await boss.work(QUEUE, { teamSize: 2, teamConcurrency: 1 }, async (jobs) => {
    for (const job of jobs) {
      await sendUpdateNotifications(job.data);
    }
  });
  await boss.work(DEAD_LETTER_QUEUE, { includeMetadata: true }, async (jobs) => {
    for (const job of jobs) {
      const { project, update, emails } = job.data || {};
      await recordNotificationFailure({
        projectId: project?.id,
        updateId: update?.id,
        channel: "email",
        payload: { emailCount: emails?.length || 0 },
        error: job.output,
      });
    }
  });

  logger.info({ msg: "pg-boss started, worker registered", queue: QUEUE });
}

/**
 * Reads subscriber emails for a project in bounded chunks (keyset pagination
 * on id — never a single unbounded SELECT) and enqueues one retryable job per
 * chunk on the update-email-notify queue.
 *
 * @param {{project:object, update:object}} opts
 */
async function enqueueUpdateNotifications({ project, update }) {
  if (!boss) {
    throw new Error("email notification queue not started — call start() first");
  }

  let lastId = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const { rows } = await pool.query(
      `SELECT id, email FROM project_subscriptions
       WHERE project_id = $1 AND id > $2
       ORDER BY id
       LIMIT $3`,
      [project.id, lastId, EMAIL_CHUNK_SIZE],
    );
    if (rows.length === 0) break;

    const emails = rows.map((r) => r.email);
    await boss.send(
      QUEUE,
      { project, update, emails },
      { retryLimit: RETRY_LIMIT, retryDelay: RETRY_DELAY, deadLetter: DEAD_LETTER_QUEUE },
    );

    lastId = rows[rows.length - 1].id;
    if (rows.length < EMAIL_CHUNK_SIZE) break;
  }
}

/**
 * Send one chunk of update notification emails via Resend. Called by the
 * update-email-notify worker — throws on a Resend failure so pg-boss retries
 * the batch rather than silently dropping it.
 *
 * @param {{project:object,update:object,emails:string[]}} opts
 * @param {object} opts.project - Project object with at least `id` and `name`.
 * @param {object} opts.update - Update object with `title` and `body`.
 * @param {string[]} opts.emails - Recipient email addresses (already chunked to <=50).
 * @returns {Promise<void>}
 * @throws {Error} When the Resend API returns an unexpected failure.
 */
async function sendUpdateNotifications({ project, update, emails }) {
  if (!env.resendApiKey) {
    console.warn("[email] RESEND_API_KEY not set — skipping notifications");
    return;
  }
  if (!emails || emails.length === 0) return;

  const projectUrl = `${env.appUrl}/projects/${project.id}`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.emailFrom,
      to: emails,
      subject: `Update from ${project.name}: ${update.title}`,
      html: buildHtml({ project, update, projectUrl }),
      text: buildText({ project, update, projectUrl }),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend error (${res.status}): ${body}`);
  }
}

function buildHtml({ project, update, projectUrl }) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f7f0;font-family:sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f7f0;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="background:#2d6a2d;padding:24px 32px;">
          <p style="margin:0;color:#ffffff;font-size:20px;font-weight:700;">🌱 Stellar GreenPay</p>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="margin:0 0 4px;font-size:13px;color:#8aaa8a;text-transform:uppercase;letter-spacing:.05em;">Project Update</p>
          <h1 style="margin:0 0 8px;font-size:22px;color:#1a3a1a;">${escHtml(update.title)}</h1>
          <p style="margin:0 0 24px;font-size:13px;color:#5a7a5a;">${escHtml(project.name)}</p>
          <p style="margin:0 0 28px;font-size:15px;color:#3a5a3a;line-height:1.6;">${escHtml(update.body)}</p>
          <a href="${projectUrl}" style="display:inline-block;background:#2d6a2d;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;">View Project →</a>
        </td></tr>
        <tr><td style="padding:16px 32px;border-top:1px solid #e8f0e8;">
          <p style="margin:0;font-size:12px;color:#8aaa8a;">You're receiving this because you subscribed to updates for <strong>${escHtml(project.name)}</strong>.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildText({ project, update, projectUrl }) {
  return [
    `Project Update — ${project.name}`,
    "",
    update.title,
    "",
    update.body,
    "",
    `View the project: ${projectUrl}`,
    "",
    `You're receiving this because you subscribed to updates for ${project.name}.`,
  ].join("\n");
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = { start, enqueueUpdateNotifications, sendUpdateNotifications };
