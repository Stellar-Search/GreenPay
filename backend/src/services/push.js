/**
 * src/services/push.js
 * Push notification service using Expo
 *
 * Update fan-out to followers runs through a dedicated pg-boss queue instead
 * of loading every follower's device token into memory in one query: tokens
 * are read in bounded chunks (keyset pagination) and each chunk becomes one
 * retryable, observable job.
 */
const { Expo } = require("expo-server-sdk");
const PgBoss = require("pg-boss");
const pool = require("../db/pool");
const { env } = require("../config/env");
const { recordNotificationFailure } = require("./notificationFailures");

// Create a new Expo SDK client
const expo = new Expo();

const RECEIPT_QUEUE = "expo-push-receipts";
// Expo recommends checking receipts 15 minutes after sending: receipts are
// often available sooner, but 15 minutes gives their service a comfortable
// window, and receipts are cleared after 24 hours.
// https://docs.expo.dev/push-notifications/sending-notifications/
const RECEIPT_CHECK_DELAY_SECONDS = 900;

const UPDATE_PUSH_QUEUE = "update-push-notify";
const UPDATE_PUSH_DEAD_LETTER_QUEUE = "update-push-notify-dlq";
const RETRY_LIMIT = 3;
const RETRY_DELAY = 30;
// Expo's own chunking tops out at 100 messages per send call — chunking the
// DB read at the same size means each queued job maps to at most one Expo
// send call, so a retry can't re-send tokens that already went out.
const PUSH_CHUNK_SIZE = 100;

let boss = null;

/**
 * Start the pg-boss scheduler and register the receipt-checking and
 * update-push-notify workers. Must be called once before
 * sendUpdatePushNotifications can queue receipt checks or push batches.
 */
async function start() {
  const connectionString = env.databaseUrl;

  boss = new PgBoss(connectionString);
  boss.on("error", (err) => console.error("[Push] pg-boss error:", err.message));

  await boss.start();
  // pg-boss v10 requires a queue to be created before send()/work() do
  // anything with it.
  await boss.createQueue(RECEIPT_QUEUE);
  await boss.createQueue(UPDATE_PUSH_DEAD_LETTER_QUEUE);
  await boss.createQueue(UPDATE_PUSH_QUEUE, {
    retryLimit: RETRY_LIMIT,
    retryDelay: RETRY_DELAY,
    deadLetter: UPDATE_PUSH_DEAD_LETTER_QUEUE,
  });

  // pg-boss v10 always invokes a work() callback with an array of jobs (the
  // fetched batch), even when exactly one job was fetched — never a bare job.
  await boss.work(RECEIPT_QUEUE, { teamSize: 1, teamConcurrency: 1 }, async (jobs) => {
    for (const job of jobs) {
      const { receipts } = job.data;
      try {
        await checkPushReceipts(receipts);
      } catch (error) {
        const ticketIds = receipts.map((r) => r.ticketId);
        console.error(`[Push] Error checking receipts for tickets [${ticketIds.join(", ")}]:`, error);
        throw error; // pg-boss will retry according to retryLimit
      }
    }
  });

  await boss.work(UPDATE_PUSH_QUEUE, { teamSize: 2, teamConcurrency: 1 }, async (jobs) => {
    for (const job of jobs) {
      await sendPushToTokens(job.data);
    }
  });
  await boss.work(UPDATE_PUSH_DEAD_LETTER_QUEUE, { includeMetadata: true }, async (jobs) => {
    for (const job of jobs) {
      const { project, update, tokens } = job.data || {};
      await recordNotificationFailure({
        projectId: project?.id,
        updateId: update?.id,
        channel: "push",
        payload: { tokenCount: tokens?.length || 0 },
        error: job.output,
      });
    }
  });

  console.log("[Push] pg-boss started, worker registered on queue:", RECEIPT_QUEUE);
}

/**
 * Queue a delayed check of the Expo receipts for a batch of sent tickets.
 * @param {Array<{ticketId: string, token: string}>} receipts
 */
