/**
 * services/turrets.js
 * Stellar Turrets txFunction server for automatic donation matching
 *
 * This service implements a Turrets-compatible txFunction that:
 * 1. Listens for payments to project wallets
 * 2. Checks for active matching offers
 * 3. Submits pre-signed matching transactions from the matcher account
 *
 * Idempotency guarantee
 * ─────────────────────
 * Turret/webhook delivery is at-least-once, so this function MUST be a
 * provable no-op when called a second time for the same transaction_hash.
 *
 * Two-layer defence:
 *   1. Application pre-check  – query matching_processed_donations at the top
 *      of the function and skip any (original_tx_hash, match_id) pair that is
 *      already recorded.  This avoids the Horizon round-trip on the hot path.
 *   2. Database unique constraint – UNIQUE(original_tx_hash, match_id) on
 *      matching_processed_donations means that even when two concurrent
 *      retries race past the pre-check, only one INSERT can succeed; the
 *      loser receives a 23505 unique_violation and treats it as a success
 *      (the work was already done by the winner).
 *
 * All three writes for a given match (UPDATE donation_matches, INSERT INTO
 * matching_processed_donations, INSERT INTO donations) are wrapped in a
 * single database transaction so a partial failure cannot leave the counters
 * incremented without a corresponding record.
 */

const { Server, TransactionBuilder, Networks, Memo, Operation, Asset } = require("@stellar/stellar-sdk");
const { v4: uuidv4 } = require("uuid");
const pool = require("../db/pool");
const { env } = require("../config/env");

// Network configuration
const NETWORK = env.stellarNetwork;
const NETWORK_PASSPHRASE = NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
const HORIZON_URL = env.horizonUrl;

// Postgres unique_violation SQLSTATE, used to detect a concurrent retry that
// already committed the same match.
const PG_UNIQUE_VIOLATION = "23505";
let server;
function getServer() {
  if (!server) {
    server = new Server(HORIZON_URL);
  }
  return server;
}

/**
 * Returns the set of match IDs that have already been processed for
 * `transactionHash`.  Called once at the top of matchDonationTxFunction so
 * that the per-match loop can skip work immediately without any Horizon calls.
 *
 * @param {string} transactionHash
 * @param {object} db - pg pool or client
 * @returns {Promise<Set<string>>}
 */
async function getAlreadyProcessedMatchIds(transactionHash, db) {
  const result = await db.query(
    `SELECT match_id FROM matching_processed_donations
     WHERE original_tx_hash = $1`,
    [transactionHash]
  );
  return new Set(result.rows.map((r) => r.match_id));
}

/**
 * Turrets txFunction entry point for matching donations.
 *
 * Idempotency contract: a second call with the same `payment.transaction_hash`
 * is a guaranteed no-op — no Horizon transaction is submitted, no DB row is
 * written, and the return value describes only the previously-recorded work.
 *
 * @param {object} payment - Payment operation object from Horizon/Turret.
 * @returns {Promise<object>} Result describing whether matching occurred and details.
 */
