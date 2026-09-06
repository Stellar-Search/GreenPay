/**
 * src/services/onboarding/accountUpgrade.js
 *
 * Carrying a donor's history from a browser-held starter account to a real
 * wallet.
 *
 * ── The problem this solves, and the one it does not ────────────────────────
 * A donor who starts with a sponsored, browser-held key owns their donations
 * on-chain forever — those are ledger entries, and nothing here can take them
 * away. What they can lose is everything the *platform* attaches to the
 * address: leaderboard position, badge tier, donation history on their profile.
 * Clearing browser storage is enough to lose it.
 *
 * This module lets that history move to a wallet the donor properly controls.
 * It cannot make a lost key recoverable — no non-custodial system can, and
 * claiming otherwise would be the single most damaging thing this feature could
 * do. The limitation is therefore stated to the donor *at the point they create
 * the starter account*, not at the point they discover it (see the disclosures
 * exported below and rendered by the web and mobile flows).
 *
 * ── Why both signatures are required ────────────────────────────────────────
 * A migration moves donation totals and badge tier from one address to
 * another. If only the destination proved control, anyone could claim a
 * stranger's leaderboard history by pointing at their address. If only the
 * source proved it, someone could dump their history onto an address they do
 * not own to inflate it. So both sign the same challenge, and the challenge is
 * single-use and short-lived.
 */
"use strict";

const crypto = require("crypto");
const { Keypair, Networks, StrKey, Transaction } = require("@stellar/stellar-sdk");
const { env } = require("../../config/env");
const { randomUUID: uuid } = require("crypto");
const pool = require("../../db/pool");
const { logger: rootLogger } = require("../../utils/logger");

const logger = rootLogger.child({ service: "account-upgrade" });

/** Challenges are short-lived: a replayable proof is not a proof. */
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

class UpgradeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "UpgradeError";
    this.code = code;
    this.status = status;
  }
}

/**
 * What a donor is told *before* they accept a starter account. Exported so the
 * web and mobile flows render the same words and a change has to be made once.
 */
const STARTER_ACCOUNT_DISCLOSURES = Object.freeze({
  title: "What you get, and what you are giving up",
  keep: Object.freeze([
    "Your donation goes to the project directly, on-chain, exactly like any other donation.",
    "The donation is permanently recorded on Stellar under your address. Nobody, including GreenPay, can undo or reassign it.",
    "You can move your donation history and badges to a full wallet later, for free.",
  ]),
  giveUp: Object.freeze([
    "Your key lives in this browser only. Clear your browser data, or use a different device, and it is gone.",
    "GreenPay does not have a copy of your key and cannot restore it. There is no password reset.",
    "If you lose the key you lose access to any XLM left in the account, and your donation history on GreenPay stays attached to an address you can no longer prove you own.",
    "Sponsored accounts have a donation cap. To give more, you will need a wallet you fund yourself.",
  ]),
  mitigation: Object.freeze([
    "Export your key now and store it somewhere safe — it works in any Stellar wallet.",
    "Or move to a full wallet as soon as you have one; your history comes with you.",
  ]),
});

/**
 * What a migration does and does not move. Rendered to the donor on the upgrade
 * screen *before* they sign, for the same reason the starter-account
 * disclosures are shown before the account is created.
 */
const UPGRADE_LIMITATIONS = Object.freeze({
  moves: Object.freeze([
    "Your donation history on GreenPay — every donation you made from the starter account appears under your new wallet.",
    "Your badge progress, which is derived from that history.",
    "Your profile, so there is one page instead of two.",
  ]),
  doesNotMove: Object.freeze([
    "The donations themselves. They stay recorded on Stellar under the address that made them — that is the point of an immutable ledger, and nothing can or should change it.",
    "Any XLM still sitting in the starter account. Send it across yourself, or merge the account, before you stop using that key.",
    "Your all-time leaderboard position, until the leaderboard is next rebuilt. Your starter address keeps its rank in the meantime.",
  ]),
});

/** Formats the challenge a donor signs from each address. */
function challengeMessage({ nonce, fromAddress, toAddress }) {
  return [
    "GreenPay account upgrade",
    `from:${fromAddress}`,
    `to:${toAddress}`,
    `nonce:${nonce}`,
  ].join("\n");
}

function assertAddress(address, label) {
  if (!StrKey.isValidEd25519PublicKey(address)) {
    throw new UpgradeError("INVALID_ADDRESS", `${label} is not a valid Stellar address.`);
  }
}

