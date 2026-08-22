/**
 * services/turrets.js
 * Stellar Turrets txFunction server for automatic donation matching
 * 
 * This service implements a Turrets-compatible txFunction that:
 * 1. Listens for payments to project wallets
 * 2. Checks for active matching offers
 * 3. Submits pre-signed matching transactions from the matcher account
 */

const { Server, TransactionBuilder, Networks, Operation, Asset, Horizon } = require("@stellar/stellar-sdk");
const pool = require("../db/pool");
const { xlmToStroopsRounded, stroopsToXlm } = require("../utils/xlm");

// Network configuration
const NETWORK = process.env.STELLAR_NETWORK || "testnet";
const NETWORK_PASSPHRASE = NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
const HORIZON_URL = process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
let server;
function getServer() {
  if (!server) {
    server = new Server(HORIZON_URL);
  }
  return server;
}

/**
 * Turrets txFunction entry point for matching donations
 * This function is called by the Turret when a payment is detected
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
      memo 
    } = payment;

    // Only match XLM donations
    if (asset_type !== "native" && asset_code !== "XLM") {
      console.log(`Skipping non-XLM donation: ${asset_code || asset_type}`);
      return { matched: false, reason: "Not an XLM donation" };
    }

    // Find the project by wallet address
    const projectResult = await pool.query(
      "SELECT id, name FROM projects WHERE wallet_address = $1",
      [to]
    );

    if (!projectResult.rows[0]) {
      console.log(`Project not found for wallet: ${to}`);
      return { matched: false, reason: "Project not found" };
    }

    const project = projectResult.rows[0];
    // Horizon amounts arrive as decimal strings; convert once to integer
    // stroops and keep all cap arithmetic exact.
    const donationStroops = xlmToStroopsRounded(amount);

    // Check for active matching offers
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

    // Process matching offers
    let totalMatchedStroops = 0n;
    const matchResults = [];

    for (const match of matchesResult.rows) {
      const matchedStroops = xlmToStroopsRounded(match.matched_xlm || "0");
      const capStroops = xlmToStroopsRounded(match.cap_xlm);
      const remainingStroops = capStroops - matchedStroops;

      if (remainingStroops <= 0n) continue;

      const matchAmountStroops = donationStroops * BigInt(match.multiplier) < remainingStroops
        ? donationStroops * BigInt(match.multiplier)
        : remainingStroops;
      const matchAmountXlm = stroopsToXlm(matchAmountStroops);

      if (matchAmountStroops <= 0n) continue;

      // Build and submit the matching payment transaction
      const matchResult = await submitMatchingPayment({
        matcherAddress: match.matcher_address,
        projectWallet: to,
        amount: matchAmountXlm,
        originalTxHash: transaction_hash,
        matchId: match.id,
        projectId: project.id
      });

      if (matchResult.success) {
        // Update the matched amount in the database
        await pool.query(
          `UPDATE donation_matches
           SET matched_xlm = matched_xlm + $1::numeric
           WHERE id = $2`,
          [matchAmountXlm, match.id]
        );

        // Record the matched donation
        await pool.query(
          `INSERT INTO donations (
            id, project_id, donor_address, amount_xlm, amount, currency,
            message, transaction_hash, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
          [
            require("uuid").v4(),
            project.id,
            match.matcher_address,
            matchAmountXlm,
            matchAmountXlm,
            "XLM",
            `Matching donation for ${from}`,
            matchResult.txHash
          ]
        );

        totalMatchedStroops += matchAmountStroops;
        matchResults.push({
          matchId: match.id,
          matcherAddress: match.matcher_address,
          amount: matchAmountXlm,
          txHash: matchResult.txHash
        });
      }
    }

    return {
      matched: totalMatchedStroops > 0n,
      totalMatched: stroopsToXlm(totalMatchedStroops),
      matches: matchResults,
      projectId: project.id,
      projectName: project.name
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
 *
 * @param {object} opts
 * @param {string} opts.amount - XLM amount as an exact 7-decimal string.
 */
async function submitMatchingPayment({
  matcherAddress,
  projectWallet,
  amount,
  originalTxHash,
  matchId,
  projectId
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
          amount
        })
      )
      .addMemo(
        Operation.memo({
          type: "text",
          value: `Match:${originalTxHash.slice(0, 20)}`
        })
      )
      .setTimeout(60)
      .build();

    // In a real implementation, this would use pre-signed transactions
    // For now, we'll need the matcher's secret key to sign
    // This should be stored securely (e.g., in environment variables or a secret manager)
    const matcherSecret = process.env.MATCHER_SECRET_KEY;
    
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
 *
 * @param {object} opts
 * @param {string|number} opts.capXlm - Match cap in XLM (exact string preferred).
 * @param {number} opts.multiplier - Integer multiplier.
 * @returns {Promise<Array<{donationAmount:number,matchAmount:string,xdr:string}>}>
 */
async function generatePreSignedTransactions({
  matcherAddress,
  matcherSecret,
  projectWallet,
  capXlm,
  multiplier,
  projectId
}) {
  const transactions = [];
  const matcherKeypair = require("@stellar/stellar-sdk").Keypair.fromSecret(matcherSecret);
  const capStroops = xlmToStroopsRounded(capXlm ?? 0);

  // Generate transactions for different donation amounts
  const donationAmounts = [10, 25, 50, 100, 250];

  for (const donationAmount of donationAmounts) {
    const fullMatchStroops = BigInt(donationAmount) * BigInt(multiplier);
    const matchAmountStroops = fullMatchStroops < capStroops ? fullMatchStroops : capStroops;

    if (matchAmountStroops <= 0n) continue;

    const matchAmountXlm = stroopsToXlm(matchAmountStroops);

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
            amount: matchAmountXlm
          })
        )
        .setTimeout(60)
        .build();

      tx.sign(matcherKeypair);

      transactions.push({
        donationAmount,
        matchAmount: matchAmountXlm,
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
        capXlm,
        multiplier: parseInt(multiplier, 10) || 1,
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
