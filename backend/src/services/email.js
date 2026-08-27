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
const { setJobQueueDepth, recordJobPermanentFailure } = require("../utils/metrics");

const logger = rootLogger.child({ service: "email-notify-queue" });

const QUEUE = "update-email-notify";
const DEAD_LETTER_QUEUE = "update-email-notify-dlq";
const RETRY_LIMIT = 3;
const RETRY_DELAY = 30;
// Resend accepts at most 50 "to" recipients per call — chunking the DB read
// at the same size means each queued job maps to exactly one Resend request,
// so a retry can't re-send a batch that already partially succeeded.
const EMAIL_CHUNK_SIZE = 50;
const QUEUE_DEPTH_POLL_INTERVAL_MS = 15_000;
const EMAIL_COPY = Object.freeze({
  en: { label: "Project Update", view: "View Project →", footer: "You're receiving this because you subscribed to updates for" },
  es: { label: "Actualización del proyecto", view: "Ver proyecto →", footer: "Recibes este mensaje porque te suscribiste a las novedades de" },
  ar: { label: "تحديث المشروع", view: "عرض المشروع ←", footer: "تصلك هذه الرسالة لأنك اشتركت في تحديثات" },
});

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
      recordJobPermanentFailure(QUEUE);
    }
  });

  const depthPoll = setInterval(() => pollQueueDepth(), QUEUE_DEPTH_POLL_INTERVAL_MS);
  depthPoll.unref();

  logger.info({ msg: "pg-boss started, worker registered", queue: QUEUE });
}

/** Reports current queue depth for scraping; failures are logged, not thrown — a stale gauge beats a crashed poller. */
async function pollQueueDepth() {
  try {
    setJobQueueDepth(QUEUE, await boss.getQueueSize(QUEUE));
    setJobQueueDepth(DEAD_LETTER_QUEUE, await boss.getQueueSize(DEAD_LETTER_QUEUE));
  } catch (err) {
    logger.error({ msg: "failed to poll queue depth", error: err.message });
  }
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
      `SELECT ps.id, ps.email, ps.preferred_language,
          COALESCE(pt.name, $4) AS localized_project_name,
          COALESCE(ut.title, $5) AS localized_update_title,
          COALESCE(ut.body, $6) AS localized_update_body,
          (pt.machine_translated IS TRUE OR ut.machine_translated IS TRUE) AS machine_translated
       FROM project_subscriptions ps
       LEFT JOIN project_translations pt
         ON pt.project_id = ps.project_id
        AND pt.language = ps.preferred_language
        AND pt.moderation_status = 'approved'
       LEFT JOIN project_update_translations ut
         ON ut.update_id = $7
        AND ut.language = ps.preferred_language
        AND ut.moderation_status = 'approved'
       WHERE ps.project_id = $1 AND ps.id > $2
       ORDER BY ps.id
       LIMIT $3`,
      [project.id, lastId, EMAIL_CHUNK_SIZE, project.name, update.title, update.body || "", update.id],
    );
    if (rows.length === 0) break;

    const languageGroups = new Map();
    for (const row of rows) {
      const language = EMAIL_COPY[row.preferred_language] ? row.preferred_language : "en";
      const key = [language, row.localized_project_name, row.localized_update_title,
        row.localized_update_body, Boolean(row.machine_translated)].join("\u0000");
      if (!languageGroups.has(key)) {
        languageGroups.set(key, {
          language,
          project: { ...project, name: row.localized_project_name || project.name },
          update: {
            ...update,
            title: row.localized_update_title || update.title,
            body: row.localized_update_body || update.body,
            machineTranslated: Boolean(row.machine_translated),
          },
          emails: [],
        });
      }
      languageGroups.get(key).emails.push(row.email);
    }
    for (const payload of languageGroups.values()) {
      await boss.send(
        QUEUE,
        payload,
        { retryLimit: RETRY_LIMIT, retryDelay: RETRY_DELAY, deadLetter: DEAD_LETTER_QUEUE },
      );
    }

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
async function sendUpdateNotifications({ project, update, emails, language = "en" }) {
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
      subject: `${EMAIL_COPY[language]?.label || EMAIL_COPY.en.label} — ${project.name}: ${update.title}`,
      html: buildHtml({ project, update, projectUrl, language }),
      text: buildText({ project, update, projectUrl, language }),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend error (${res.status}): ${body}`);
  }
}

function buildHtml({ project, update, projectUrl, language = "en" }) {
  const copy = EMAIL_COPY[language] || EMAIL_COPY.en;
  const direction = language === "ar" ? "rtl" : "ltr";
  const translationLabel = update.machineTranslated
    ? `<p style="margin:0 0 16px;font-size:12px;color:#8a6418;">${language === "ar" ? "ترجمة آلية — راجع النص الأصلي عند الحاجة" : language === "es" ? "Traducción automática — consulta el original cuando sea necesario" : "Machine translated — consult the original when needed"}</p>`
    : "";
  return `<!DOCTYPE html>
<html lang="${language}" dir="${direction}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f7f0;font-family:sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f7f0;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="background:#2d6a2d;padding:24px 32px;">
          <p style="margin:0;color:#ffffff;font-size:20px;font-weight:700;">🌱 Stellar GreenPay</p>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="margin:0 0 4px;font-size:13px;color:#8aaa8a;text-transform:uppercase;letter-spacing:.05em;">${copy.label}</p>
          <h1 style="margin:0 0 8px;font-size:22px;color:#1a3a1a;">${escHtml(update.title)}</h1>
          <p style="margin:0 0 24px;font-size:13px;color:#5a7a5a;">${escHtml(project.name)}</p>${translationLabel}
          <p style="margin:0 0 28px;font-size:15px;color:#3a5a3a;line-height:1.6;">${escHtml(update.body)}</p>
          <a href="${projectUrl}" style="display:inline-block;background:#2d6a2d;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;">${copy.view}</a>
        </td></tr>
        <tr><td style="padding:16px 32px;border-top:1px solid #e8f0e8;">
          <p style="margin:0;font-size:12px;color:#8aaa8a;">${copy.footer} <strong>${escHtml(project.name)}</strong>.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildText({ project, update, projectUrl, language = "en" }) {
  const copy = EMAIL_COPY[language] || EMAIL_COPY.en;
  return [
    `${copy.label} — ${project.name}`,
    "",
    update.title,
    "",
    update.body,
    update.machineTranslated ? `[${language === "ar" ? "ترجمة آلية" : language === "es" ? "Traducción automática" : "Machine translated"}]` : "",
    "",
    `View the project: ${projectUrl}`,
    "",
    `${copy.footer} ${project.name}.`,
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
