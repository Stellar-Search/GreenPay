"use strict";

const jwt = require("jsonwebtoken");
const pool = require("../db/pool");
const { TransactionBuilder } = require("@stellar/stellar-sdk");

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const TOKEN_EXPIRY = "10m";

function getSecret() {
  return process.env.JWT_SECRET || "dev-secret-do-not-use-in-prod";
}

async function createChallenge(projectId, walletAddress) {
  const nonce = `${projectId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  await pool.query(
    `INSERT INTO project_auth_challenges (project_id, nonce, wallet_address, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [projectId, nonce, walletAddress, expiresAt.toISOString()],
  );
  return nonce;
}

async function consumeChallenge(nonce, walletAddress) {
  const result = await pool.query(
    `SELECT project_id FROM project_auth_challenges
     WHERE nonce = $1 AND wallet_address = $2 AND expires_at > NOW()`,
    [nonce, walletAddress],
  );
  if (!result.rows[0]) return null;
  await pool.query("DELETE FROM project_auth_challenges WHERE nonce = $1", [nonce]);
  return result.rows[0];
}

function createProjectOwnerToken(projectId, walletAddress) {
  return jwt.sign(
    { role: "projectOwner", projectId, walletAddress },
    getSecret(),
    { expiresIn: TOKEN_EXPIRY }
  );
}

function verifyProjectOwnerToken(token) {
  return jwt.verify(token, getSecret());
}

function projectOwnerRequired(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or malformed Authorization header" });
  }

  const token = authHeader.slice(7);
  let decoded;
  try {
    decoded = verifyProjectOwnerToken(token);
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired" });
    }
    return res.status(401).json({ error: "Invalid token" });
  }

  if (decoded.role !== "projectOwner") {
    return res.status(401).json({ error: "Invalid token role" });
  }

  req.projectOwner = decoded;
  next();
}

async function verifySignedChallengeTransaction(signedXDR, expectedNonce, expectedWalletAddress) {
  let tx;
  try {
    tx = TransactionBuilder.fromXDR(signedXDR, process.env.STELLAR_NETWORK === "mainnet"
      ? "Public Global Stellar Network ; September 2015"
      : "Test SDF Network ; September 2015");
  } catch {
    return false;
  }

  if (tx.source !== expectedWalletAddress) return false;

  const memo = tx.memo;
  if (!memo || memo.type !== "text") return false;
  if (memo.value !== expectedNonce.slice(-28)) return false;

  return true;
}

module.exports = {
  createChallenge,
  consumeChallenge,
  createProjectOwnerToken,
  projectOwnerRequired,
  verifySignedChallengeTransaction,
};