/**
 * Issues a single-use challenge both addresses must sign.
 */
async function createUpgradeChallenge({ fromAddress, toAddress }, dbPool = pool) {
  assertAddress(fromAddress, "fromAddress");
  assertAddress(toAddress, "toAddress");
  if (fromAddress === toAddress) {
    throw new UpgradeError("SAME_ADDRESS", "The two addresses are the same — there is nothing to migrate.");
  }

  const nonce = crypto.randomBytes(24).toString("hex");
  const id = uuid();
  await dbPool.query(
    `INSERT INTO account_upgrades (id, from_address, to_address, nonce, state, expires_at)
     VALUES ($1, $2, $3, $4, 'challenged', NOW() + ($5 || ' milliseconds')::interval)`,
    [id, fromAddress, toAddress, nonce, String(CHALLENGE_TTL_MS)],
  );

  return {
    upgradeId: id,
    nonce,
    message: challengeMessage({ nonce, fromAddress, toAddress }),
    expiresInMs: CHALLENGE_TTL_MS,
  };
}

/**
 * Verifies a base64 ed25519 signature of `message` by `address`.
 *
 * Wrapped so a malformed signature is a clean `false` rather than an exception
 * that would surface to the donor as a 500 for what is really a typo.
 */
function verifySignature({ address, message, signatureBase64 }) {
  try {
    const keypair = Keypair.fromPublicKey(address);
    return keypair.verify(Buffer.from(message, "utf8"), Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

/**
 * The `manageData` key the challenge envelope must carry.
 *
 * Protocol, not decoration: it is shared verbatim with frontend/lib/challenge.ts
 * and mobile/utils/challenge.ts, and a mismatch fails every migration closed.
 */
const CHALLENGE_DATA_NAME = "GreenPay account upgrade";

function challengeNetworkPassphrase() {
  return env.stellarNetwork === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
}

/**
 * Verifies a signed challenge envelope from a wallet.
 *
 * The destination half of the proof cannot be a raw signature: wallet
 * extensions refuse to sign arbitrary bytes, precisely because a wallet that
 * did could be tricked into signing a payment dressed up as a "verification
 * message". So the wallet signs an unsubmittable transaction instead, the
 * SEP-10 way, and this verifies each property that makes it unsubmittable and
 * unreplayable rather than trusting that the client built it correctly:
 *
 *   - sequence 0        — no live account has it, so the envelope is dead on
 *                         the network whatever else happens to it;
 *   - a lone manageData — no destination and no amount, so there is no version
 *                         of this transaction that moves value;
 *   - the exact nonce   — binds the proof to *this* migration, so a signature
 *                         captured once cannot authorise the next one;
 *   - source == address — the account being proved is the one that signed;
 *   - signature over the envelope hash by that account.
 *
 * Any failure returns false rather than throwing: the caller turns it into one
 * "signature did not verify" message, and a malformed envelope must not be
 * distinguishable from a wrong one.
 */
function verifyChallengeEnvelope({ signedXdr, address, nonce }) {
  try {
    const tx = new Transaction(signedXdr, challengeNetworkPassphrase());

    // Unsubmittable, and therefore harmless to have signed.
    if (String(tx.sequence) !== "0") return false;
    if (tx.source !== address) return false;
    if (tx.operations.length !== 1) return false;

    const [op] = tx.operations;
    if (op.type !== "manageData") return false;
    if (op.name !== CHALLENGE_DATA_NAME) return false;
    if (op.source && op.source !== address) return false;

    // Single-use: without this the same signed envelope authorises every
    // future migration of the same address.
    const value = op.value ? Buffer.from(op.value).toString("utf8") : "";
    if (value !== nonce) return false;

    const keypair = Keypair.fromPublicKey(address);
    const hash = tx.hash();
    return tx.signatures.some((signature) => {
      try {
        return keypair.verify(hash, signature.signature());
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Completes the migration.
 *
 * The move is a single database transaction. A half-migrated donor — history
 * on neither address, or counted on both — is worse than one who has to retry,
 * so every write commits together or none does.
 */
async function completeUpgrade({ upgradeId, fromSignature, toChallengeXdr }, deps = {}) {
  const dbPool = deps.pool || pool;

  const { rows } = await dbPool.query("SELECT * FROM account_upgrades WHERE id = $1", [upgradeId]);
  const record = rows[0];
  if (!record) throw new UpgradeError("UPGRADE_NOT_FOUND", "No such upgrade request.", 404);
  if (record.state === "completed") {
    return { upgradeId, state: "completed", deduplicated: true, migrated: record.migrated_donations };
  }
  if (record.state !== "challenged") {
    throw new UpgradeError("UPGRADE_CLOSED", "This upgrade request is no longer open.", 409);
  }
  if (new Date(record.expires_at).getTime() < Date.now()) {
    await dbPool.query("UPDATE account_upgrades SET state = 'expired', updated_at = NOW() WHERE id = $1", [upgradeId]);
    throw new UpgradeError("UPGRADE_EXPIRED", "This upgrade request expired. Start a new one.", 409);
  }

  const message = challengeMessage({
    nonce: record.nonce,
    fromAddress: record.from_address,
    toAddress: record.to_address,
  });

  if (!verifySignature({ address: record.from_address, message, signatureBase64: fromSignature })) {
    throw new UpgradeError("FROM_SIGNATURE_INVALID", "The starter account's signature did not verify.", 403);
  }
  if (!verifyChallengeEnvelope({
    signedXdr: toChallengeXdr,
    address: record.to_address,
    nonce: record.nonce,
  })) {
    throw new UpgradeError("TO_SIGNATURE_INVALID", "The destination wallet's signature did not verify.", 403);
  }

  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");

    // Donations keep their on-chain donor_address — rewriting it would make the
    // database disagree with the ledger, and the ledger is the record of truth.
    // The link is recorded instead, and every read path that shows "this
    // donor's history" resolves through it.
    await client.query(
      `INSERT INTO donor_address_links (id, canonical_address, linked_address, upgrade_id, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (linked_address) DO UPDATE
         SET canonical_address = EXCLUDED.canonical_address, upgrade_id = EXCLUDED.upgrade_id`,
      [uuid(), record.to_address, record.from_address, upgradeId],
    );

    const counted = await client.query(
      "SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0) AS total FROM donations WHERE donor_address = $1",
      [record.from_address],
    );
    const migratedCount = counted.rows[0]?.count || 0;
    const migratedTotal = counted.rows[0]?.total || 0;

    // Deliberately NOT rewritten here: donor_stats. That table is a projection
    // rebuilt from the event stream, so a direct write would be overwritten on
    // the next rebuild and, worse, would disagree with the events in the
    // meantime. The link is the durable fact; read paths join through it.
    //
    // The consequence is stated to the donor rather than papered over: donation
    // history and profile totals follow the link immediately, while the
    // all-time leaderboard keeps ranking the starter address until the
    // projection is rebuilt with link-awareness. See UPGRADE_LIMITATIONS.

    await client.query(
      `UPDATE account_upgrades
       SET state = 'completed', migrated_donations = $2, migrated_amount = $3,
           completed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [upgradeId, migratedCount, migratedTotal],
    );

    await client.query(
      "UPDATE sponsored_accounts SET upgraded_to = $2, updated_at = NOW() WHERE account_public_key = $1",
      [record.from_address, record.to_address],
    );

    await client.query("COMMIT");

    logger.info({
      msg: "donor history migrated",
      upgradeId,
      migratedDonations: migratedCount,
    });

    return {
      upgradeId,
      state: "completed",
      deduplicated: false,
      migrated: migratedCount,
      migratedAmount: String(migratedTotal),
      canonicalAddress: record.to_address,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Resolves an address to the one that owns its history. Read paths call this
 * so a migrated donor sees one combined profile instead of two halves.
 */
async function resolveCanonicalAddress(address, dbPool = pool) {
  const { rows } = await dbPool.query(
    "SELECT canonical_address FROM donor_address_links WHERE linked_address = $1 LIMIT 1",
    [address],
  );
  return rows[0]?.canonical_address || address;
}

/** Every address whose history belongs to `address`, including itself. */
async function addressesFor(address, dbPool = pool) {
  const canonical = await resolveCanonicalAddress(address, dbPool);
  const { rows } = await dbPool.query(
    "SELECT linked_address FROM donor_address_links WHERE canonical_address = $1",
    [canonical],
  );
  return Array.from(new Set([canonical, ...rows.map((r) => r.linked_address)]));
}

module.exports = {
  CHALLENGE_TTL_MS,
  UPGRADE_LIMITATIONS,
  UpgradeError,
  STARTER_ACCOUNT_DISCLOSURES,
  CHALLENGE_DATA_NAME,
  challengeMessage,
  createUpgradeChallenge,
  verifySignature,
  verifyChallengeEnvelope,
  completeUpgrade,
  resolveCanonicalAddress,
  addressesFor,
};