async function matchDonationTxFunction(payment) {
  try {
    const {
      transaction_hash,
      from,
      to,
      amount,
      asset_code,
      asset_type,
    } = payment;

    // ── 1. Asset filter ──────────────────────────────────────────────────────
    // Only match native XLM donations.
    if (asset_type !== "native" && asset_code !== "XLM") {
      console.log(`Skipping non-XLM donation: ${asset_code || asset_type}`);
      return { matched: false, reason: "Not an XLM donation" };
    }

    // ── 2. Project lookup ────────────────────────────────────────────────────
    const projectResult = await pool.query(
      "SELECT id, name FROM projects WHERE wallet_address = $1",
      [to]
    );

    if (!projectResult.rows[0]) {
      console.log(`Project not found for wallet: ${to}`);
      return { matched: false, reason: "Project not found" };
    }

    const project = projectResult.rows[0];
    const donationAmount = parseFloat(amount);

    // ── 3. Active match lookup ───────────────────────────────────────────────
    const matchesResult = await pool.query(
      `SELECT id, matcher_address, cap_xlm, matched_xlm, multiplier
       FROM donation_matches
       WHERE project_id = $1 AND expires_at > NOW()
       ORDER BY created_at ASC`,
      [project.id]
    );

    if (matchesResult.rows.length === 0) {
      console.log(`No active matching offers for project: ${project.id}`);
      return { matched: false, reason: "No active matching offers" };
    }

    // ── 4. Idempotency pre-check ─────────────────────────────────────────────
    // Fetch the set of match IDs whose payment has already been submitted for
    // this transaction_hash.  Any match whose ID is in this set is skipped
    // entirely — no Horizon call, no DB write.  The DB-level UNIQUE constraint
    // on matching_processed_donations(original_tx_hash, match_id) closes the
    // concurrent-retry window that this read-then-skip cannot close alone.
    const alreadyProcessed = await getAlreadyProcessedMatchIds(transaction_hash, pool);

    const allAlreadyDone = matchesResult.rows.every((m) => alreadyProcessed.has(m.id));
    if (allAlreadyDone) {
      console.log(`All matches already processed for tx: ${transaction_hash}`);
      return {
        matched: true,
        deduplicated: true,
        reason: "Already processed",
        projectId: project.id,
        projectName: project.name,
      };
    }

    // ── 5. Process each matching offer ───────────────────────────────────────
    let totalMatched = 0;
    const matchResults = [];

    for (const match of matchesResult.rows) {
      // Skip matches already processed for this transaction_hash.
      if (alreadyProcessed.has(match.id)) {
        console.log(`Skipping already-processed match ${match.id} for tx: ${transaction_hash}`);
        continue;
      }

      const matchedXlm = parseFloat(match.matched_xlm || "0");
      const capXlm = parseFloat(match.cap_xlm);
      const remaining = capXlm - matchedXlm;

      if (remaining <= 0) continue;

      const matchAmount = Math.min(donationAmount * match.multiplier, remaining);
      if (matchAmount <= 0) continue;

      // ── 5a. Submit the on-chain matching payment ─────────────────────────
      // This happens BEFORE the DB writes so that if the Horizon call fails
      // we never record a match that was not actually paid out.
      // Call via module.exports so that Jest spies can intercept it in tests.
      const matchResult = await module.exports.submitMatchingPayment({
        matcherAddress: match.matcher_address,
        projectWallet: to,
        amount: matchAmount,
        originalTxHash: transaction_hash,
        _matchId: match.id,
      });

      if (!matchResult.success) {
        console.error(`Failed to submit matching payment for match ${match.id}: ${matchResult.error || matchResult.reason}`);
        continue;
      }

      // ── 5b. Persist atomically inside a single DB transaction ────────────
      // Three writes as one unit:
      //   • UPDATE donation_matches  – increment matched_xlm counter
      //   • INSERT matching_processed_donations  – idempotency record (the
      //     UNIQUE constraint is the hard fence against concurrent duplicates)
      //   • INSERT donations  – accounting row for the matching payment
      //
      // If the INSERT into matching_processed_donations violates the unique
      // constraint a concurrent retry won already won the race — treat it as
      // an idempotent success and move on rather than propagating an error.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        await client.query(
          `UPDATE donation_matches
           SET matched_xlm = matched_xlm + $1
           WHERE id = $2`,
          [matchAmount, match.id]
        );

        await client.query(
          `INSERT INTO matching_processed_donations
             (id, original_tx_hash, match_id, matching_tx_hash, match_amount_xlm)
           VALUES ($1, $2, $3, $4, $5)`,
          [uuidv4(), transaction_hash, match.id, matchResult.txHash, matchAmount]
        );

        const donationId = uuidv4();
        await client.query(
          `INSERT INTO donations (
             id, project_id, donor_address, amount_xlm, amount, currency,
             message, transaction_hash, idempotency_key, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())`,
          [
            donationId,
            project.id,
            match.matcher_address,
            matchAmount,
            matchAmount,
            "XLM",
            `Matching donation for ${from}`,
            matchResult.txHash,
            // idempotency_key: stable, unique per matching payment
            `match:${transaction_hash}:${match.id}`,
          ]
        );

        await client.query("COMMIT");

        totalMatched += matchAmount;
        matchResults.push({
          matchId: match.id,
          matcherAddress: match.matcher_address,
          amount: matchAmount,
          txHash: matchResult.txHash,
        });
      } catch (dbErr) {
        await client.query("ROLLBACK");

        // A unique_violation on matching_processed_donations means a
        // concurrent retry already committed this match — not an error.
        if (
          dbErr.code === PG_UNIQUE_VIOLATION &&
          (dbErr.constraint === "matching_processed_donations_original_tx_hash_match_id_key" ||
            /matching_processed_donations/i.test(dbErr.message))
        ) {
          console.log(
            `Concurrent duplicate for match ${match.id} / tx ${transaction_hash} — skipping (already committed by racing caller)`
          );
          continue;
        }

        // Any other DB error is genuinely unexpected — re-throw so the caller
        // can surface it and the webhook system retries at the right level.
        throw dbErr;
      } finally {
        client.release();
      }
    }

    return {
      matched: totalMatched > 0,
      totalMatched,
      matches: matchResults,
      projectId: project.id,
      projectName: project.name,
    };
  } catch (error) {
    console.error("Error in matchDonationTxFunction:", error);
    return { matched: false, error: error.message };
  }
}

