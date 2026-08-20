/**
 * src/services/push.js
 * Push notification service using Expo
 */
const { Expo } = require("expo-server-sdk");
const PgBoss = require("pg-boss");
const pool = require("../db/pool");

// Create a new Expo SDK client
const expo = new Expo();

const RECEIPT_QUEUE = "expo-push-receipts";
// Expo recommends checking receipts 15 minutes after sending: receipts are
// often available sooner, but 15 minutes gives their service a comfortable
// window, and receipts are cleared after 24 hours.
// https://docs.expo.dev/push-notifications/sending-notifications/
const RECEIPT_CHECK_DELAY_SECONDS = 900;

let boss = null;

/**
 * Start the pg-boss scheduler and register the receipt-checking worker.
 * Must be called once before sendUpdatePushNotifications can queue receipt checks.
 */
async function start() {
  const connectionString =
    process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/greenpay";

  boss = new PgBoss(connectionString);
  boss.on("error", (err) => console.error("[Push] pg-boss error:", err.message));

  await boss.start();
  await boss.work(RECEIPT_QUEUE, { teamSize: 1, teamConcurrency: 1 }, async (job) => {
    await checkPushReceipts(job.data.receipts);
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
 * Send push notification to device tokens following a project
 * @param {Object} params - { project, update }
 */
async function sendUpdatePushNotifications({ project, update }) {
  try {
    // Fetch all device tokens following this project
    const result = await pool.query(
      `SELECT dt.token, dt.platform 
       FROM project_follows pf
       JOIN device_tokens dt ON pf.device_token_id = dt.id
       WHERE pf.project_id = $1`,
      [project.id]
    );

    if (result.rows.length === 0) {
      console.log("[Push] No followers for project", project.id);
      return;
    }

    // Create push messages
    const messages = [];
    for (const row of result.rows) {
      // Check if the token is valid
      if (!Expo.isExpoPushToken(row.token)) {
        console.error(`[Push] Invalid push token: ${row.token}`);
        continue;
      }

      messages.push({
        to: row.token,
        sound: "default",
        title: `Update: ${project.name}`,
        body: update.title,
        data: {
          projectId: project.id,
          updateId: update.id,
          type: "project_update",
        },
      });
    }

    // Send notifications in chunks
    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      try {
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
      } catch (error) {
        console.error("[Push] Error sending chunk:", error);
      }
    }
  } catch (error) {
    console.error("[Push] Error sending push notifications:", error);
  }
}

module.exports = {
  sendUpdatePushNotifications,
  start,
  checkPushReceipts,
};