async function enqueuePushReceiptCheck(receipts) {
  if (receipts.length === 0) return;
  if (!boss) {
    console.error("[Push] Receipt queue not started; skipping receipt check for this chunk");
    return;
  }
  await boss.send(
    RECEIPT_QUEUE,
    { receipts },
    { startAfter: RECEIPT_CHECK_DELAY_SECONDS, retryLimit: 3 },
  );
}

/**
 * Fetch Expo delivery receipts for previously sent tickets and prune any
 * device_tokens rows that Expo reports as DeviceNotRegistered.
 * @param {Array<{ticketId: string, token: string}>} receipts
 */
async function checkPushReceipts(receipts) {
  const ticketIdToToken = new Map(receipts.map((r) => [r.ticketId, r.token]));
  const receiptChunks = expo.chunkPushNotificationReceiptIds(receipts.map((r) => r.ticketId));

  for (const chunk of receiptChunks) {
    let receiptData;
    try {
      receiptData = await expo.getPushNotificationReceiptsAsync(chunk);
    } catch (error) {
      console.error("[Push] Error fetching receipts:", error);
      continue;
    }

    const staleTokens = [];
    for (const [ticketId, receipt] of Object.entries(receiptData)) {
      if (receipt.status !== "error") continue;

      if (receipt.details?.error === "DeviceNotRegistered") {
        staleTokens.push(ticketIdToToken.get(ticketId));
      } else {
        console.error(`[Push] Delivery error for ticket ${ticketId}:`, receipt.message);
      }
    }

    if (staleTokens.length > 0) {
      await pruneDeviceTokens(staleTokens);
    }
  }
}

async function pruneDeviceTokens(tokens) {
  const result = await pool.query("DELETE FROM device_tokens WHERE token = ANY($1::text[])", [
    tokens,
  ]);
  console.log(`[Push] Pruned ${result.rowCount} device token(s) reported as DeviceNotRegistered`);
}

/**
 * Reads device tokens following a project in bounded chunks (keyset
 * pagination on project_follows.id — never a single unbounded SELECT) and
 * enqueues one retryable job per chunk on the update-push-notify queue.
 * @param {Object} params - { project, update }
 */