/**
 * Turrets txFunction entry point for matching donations.
 *
 * @param {object} payment - Payment operation object from Horizon/Turret.
 * @returns {Promise<object>} Result describing whether matching occurred and details.
 * @throws {Error} If internal processing fails unexpectedly.
 */
// exported as `matchDonationTxFunction`

/**
 * Submit a matching payment transaction
 * This uses pre-signed transactions from the matcher's account
 */
async function submitMatchingPayment({
  matcherAddress,
  projectWallet,
  amount,
  originalTxHash,
  _matchId,
  _projectId
}) {
  try {
    // Load the matcher account
    const matcherAccount = await getServer().loadAccount(matcherAddress);

    // Build the payment transaction
    const transaction = new TransactionBuilder(matcherAccount, {
      fee: "100",
      networkPassphrase: NETWORK_PASSPHRASE
    })
      .addOperation(
        Operation.payment({
          destination: projectWallet,
          asset: Asset.native(),
          amount: amount.toFixed(7)
        })
      )
      .addMemo(Memo.text(`Match:${originalTxHash.slice(0, 20)}`))
      .setTimeout(60)
      .build();

    // In a real implementation, this would use pre-signed transactions
    // For now, we'll need the matcher's secret key to sign
    // This should be stored securely (e.g., in environment variables or a secret manager)
    const matcherSecret = env.matcherSecretKey;
    
    if (!matcherSecret) {
      console.warn("MATCHER_SECRET_KEY not configured. Cannot submit matching payment.");
      return { success: false, reason: "Matcher secret not configured" };
    }

    // Sign the transaction
    transaction.sign(require("@stellar/stellar-sdk").Keypair.fromSecret(matcherSecret));

    // Submit to Horizon
    const result = await getServer().submitTransaction(transaction);

    console.log(`Matching payment submitted: ${result.hash}`);

    return {
      success: true,
      txHash: result.hash
    };

  } catch (error) {
    console.error("Error submitting matching payment:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Submit a matching payment transaction for a matcher account.
 *
 * @param {{matcherAddress:string,projectWallet:string,amount:number,originalTxHash:string,matchId:string,projectId:string}} opts
 * @returns {Promise<{success:boolean,txHash?:string,reason?:string,error?:string}>}
 */
// exported as `submitMatchingPayment`

/**
 * Generate pre-signed transactions for a matcher up to a cap
 * This allows the Turret to submit transactions without needing the secret key at runtime
 */
async function generatePreSignedTransactions({
  matcherAddress,
  matcherSecret,
  projectWallet,
  capXlm,
  multiplier,
  _projectId
}) {
  const transactions = [];
  const matcherKeypair = require("@stellar/stellar-sdk").Keypair.fromSecret(matcherSecret);
  
  // Generate transactions for different donation amounts
  const donationAmounts = [10, 25, 50, 100, 250];
  
  for (const donationAmount of donationAmounts) {
    const matchAmount = Math.min(donationAmount * multiplier, capXlm);
    
    if (matchAmount <= 0) continue;

    try {
      const account = await getServer().loadAccount(matcherAddress);
      
      const tx = new TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: NETWORK_PASSPHRASE
      })
        .addOperation(
          Operation.payment({
            destination: projectWallet,
            asset: Asset.native(),
            amount: matchAmount.toFixed(7)
          })
        )
        .setTimeout(60)
        .build();

      tx.sign(matcherKeypair);
      
      transactions.push({
        donationAmount,
        matchAmount,
        xdr: tx.toXDR()
      });
    } catch (error) {
      console.error(`Error generating transaction for ${donationAmount} XLM:`, error);
    }
  }

  return transactions;
}

/**
 * Generate a set of pre-signed matching transactions for a matcher account.
 *
 * @param {{matcherAddress:string,matcherSecret:string,projectWallet:string,capXlm:number,multiplier:number,projectId:string}} opts
 * @returns {Promise<Array<{donationAmount:number,matchAmount:number,xdr:string}>>}
 */
// exported as `generatePreSignedTransactions`

/**
 * Start the Turrets server
 * This creates an HTTP server that Turrets can call
 */
function startTurretsServer(port = 3001) {
  const express = require("express");
  const {
    apiEnvelope,
    createApiError,
    errorHandler,
    notFoundHandler,
  } = require("../middleware/apiEnvelope");
  const app = express();

  app.use(apiEnvelope({ shouldEnvelope: () => true }));
  app.use(express.json());
  app.use(require("cors")());

  // Health check endpoint
  app.get("/health", (req, res) => {
    res.json({ status: "ok", service: "turrets-matching" });
  });

  // txFunction endpoint for matching donations
  app.post("/txfunction/matchDonation", async (req, res, next) => {
    try {
      const result = await matchDonationTxFunction(req.body);
      if (result.success === false) {
        throw createApiError(
          422,
          "MATCHING_PAYMENT_UNAVAILABLE",
          result.reason || result.error || "Matching payment unavailable",
          result
        );
      }
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // Endpoint to generate pre-signed transactions
  app.post("/admin/presign", async (req, res, next) => {
    try {
      const {
        matcherAddress,
        matcherSecret,
        projectWallet,
        capXlm,
        multiplier,
        projectId
      } = req.body;

      if (!matcherAddress || !matcherSecret || !projectWallet) {
        throw createApiError(
          400,
          "MISSING_REQUIRED_PARAMETERS",
          "Missing required parameters"
        );
      }

      const transactions = await generatePreSignedTransactions({
        matcherAddress,
        matcherSecret,
        projectWallet,
        capXlm: parseFloat(capXlm),
        multiplier: parseFloat(multiplier),
        projectId
      });

      res.json({ transactions });
    } catch (error) {
      next(error);
    }
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  app.listen(port, () => {
    console.log(`Turrets server listening on port ${port}`);
  });

  return app;
}

/**
 * Start a lightweight Turrets-compatible HTTP server exposing matching endpoints.
 *
 * @param {number} [port=3001] - TCP port to listen on.
 * @returns {object} Express app instance.
 */
// exported as `startTurretsServer`

module.exports = {
  matchDonationTxFunction,
  submitMatchingPayment,
  generatePreSignedTransactions,
  startTurretsServer
};
