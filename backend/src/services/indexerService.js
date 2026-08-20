/**
 * backend/src/services/indexerService.js
 */
"use strict";

const { server: stellarServer } = require("./stellar");
const pool = require("../db/pool");
const { v4: uuid } = require("uuid");
const { execute } = require("../eventSourcing/commandBus");
const { DonationRecordedEvent, MatchAppliedEvent } = require("../eventSourcing/events");

let lastProcessedLedger = 0;
let isRunning = false;
let io = null;
let projectWallets = new Map(); // wallet_address -> project_id
let refreshIntervalId = null;
let closeStream = null;

/**
 * Fetch all active project wallets and cache them.
 */
async function updateProjectWallets() {
  try {
    const result = await pool.query("SELECT id, wallet_address FROM projects WHERE status = 'active'");
    projectWallets.clear();
    for (const row of result.rows) {
      projectWallets.set(row.wallet_address, row.id);
    }
    console.log(`[Indexer] Updated cache with ${projectWallets.size} project wallets.`);
  } catch (err) {
    console.error("[Indexer] Failed to update project wallets cache:", err.message);
  }
}

/**
 * Refresh the in-memory cache of active project wallet addresses.
 *
 * @returns {Promise<void>} Resolves after the cache is updated.
 */
// internal helper

/**
 * Start the Stellar indexer service.
 * @param {Object} socketIo - The Socket.io server instance.
 */
async function startIndexer(socketIo) {
  if (isRunning) return;
  isRunning = true;
  io = socketIo;

  await updateProjectWallets();
  // Refresh cache every 10 minutes
  refreshIntervalId = setInterval(updateProjectWallets, 10 * 60 * 1000);

  console.log("[Indexer] Starting Horizon operations stream...");

  // Start streaming operations from 'now'
  closeStream = stellarServer.operations()
    .cursor("now")
    .stream({
      onmessage: async (op) => {
        try {
          lastProcessedLedger = op.ledger_attr;

          // We only care about XLM payments
          if (op.type === "payment" && op.asset_type === "native") {
            const projectId = projectWallets.get(op.to);
            if (projectId) {
              await handleDonation(projectId, op);
            }
          }
        } catch (err) {
          console.error("[Indexer] Error processing operation:", err.message);
        }
      },
      onerror: (err) => {
        console.error("[Indexer] Stream error:", err);
      }
    });
}

/**
 * Start the Stellar indexer service which streams Horizon operations and
 * processes project donations.
 *
 * @param {import('socket.io').Server} socketIo - Socket.io server instance used for websocket events.
 * @returns {Promise<void>} Resolves when the indexer is started.
 */
// exported as `startIndexer`

/**
 * Handle a payment to a project via Event Sourcing CQRS.
 */
async function handleDonation(projectId, op) {
  const txHash = op.transaction_hash;
  const donorAddress = op.from;
  const amountXLM = parseFloat(op.amount);

  const client = await pool.connect();
  let inTransaction = false;

  try {
    const existingResult = await client.query(
      `SELECT event_id FROM event_stream
       WHERE event_type = 'DonationRecorded'
         AND payload->'data'->>'transactionHash' = $1`,
      [txHash]
    );
    if (existingResult.rows.length > 0) {
      return;
    }

    await client.query("BEGIN");
    inTransaction = true;

    const matchesResult = await client.query(
      `SELECT id, matcher_address, cap_xlm, matched_xlm, multiplier
       FROM donation_matches
       WHERE project_id = $1 AND expires_at > NOW()`,
      [projectId],
    );

    const donationResult = await execute(
      new (require("../eventSourcing/commands").RecordDonationCommand)({
        actor: donorAddress,
        projectId,
        donorAddress,
        amountXLM,
        amount: amountXLM,
        currency: "XLM",
        message: null,
        transactionHash: txHash,
      }),
      client
    );

    if (matchesResult.rows.length > 0 && !donationResult.deduplicated) {
      for (const match of matchesResult.rows) {
        const matchedXlm = parseFloat(match.matched_xlm || "0");
        const capXlm = parseFloat(match.cap_xlm);
        const remaining = capXlm - matchedXlm;

        if (remaining > 0) {
          const matchAmount = Math.min(amountXLM * match.multiplier, remaining);

          await execute(
            new (require("../eventSourcing/commands").ApplyMatchCommand)({
              actor: donorAddress,
              matchId: match.id,
              projectId,
              donorAddress: match.matcher_address,
              matchAmount,
              originalTxHash: txHash,
              multiplier: match.multiplier,
            }),
            client
          );
        }
      }
    }

    await client.query("COMMIT");
    inTransaction = false;

    console.log(`[Indexer] New donation: ${amountXLM} XLM from ${donorAddress} to project ${projectId}`);

    if (io) {
      io.emit("donation_event", {
        projectId,
        donorAddress,
        amountXLM,
        transactionHash: txHash,
        timestamp: new Date().toISOString()
      });
    }
  } catch (err) {
    if (inTransaction) await client.query("ROLLBACK");
    console.error("[Indexer] Failed to process donation:", err.message);
  } finally {
    client.release();
  }
}

/**
 * Stop the Horizon stream and the wallet-cache refresh interval, so the
 * indexer performs no further work — and no further database queries —
 * once shutdown has begun.
 */
function stopIndexer() {
  if (!isRunning) return;

  if (refreshIntervalId) {
    clearInterval(refreshIntervalId);
    refreshIntervalId = null;
  }
  if (typeof closeStream === "function") {
    closeStream();
    closeStream = null;
  }

  isRunning = false;
  console.log("[Indexer] Stopped");
}

/**
 * Returns the indexer status for the health endpoint.
 */
function getStatus() {
  return {
    isRunning,
    lastProcessedLedger,
    projectWalletsCount: projectWallets.size,
    timestamp: new Date().toISOString()
  };
}

/**
 * Get the current indexer status used by the health endpoint.
 *
 * @returns {{isRunning:boolean,lastProcessedLedger:number,projectWalletsCount:number,timestamp:string}}
 */
// exported as `getStatus`

module.exports = {
  startIndexer,
  stopIndexer,
  getStatus,
  handleDonation
};