async function sendUpdatePushNotifications({ project, update }) {
  if (!boss) {
    throw new Error(`push notification queue not started for project ${project.id}`);
  }

  let lastId = "00000000-0000-0000-0000-000000000000";
  let queued = 0;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT pf.id, dt.token, dt.platform
       FROM project_follows pf
       JOIN device_tokens dt ON pf.device_token_id = dt.id
       LEFT JOIN project_update_push_recipients pr
         ON pr.update_id = $4 AND pr.token = dt.token
       WHERE pf.project_id = $1 AND pf.id > $2 AND pr.token IS NULL
       ORDER BY pf.id
       LIMIT $3`,
      [project.id, lastId, PUSH_CHUNK_SIZE, update.id],
    );
    if (rows.length === 0) break;

    const tokens = rows.map((row) => ({ token: row.token, platform: row.platform || "unknown" }));
    const claim = await pool.query(
      `INSERT INTO project_update_push_recipients (update_id, token, platform)
       SELECT $1, token, platform
       FROM unnest($2::text[], $3::text[]) AS recipient(token, platform)
       ON CONFLICT (update_id, token) DO NOTHING
       RETURNING token`,
      [update.id, tokens.map((row) => row.token), tokens.map((row) => row.platform)],
    );
    const claimed = new Set(claim.rows.map((row) => row.token));
    const claimedTokens = tokens.filter((row) => claimed.has(row.token));
    if (claimedTokens.length > 0) {
      try {
        await boss.send(
          UPDATE_PUSH_QUEUE,
          { project, update, tokens: claimedTokens },
          { retryLimit: RETRY_LIMIT, retryDelay: RETRY_DELAY, deadLetter: UPDATE_PUSH_DEAD_LETTER_QUEUE },
        );
      } catch (error) {
        await pool.query(
          `DELETE FROM project_update_push_recipients
           WHERE update_id = $1 AND token = ANY($2::text[])`,
          [update.id, claimedTokens.map((row) => row.token)],
        );
        throw error;
      }
      queued += claimedTokens.length;
    }

    lastId = rows[rows.length - 1].id;
    if (rows.length < PUSH_CHUNK_SIZE) break;
  }

  if (queued === 0) {
    console.log("[Push] No followers for project", project.id);
  }
}

/** Queue a follow-up for the exact device tokens that received the original. */
async function sendUpdateRemovalPushNotifications({ project, update, reason }) {
  if (!boss) {
    throw new Error(`push notification queue not started for project ${project.id}`);
  }

  let lastToken = "";
  for (;;) {
    const { rows } = await pool.query(
      `SELECT token, platform FROM project_update_push_recipients
       WHERE update_id = $1 AND token > $2 AND correction_queued_at IS NULL
       ORDER BY token LIMIT $3`,
      [update.id, lastToken, PUSH_CHUNK_SIZE],
    );
    if (rows.length === 0) break;

    const claim = await pool.query(
      `UPDATE project_update_push_recipients SET correction_queued_at = NOW()
       WHERE update_id = $1 AND token = ANY($2::text[])
         AND correction_queued_at IS NULL
       RETURNING token`,
      [update.id, rows.map((row) => row.token)],
    );
    const claimed = new Set(claim.rows.map((row) => row.token));
    const tokens = rows.filter((row) => claimed.has(row.token));
    if (tokens.length > 0) {
      try {
        await boss.send(
          UPDATE_PUSH_QUEUE,
          { project, update, tokens, kind: "removed", reason },
          { retryLimit: RETRY_LIMIT, retryDelay: RETRY_DELAY, deadLetter: UPDATE_PUSH_DEAD_LETTER_QUEUE },
        );
      } catch (error) {
        await pool.query(
          `UPDATE project_update_push_recipients SET correction_queued_at = NULL
           WHERE update_id = $1 AND token = ANY($2::text[])`,
          [update.id, tokens.map((row) => row.token)],
        );
        throw error;
      }
    }

    lastToken = rows[rows.length - 1].token;
    if (rows.length < PUSH_CHUNK_SIZE) break;
  }
}

/**
 * Send push notifications to one chunk of device tokens. Called by the
 * update-push-notify worker — throws on an Expo send failure so pg-boss
 * retries the batch instead of silently dropping it.
 * @param {Object} params - { project, update, tokens }
 * @param {Array<{token:string,platform:string}>} params.tokens
 */
async function sendPushToTokens({ project, update, tokens, kind = "published", reason = null }) {
  const messages = [];
  for (const row of tokens) {
    if (!Expo.isExpoPushToken(row.token)) {
      console.error(`[Push] Invalid push token: ${row.token}`);
      continue;
    }

    messages.push({
      to: row.token,
      sound: "default",
      title: kind === "removed" ? `Update correction: ${project.name}` : `Update: ${project.name}`,
      body: kind === "removed"
        ? `${update.title} was removed after review${reason ? `: ${reason}` : "."}`
        : update.title,
      data: {
        projectId: project.id,
        updateId: update.id,
        type: kind === "removed" ? "project_update_removed" : "project_update",
      },
    });
  }

  if (messages.length === 0) return;

  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    const tickets = await expo.sendPushNotificationsAsync(chunk);
    console.log(`[Push] Sent ${tickets.length} notifications for project ${project.id}`);

    // A ticket only means "accepted for delivery attempt", not delivered —
    // queue a delayed check of the receipts Expo generates for it.
    const receipts = [];
    tickets.forEach((ticket, index) => {
      if (ticket.status === "ok" && ticket.id) {
        receipts.push({ ticketId: ticket.id, token: chunk[index].to });
      }
    });
    try {
      await enqueuePushReceiptCheck(receipts);
    } catch (error) {
      console.error("[Push] Error queuing receipt check:", error);
    }
  }
}

module.exports = {
  sendUpdatePushNotifications,
  sendUpdateRemovalPushNotifications,
  sendPushToTokens,
  start,
  checkPushReceipts,
};
