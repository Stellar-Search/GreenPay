/**
 * backend/src/services/indexerService.js
 */
"use strict";

const { server: stellarServer, rpcServer, CONTRACT_ID } = require("./stellar");
const pool = require("../db/pool");
const { v4: uuid } = require("uuid");
const { execute } = require("../eventSourcing/commandBus");
const { DonationRecordedEvent, MatchAppliedEvent } = require("../eventSourcing/events");
const { stroopsToXlm, xlmToStroops } = require("../utils/xlm");
const { SorobanEventIndexer } = require("./sorobanEventIndexer");
const { publish } = require("../realtime");
const {
  queueDonationAssessment,
  observeNativePayment,
  refreshIntegrityWatchlist,
  startIntegrityWorker,
  stopIntegrityWorker,
  getIntegrityWorkerStatus,
} = require("./donationIntegrity");

let lastProcessedLedger = 0;
let isRunning = false;
let io = null;
let projectWallets = new Map(); // wallet_address -> project_id
let refreshIntervalId = null;
let closeStream = null;
let cursorFlushIntervalId = null;
let sorobanEventIndexer = null;

const CURSOR_KEY = "horizon_operations_cursor";
const CURSOR_FLUSH_INTERVAL_MS = 30_000;

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
 * Load the last successfully processed ledger cursor from the database.
 * Returns null on the very first start (no row yet).
 */
async function loadCursor() {
  try {
    const result = await pool.query(
      "SELECT value FROM indexer_state WHERE key = $1",
      [CURSOR_KEY]
    );
    if (result.rows.length > 0) {
      return result.rows[0].value;
    }
  } catch (err) {
    console.error("[Indexer] Failed to load cursor:", err.message);
  }
  return null;
}

/**
 * Persist the current processing cursor so the stream can resume after
 * a restart. Uses UPSERT so concurrent calls are safe.
 */
async function persistCursor(cursor) {
  if (!cursor) return;
  try {
    await pool.query(
      `INSERT INTO indexer_state (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [CURSOR_KEY, String(cursor)]
    );
  } catch (err) {
    console.error("[Indexer] Failed to persist cursor:", err.message);
  }
}

/**
 * Start the Stellar indexer service.
 * @param {Object} socketIo - The Socket.io server instance.
 */
async function startIndexer(socketIo) {
  if (isRunning) return;
  isRunning = true;
  io = socketIo;

  await updateProjectWallets();
  await refreshIntegrityWatchlist();
  startIntegrityWorker();
  // Refresh cache every 10 minutes
  refreshIntervalId = setInterval(updateProjectWallets, 10 * 60 * 1000);

  const persistedCursor = await loadCursor();

  if (persistedCursor) {
    console.log(`[Indexer] Resuming from persisted cursor: ${persistedCursor}`);
    lastProcessedLedger = Number(persistedCursor);
  } else {
    lastProcessedLedger = 0;
    console.log("[Indexer] No persisted cursor found, starting from now");
  }

  console.log("[Indexer] Starting Horizon operations stream...");

  // Start streaming operations from the persisted cursor (or "now" on first start)
  closeStream = stellarServer.operations()
    .cursor(persistedCursor || "now")
    .stream({
      onmessage: async (op) => {
        try {
          lastProcessedLedger = op.ledger_attr;

          // Integrity flow observation runs for every native payment adjacent
          // to a controlled or watched address. Donation handling remains
          // limited to transfers whose destination is an active project.
          if (op.type === "payment" && op.asset_type === "native") {
            await observeNativePayment(op).catch((error) => {
              console.error("[Indexer] Failed to record integrity flow:", error.message);
            });
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

  cursorFlushIntervalId = setInterval(() => {
    if (lastProcessedLedger) {
      persistCursor(lastProcessedLedger);
    }
  }, CURSOR_FLUSH_INTERVAL_MS);

  if (CONTRACT_ID) {
    sorobanEventIndexer = new SorobanEventIndexer({
      rpcServer,
      contractId: CONTRACT_ID,
      db: pool,
      handleDonation,
      pollIntervalMs: Number(process.env.SOROBAN_EVENT_POLL_INTERVAL_MS) || undefined,
    });
    await sorobanEventIndexer.start();
  }
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
  const amountStroops = op.amount_stroops !== undefined
    ? BigInt(op.amount_stroops)
    : xlmToStroops(op.amount);
  const amountXLM = stroopsToXlm(amountStroops);
  const amountXLMNumber = Number.parseFloat(amountXLM);

  const client = await pool.connect();
  let inTransaction = false;

  try {
    const existingResult = await client.query(
      `SELECT event_id, payload, occurred_at FROM event_stream
       WHERE event_type = 'DonationRecorded'
         AND payload->'data'->>'transactionHash' = $1`,
      [txHash]
    );
    if (existingResult.rows.length > 0) {
      await queueDonationAssessment(client, {
        transactionHash: txHash,
        projectId,
        donorAddress,
        destinationAddress: op.to || null,
        amountXlm: amountXLM,
        observedSource: op.integrity_source || "indexer_horizon",
        ledger: op.ledger_attr || null,
        observedAt: op.created_at || existingResult.rows[0].occurred_at || null,
      });
      return true;
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
        amountStroops: amountStroops.toString(),
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
          const matchAmount = Math.min(amountXLMNumber * match.multiplier, remaining);

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

    await queueDonationAssessment(client, {
      transactionHash: txHash,
      projectId,
      donorAddress,
      destinationAddress: op.to || null,
      amountXlm: amountXLM,
      observedSource: op.integrity_source || "indexer_horizon",
      ledger: op.ledger_attr || null,
      observedAt: op.created_at || null,
    });

    await client.query("COMMIT");
    inTransaction = false;

    console.log(`[Indexer] New donation: ${amountXLM} XLM from ${donorAddress} to project ${projectId}`);

    // Broadcast through the shared adapter so every replica's clients see it,
    // not just the ones attached to whichever pod happens to run the indexer.
    // The indexer runs on every pod, so this is the emit that most obviously
    // needed fanning out. `io` is still checked because startIndexer() is
    // called without one in several tests.
    if (io) {
      await publish("donation_event", {
        projectId,
        donorAddress,
        amountXLM: amountXLMNumber,
        transactionHash: txHash,
        timestamp: new Date().toISOString()
      });
    }
    return true;
  } catch (err) {
    if (inTransaction) await client.query("ROLLBACK");
    console.error("[Indexer] Failed to process donation:", err.message);
    return false;
  } finally {
    client.release();
  }
}

/**
 * Stop the Horizon stream and the wallet-cache refresh interval, so the
 * indexer performs no further work — and no further database queries —
 * once shutdown has begun.
 */
async function stopIndexer() {
  if (!isRunning) return;

  if (refreshIntervalId) {
    clearInterval(refreshIntervalId);
    refreshIntervalId = null;
  }
  if (cursorFlushIntervalId) {
    clearInterval(cursorFlushIntervalId);
    cursorFlushIntervalId = null;
  }
  if (typeof closeStream === "function") {
    closeStream();
    closeStream = null;
  }

  if (lastProcessedLedger) {
    persistCursor(lastProcessedLedger);
  }
  if (sorobanEventIndexer) {
    await sorobanEventIndexer.stop();
    sorobanEventIndexer = null;
  }
  stopIntegrityWorker();

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
    integrity: getIntegrityWorkerStatus(),
    soroban: sorobanEventIndexer?.getStatus() || null,
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
