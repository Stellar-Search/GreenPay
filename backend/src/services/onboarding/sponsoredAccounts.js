/**
 * src/services/onboarding/sponsoredAccounts.js
 *
 * Sponsored account creation, and the reserve accounting that follows it.
 *
 * ── Why this is not custody ─────────────────────────────────────────────────
 * The donor's keypair is generated in the donor's browser and never sent here.
 * This module only ever sees the *public* key. The transaction it builds is:
 *
 *     op 1  beginSponsoringFutureReserves(sponsoredId: donor)   src: sponsor
 *     op 2  createAccount(destination: donor, startingBalance: 0) src: sponsor
 *     op 3  endSponsoringFutureReserves()                        src: donor
 *
 * Operation 3 is sourced by the donor, so the transaction is invalid until the
 * donor signs it. The platform therefore cannot create an account it controls,
 * and the donor cannot get their reserve sponsored without consenting to the
 * exact transaction that does it. Neither side can act alone, which is what
 * makes this non-custodial rather than merely "we promise not to look".
 *
 * `startingBalance: 0` is legal only because op 1 makes the sponsor carry the
 * new account's two base reserves. Without the sponsorship wrapper the same
 * createAccount would be rejected — that rejection is exactly the funnel
 * blocker this whole path exists to remove.
 *
 * ── Why the state machine is not optional ───────────────────────────────────
 * Between "we decided to sponsor" and "the ledger agrees" the platform has
 * committed reserve it has not yet locked. If that gap is not recorded, two
 * concurrent requests both see the same free capacity and the treasury is
 * oversubscribed; and a request abandoned in the middle leaks that capacity
 * forever. So capacity is reserved at `requested`, converted at `active`, and
 * *released* on `failed` / `abandoned`, and an abandoned request leaves nothing
 * behind but an audit row.
 */
"use strict";

const {
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  Transaction,
  Account,
  Horizon,
  StrKey,
  BASE_FEE,
} = require("@stellar/stellar-sdk");

const { v4: uuid } = require("uuid");
const pool = require("../../db/pool");
const { env } = require("../../config/env");
const { logger: rootLogger } = require("../../utils/logger");
const { sponsorshipCost, serializeCost, sponsorshipQuote, xlmStringToStroops, stroopsToXlmString } = require("./reserveAccounting");
const { assessRequest, resolveLimits } = require("./sponsorshipPolicy");

const logger = rootLogger.child({ service: "sponsored-accounts" });

/**
 * Sponsorship lifecycle. `requested` and `awaiting_signature` both hold
 * reserved-but-not-locked capacity; only `active` is real locked reserve.
 */
const STATES = Object.freeze({
  REQUESTED: "requested",
  AWAITING_SIGNATURE: "awaiting_signature",
  SUBMITTED: "submitted",
  ACTIVE: "active",
  FAILED: "failed",
  ABANDONED: "abandoned",
  RECLAIMED: "reclaimed",
});

/** States that hold treasury capacity and must be counted against it. */
const CAPACITY_HOLDING_STATES = Object.freeze([
  STATES.REQUESTED,
  STATES.AWAITING_SIGNATURE,
  STATES.SUBMITTED,
  STATES.ACTIVE,
]);

/** Terminal states — capacity released, nothing further happens. */
const TERMINAL_STATES = Object.freeze([STATES.FAILED, STATES.ABANDONED, STATES.RECLAIMED]);

/**
 * A half-built sponsorship must not hold capacity forever. Anything still
 * awaiting the donor's signature after this long is swept back.
 */
const SIGNATURE_WINDOW_MS = 15 * 60 * 1000;

class SponsorshipError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = "SponsorshipError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function networkPassphrase() {
  return env.stellarNetwork === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
}

function horizonServer() {
  return new Horizon.Server(env.horizonUrl);
}

/** The sponsor keypair, or null when this deployment does not sponsor. */
function sponsorKeypair() {
  const secret = env.sponsorSecretKey;
  if (!secret) return null;
  try {
    return Keypair.fromSecret(secret);
  } catch {
    // A malformed key must not read as "sponsorship disabled" — that would
    // turn a configuration mistake into a silently degraded product.
    throw new SponsorshipError(
      "SPONSOR_KEY_INVALID",
      "SPONSOR_SECRET_KEY is not a valid Stellar secret key.",
      500,
    );
  }
}

function isSponsorshipEnabled() {
  return Boolean(env.sponsorSecretKey);
}

function sponsorPublicKey() {
  const kp = sponsorKeypair();
  return kp ? kp.publicKey() : null;
}

function limitOverrides() {
  return {
    perIpDaily: env.sponsorshipPerIpDaily,
    perSessionTotal: env.sponsorshipPerSessionTotal,
    globalDaily: env.sponsorshipGlobalDaily,
    globalHourly: env.sponsorshipGlobalHourly,
    treasuryFloorAccounts: env.sponsorshipTreasuryFloorAccounts,
    maxSponsoredDonationXlm: env.sponsorshipMaxDonationXlm,
    maxSponsoredLifetimeXlm: env.sponsorshipMaxLifetimeXlm,
    reclaimIdleAfterDays: env.sponsorshipReclaimIdleDays,
  };
}

/** True when the address resolves to an account that exists on the network. */
async function accountExists(publicKey, server = horizonServer()) {
  try {
    await server.loadAccount(publicKey);
    return true;
  } catch (err) {
    // Horizon answers 404 for "no such account", which is the expected,
    // non-exceptional case for a first-time donor. Anything else is a real
    // failure and must not be reported as "account does not exist" — doing so
    // would sponsor an account that already exists and lock reserve twice.
    const status = err?.response?.status ?? err?.status;
    if (status === 404) return false;
    throw new SponsorshipError(
      "HORIZON_UNAVAILABLE",
      "Could not reach the Stellar network to check this account. Please try again.",
      503,
    );
  }
}

/**
 * Snapshot of everything the policy needs, read in one round trip so two
 * concurrent requests cannot both see stale capacity.
 */
async function readUsage({ sessionId, ipHash }, client = pool) {
  const holding = CAPACITY_HOLDING_STATES;
  const { rows } = await client.query(
    `SELECT
       COUNT(*) FILTER (
         WHERE session_id = $1 AND state = ANY($3::text[])
       ) AS per_session,
       COUNT(*) FILTER (
         WHERE ip_hash = $2 AND created_at > NOW() - INTERVAL '24 hours'
           AND state = ANY($3::text[])
       ) AS per_ip_daily,
       COUNT(*) FILTER (
         WHERE created_at > NOW() - INTERVAL '24 hours' AND state = ANY($3::text[])
       ) AS global_daily,
       COUNT(*) FILTER (
         WHERE created_at > NOW() - INTERVAL '1 hour' AND state = ANY($3::text[])
       ) AS global_hourly,
       COUNT(*) FILTER (WHERE state = ANY($3::text[])) AS active_sponsorships
     FROM sponsored_accounts`,
    [sessionId || null, ipHash || null, holding],
  );
  const row = rows[0] || {};
  return {
    perSession: Number(row.per_session || 0),
    perIpDaily: Number(row.per_ip_daily || 0),
    globalDaily: Number(row.global_daily || 0),
    globalHourly: Number(row.global_hourly || 0),
    activeSponsorships: Number(row.active_sponsorships || 0),
  };
}

/** Reads the sponsor account's native balance, in stroops. */
async function readTreasuryBalanceStroops(server = horizonServer()) {
  const publicKey = sponsorPublicKey();
  if (!publicKey) return null;
  try {
    const account = await server.loadAccount(publicKey);
    const native = account.balances.find((b) => b.asset_type === "native");
    return xlmStringToStroops(native ? native.balance : "0");
  } catch (err) {
    // A treasury we cannot read is a treasury we must not spend from. Returning
    // null makes the policy skip the capacity check, which would be the wrong
    // failure direction, so this raises instead.
    logger.error({ msg: "treasury balance read failed", error: err.message });
    throw new SponsorshipError(
      "TREASURY_UNREADABLE",
      "Could not read the sponsorship treasury balance. Sponsorship is paused.",
      503,
    );
  }
}

/**
 * A quote a donor can read before committing to anything. Deliberately callable
 * without creating any state — the disclosure has to be available *before* the
 * decision, not as a confirmation afterwards.
 */
async function quoteSponsorship({ publicKey, sessionId, ipHash, trustline = false }, deps = {}) {
  const server = deps.server || horizonServer();
  const client = deps.client || pool;

  if (!StrKey.isValidEd25519PublicKey(publicKey)) {
    throw new SponsorshipError("INVALID_PUBLIC_KEY", "Not a valid Stellar public key.", 400);
  }

  const enabled = isSponsorshipEnabled();
  const exists = enabled ? await accountExists(publicKey, server) : false;
  const usage = enabled ? await readUsage({ sessionId, ipHash }, client) : {
    perSession: 0, perIpDaily: 0, globalDaily: 0, globalHourly: 0, activeSponsorships: 0,
  };

  let treasuryBalanceStroops = null;
  if (enabled && !exists) {
    treasuryBalanceStroops = await readTreasuryBalanceStroops(server);
  }

  const decision = assessRequest(
    { enabled, accountExists: exists, trustline },
    { ...usage, treasuryBalanceStroops },
    limitOverrides(),
  );

  const quote = sponsorshipQuote({ trustline });
  return {
    ...decision,
    // The decision carries a BigInt cost model, which cannot cross an HTTP
    // boundary. Serializing here rather than in the route keeps every caller
    // of this function safe by default.
    cost: decision.cost ? serializeCost(decision.cost) : undefined,
    accountExists: exists,
    sponsorPublicKey: sponsorPublicKey(),
    quote,
    limits: resolveLimits(limitOverrides()),
  };
}

/**
 * Reserves capacity and builds the partially-signed creation transaction.
 *
 * The row is written *before* the transaction is built, inside the same
 * transaction that re-checks the limits, so two simultaneous requests from the
 * same session cannot both pass. The returned XDR already carries the sponsor's
 * signature; it is inert until the donor adds theirs.
 */
async function requestSponsorship({ publicKey, sessionId, ipHash, trustline = false, userAgentHash }, deps = {}) {
  const server = deps.server || horizonServer();
  const dbPool = deps.pool || pool;

  if (!StrKey.isValidEd25519PublicKey(publicKey)) {
    throw new SponsorshipError("INVALID_PUBLIC_KEY", "Not a valid Stellar public key.", 400);
  }

  const sponsor = sponsorKeypair();
  if (!sponsor) {
    throw new SponsorshipError(
      "SPONSORSHIP_DISABLED",
      "Sponsored account creation is not enabled on this deployment.",
      503,
    );
  }

  const exists = await accountExists(publicKey, server);
  const treasuryBalanceStroops = exists ? null : await readTreasuryBalanceStroops(server);

  const client = await dbPool.connect();
  let record;
  try {
    await client.query("BEGIN");

    // Serialize capacity decisions against each other. Without this the
    // read-decide-write below is a textbook TOCTOU: two requests both read
    // "one slot left" and both take it.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('greenpay_sponsorship'))");

    const existingForKey = await client.query(
      "SELECT id, state FROM sponsored_accounts WHERE account_public_key = $1 AND state = ANY($2::text[]) LIMIT 1",
      [publicKey, CAPACITY_HOLDING_STATES],
    );

    const usage = await readUsage({ sessionId, ipHash }, client);
    const decision = assessRequest(
      {
        enabled: true,
        accountExists: exists,
        alreadySponsored: existingForKey.rows.length > 0,
        trustline,
      },
      { ...usage, treasuryBalanceStroops },
      limitOverrides(),
    );

    if (!decision.allowed) {
      await client.query("ROLLBACK");
      throw new SponsorshipError(decision.code, decision.message, 429, decision.details);
    }

    const cost = sponsorshipCost({ trustline });
    const id = uuid();
    const insert = await client.query(
      `INSERT INTO sponsored_accounts (
         id, account_public_key, sponsor_public_key, session_id, ip_hash,
         user_agent_hash, state, reserved_stroops, network, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW() + ($10 || ' milliseconds')::interval)
       RETURNING *`,
      [
        id,
        publicKey,
        sponsor.publicKey(),
        sessionId || null,
        ipHash || null,
        userAgentHash || null,
        STATES.REQUESTED,
        cost.totalStroops.toString(),
        env.stellarNetwork,
        String(SIGNATURE_WINDOW_MS),
      ],
    );
    record = insert.rows[0];

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Building the transaction is a network call, so it happens after the
  // capacity commit rather than inside the lock. A failure here leaves a
  // `requested` row that the sweeper reclaims — capacity is briefly held and
  // then released, which is the safe direction.
  try {
    const sponsorAccount = await server.loadAccount(sponsor.publicKey());
    const tx = buildCreationTransaction({
      sponsorAccount,
      sponsorPublicKey: sponsor.publicKey(),
      donorPublicKey: publicKey,
    });
    tx.sign(sponsor);

    const xdr = tx.toXDR();
    await dbPool.query(
      "UPDATE sponsored_accounts SET state = $2, unsigned_xdr = $3, updated_at = NOW() WHERE id = $1",
      [record.id, STATES.AWAITING_SIGNATURE, xdr],
    );

    logger.info({
      msg: "sponsorship offered",
      sponsorshipId: record.id,
      accountPublicKey: publicKey,
      reservedXlm: stroopsToXlmString(BigInt(record.reserved_stroops)),
    });

    return {
      id: record.id,
      state: STATES.AWAITING_SIGNATURE,
      xdr,
      networkPassphrase: networkPassphrase(),
      sponsorPublicKey: sponsor.publicKey(),
      quote: sponsorshipQuote({ trustline }),
      expiresAt: record.expires_at,
    };
  } catch (err) {
    await releaseCapacity(record.id, STATES.FAILED, err.message, dbPool);
    if (err instanceof SponsorshipError) throw err;
    throw new SponsorshipError(
      "SPONSORSHIP_BUILD_FAILED",
      "Could not prepare the account-creation transaction. No reserve was locked.",
      503,
    );
  }
}

/**
 * The three-operation sponsorship sandwich. Split out so tests can assert its
 * exact shape without a database or a network.
 */
function buildCreationTransaction({ sponsorAccount, sponsorPublicKey: sponsorKey, donorPublicKey, fee = BASE_FEE, timeoutSeconds = 900 }) {
  return new TransactionBuilder(sponsorAccount, {
    fee: String(Number(fee) * 3),
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(
      Operation.beginSponsoringFutureReserves({
        sponsoredId: donorPublicKey,
        source: sponsorKey,
      }),
    )
    .addOperation(
      Operation.createAccount({
        destination: donorPublicKey,
        // Zero is only valid because the sponsorship above carries the
        // reserve. This single argument is the funnel blocker being removed.
        startingBalance: "0",
        source: sponsorKey,
      }),
    )
    .addOperation(
      // Sourced by the donor: the transaction cannot be submitted until they
      // sign it, which is what keeps the platform out of custody.
      Operation.endSponsoringFutureReserves({ source: donorPublicKey }),
    )
    .setTimeout(timeoutSeconds)
    .build();
}

/**
 * Submits the donor-co-signed transaction and converts reserved capacity into
 * locked reserve.
 *
 * The submitted XDR is checked against the one that was offered rather than
 * trusted: a donor who returns a *different* transaction signed with their key
 * could otherwise have the sponsor's signature applied to operations the
 * sponsor never agreed to.
 */
async function submitSponsorship({ id, signedXdr }, deps = {}) {
  const server = deps.server || horizonServer();
  const dbPool = deps.pool || pool;

  const { rows } = await dbPool.query("SELECT * FROM sponsored_accounts WHERE id = $1", [id]);
  const record = rows[0];
  if (!record) {
    throw new SponsorshipError("SPONSORSHIP_NOT_FOUND", "No such sponsorship request.", 404);
  }
  if (record.state === STATES.ACTIVE) {
    // Idempotent: a retried submit after a dropped response must not double-lock.
    return { id: record.id, state: STATES.ACTIVE, transactionHash: record.transaction_hash, deduplicated: true };
  }
  if (TERMINAL_STATES.includes(record.state)) {
    throw new SponsorshipError(
      "SPONSORSHIP_CLOSED",
      "This sponsorship request is no longer open. Start a new one.",
      409,
    );
  }
  if (record.expires_at && new Date(record.expires_at).getTime() < Date.now()) {
    await releaseCapacity(record.id, STATES.ABANDONED, "signature window expired", dbPool);
    throw new SponsorshipError(
      "SPONSORSHIP_EXPIRED",
      "This request timed out before it was signed. Nothing was created — start again.",
      409,
    );
  }

  let submitted;
  try {
    submitted = new Transaction(signedXdr, networkPassphrase());
  } catch {
    throw new SponsorshipError("INVALID_XDR", "The signed transaction could not be decoded.", 400);
  }

  assertMatchesOffer(submitted, record);

  await dbPool.query(
    "UPDATE sponsored_accounts SET state = $2, updated_at = NOW() WHERE id = $1",
    [record.id, STATES.SUBMITTED],
  );

  let result;
  try {
    result = await server.submitTransaction(submitted);
  } catch (err) {
    const reason = horizonFailureReason(err);
    await releaseCapacity(record.id, STATES.FAILED, reason, dbPool);
    logger.warn({ msg: "sponsorship submission failed", sponsorshipId: record.id, reason });
    throw new SponsorshipError(
      "SPONSORSHIP_SUBMIT_FAILED",
      `The account could not be created (${reason}). No reserve was locked and nothing was charged to you.`,
      502,
      { reason },
    );
  }

  if (!result.successful) {
    // Landed on-chain but failed. The reserve was not taken, so the capacity
    // must be released exactly as for a rejected submission — but the hash is
    // kept so the failure is auditable.
    await releaseCapacity(record.id, STATES.FAILED, "transaction failed on-chain", dbPool, result.hash);
    throw new SponsorshipError(
      "SPONSORSHIP_EXECUTION_FAILED",
      "The account-creation transaction failed on-chain. No account was created.",
      502,
      { transactionHash: result.hash },
    );
  }

  await dbPool.query(
    `UPDATE sponsored_accounts
     SET state = $2, transaction_hash = $3, locked_stroops = reserved_stroops,
         activated_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [record.id, STATES.ACTIVE, result.hash],
  );

  logger.info({
    msg: "sponsorship active",
    sponsorshipId: record.id,
    accountPublicKey: record.account_public_key,
    transactionHash: result.hash,
    lockedXlm: stroopsToXlmString(BigInt(record.reserved_stroops)),
  });

  return { id: record.id, state: STATES.ACTIVE, transactionHash: result.hash, deduplicated: false };
}

/**
 * Rejects a co-signed transaction that is not the one this sponsorship offered.
 *
 * Comparing the full XDR would be wrong — the donor legitimately adds a
 * signature, which changes it — so the *operations and source accounts* are
 * compared instead. That is the part the sponsor is agreeing to pay for.
 */
function assertMatchesOffer(submitted, record) {
  let offered;
  try {
    offered = new Transaction(record.unsigned_xdr, networkPassphrase());
  } catch {
    throw new SponsorshipError("SPONSORSHIP_CORRUPT", "The stored offer could not be decoded.", 500);
  }

  const shape = (tx) =>
    JSON.stringify({
      source: tx.source,
      seq: tx.sequence,
      ops: tx.operations.map((op) => ({
        type: op.type,
        source: op.source || null,
        destination: op.destination || null,
        sponsoredId: op.sponsoredId || null,
        startingBalance: op.startingBalance || null,
      })),
    });

  if (shape(submitted) !== shape(offered)) {
    logger.warn({
      msg: "sponsorship co-signature rejected: transaction does not match the offer",
      sponsorshipId: record.id,
    });
    throw new SponsorshipError(
      "SPONSORSHIP_TAMPERED",
      "The signed transaction does not match the one GreenPay offered.",
      400,
    );
  }
}

function horizonFailureReason(err) {
  const codes = err?.response?.data?.extras?.result_codes;
  if (!codes) return err?.message || "network error";
  const ops = Array.isArray(codes.operations) ? codes.operations.join(",") : "";
  return [codes.transaction, ops].filter(Boolean).join(" ") || "rejected";
}

/**
 * Moves a sponsorship to a terminal state and gives its capacity back.
 *
 * Every abandonment path funnels through here so that "abandoned donation
 * leaves no partial state" is one code path rather than a promise repeated at
 * four call sites.
 */
async function releaseCapacity(id, state, reason, dbPool = pool, transactionHash = null) {
  const { rows } = await dbPool.query(
    `UPDATE sponsored_accounts
     SET state = $2, failure_reason = $3, reserved_stroops = 0, locked_stroops = 0,
         transaction_hash = COALESCE($4, transaction_hash), closed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND state <> $5
     RETURNING *`,
    [id, state, reason ? String(reason).slice(0, 500) : null, transactionHash, STATES.ACTIVE],
  );
  if (rows[0]) {
    logger.info({ msg: "sponsorship capacity released", sponsorshipId: id, state, reason });
  }
  return rows[0] || null;
}

/**
 * Donor-initiated abandonment. Called when someone closes the flow before
 * signing. Returns quietly for an unknown id: the caller is a browser that may
 * be retrying a beacon, and there is nothing to protect here.
 */
async function abandonSponsorship(id, dbPool = pool) {
  const released = await releaseCapacity(id, STATES.ABANDONED, "donor abandoned the flow", dbPool);
  return { id, released: Boolean(released), state: released ? STATES.ABANDONED : null };
}

/**
 * Sweeps requests that were never signed. Runs on an interval; also safe to
 * call directly from a test or an operator script.
 */
async function sweepExpiredSponsorships(dbPool = pool) {
  const { rows } = await dbPool.query(
    `UPDATE sponsored_accounts
     SET state = $1, failure_reason = 'signature window expired',
         reserved_stroops = 0, closed_at = NOW(), updated_at = NOW()
     WHERE state = ANY($2::text[]) AND expires_at < NOW()
     RETURNING id`,
    [STATES.ABANDONED, [STATES.REQUESTED, STATES.AWAITING_SIGNATURE]],
  );
  if (rows.length) {
    logger.info({ msg: "expired sponsorships swept", count: rows.length });
  }
  return rows.length;
}

/**
 * The recovery path for locked reserve.
 *
 * `revokeAccountSponsorship` hands the account's reserve requirement back to
 * the account itself, which only succeeds if the account can then meet its own
 * minimum balance. So an account that has been funded can be released and the
 * platform's XLM returns; an account that is still empty cannot be, and
 * pretending otherwise would submit a transaction that fails. The honest
 * options for an empty idle account are therefore stated explicitly in the
 * return value rather than hidden behind a retry.
 */
function buildReclaimTransaction({ sponsorAccount, sponsorPublicKey: sponsorKey, donorPublicKey, fee = BASE_FEE }) {
  return new TransactionBuilder(sponsorAccount, {
    fee: String(fee),
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(
      Operation.revokeAccountSponsorship({
        account: donorPublicKey,
        source: sponsorKey,
      }),
    )
    .setTimeout(180)
    .build();
}

/**
 * Attempts to reclaim one sponsorship's reserve.
 *
 * @returns {{reclaimed: boolean, reason?: string, transactionHash?: string}}
 */
async function reclaimSponsorship(id, deps = {}) {
  const server = deps.server || horizonServer();
  const dbPool = deps.pool || pool;
  const sponsor = sponsorKeypair();
  if (!sponsor) {
    return { reclaimed: false, reason: "sponsorship is not configured on this deployment" };
  }

  const { rows } = await dbPool.query("SELECT * FROM sponsored_accounts WHERE id = $1", [id]);
  const record = rows[0];
  if (!record) return { reclaimed: false, reason: "no such sponsorship" };
  if (record.state !== STATES.ACTIVE) {
    return { reclaimed: false, reason: `sponsorship is ${record.state}, not active` };
  }

  // The account must be able to carry its own reserve after the handover, or
  // the revocation is rejected. Checking first turns a confusing on-chain
  // failure into a legible operator message.
  let donorAccount;
  try {
    donorAccount = await server.loadAccount(record.account_public_key);
  } catch {
    // The account is gone (merged away by the donor). Its reserve returned to
    // the sponsor automatically when the entry was removed.
    await dbPool.query(
      `UPDATE sponsored_accounts SET state = $2, locked_stroops = 0, closed_at = NOW(),
         failure_reason = 'account no longer exists; reserve returned on entry removal', updated_at = NOW()
       WHERE id = $1`,
      [id, STATES.RECLAIMED],
    );
    return { reclaimed: true, reason: "account no longer exists; reserve already returned" };
  }

  const native = donorAccount.balances.find((b) => b.asset_type === "native");
  const balance = xlmStringToStroops(native ? native.balance : "0");
  const required = sponsorshipCost({}).totalStroops;
  if (balance < required) {
    return {
      reclaimed: false,
      reason:
        `account holds ${stroopsToXlmString(balance)} XLM but would need ${stroopsToXlmString(required)} XLM ` +
        "to carry its own reserve. Revocation would be rejected; leave the sponsorship in place or ask the donor to merge the account.",
    };
  }

  const sponsorAccount = await server.loadAccount(sponsor.publicKey());
  const tx = buildReclaimTransaction({
    sponsorAccount,
    sponsorPublicKey: sponsor.publicKey(),
    donorPublicKey: record.account_public_key,
  });
  tx.sign(sponsor);

  try {
    const result = await server.submitTransaction(tx);
    await dbPool.query(
      `UPDATE sponsored_accounts
       SET state = $2, locked_stroops = 0, reclaim_transaction_hash = $3,
           closed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [id, STATES.RECLAIMED, result.hash],
    );
    logger.info({ msg: "sponsorship reclaimed", sponsorshipId: id, transactionHash: result.hash });
    return { reclaimed: true, transactionHash: result.hash };
  } catch (err) {
    const reason = horizonFailureReason(err);
    await dbPool.query(
      "UPDATE sponsored_accounts SET reclaim_failures = reclaim_failures + 1, failure_reason = $2, updated_at = NOW() WHERE id = $1",
      [id, reason],
    );
    logger.error({ msg: "sponsorship reclaim failed", sponsorshipId: id, reason });
    return { reclaimed: false, reason };
  }
}

/** Sponsorships that are idle long enough to be worth reclaiming. */
async function findReclaimCandidates(dbPool = pool) {
  const days = Number(resolveLimits(limitOverrides()).reclaimIdleAfterDays);
  const { rows } = await dbPool.query(
    `SELECT s.*
     FROM sponsored_accounts s
     WHERE s.state = $1
       AND s.activated_at < NOW() - ($2 || ' days')::interval
       AND NOT EXISTS (
         SELECT 1 FROM donations d WHERE d.donor_address = s.account_public_key
       )
     ORDER BY s.activated_at ASC
     LIMIT 100`,
    [STATES.ACTIVE, String(days)],
  );
  return rows;
}

/** Aggregate reserve position — what is locked, what is recoverable. */
async function reserveLedger(dbPool = pool) {
  const { rows } = await dbPool.query(
    `SELECT
       COUNT(*) FILTER (WHERE state = $1) AS active,
       COUNT(*) FILTER (WHERE state = ANY($2::text[])) AS pending,
       COUNT(*) FILTER (WHERE state = $3) AS reclaimed,
       COUNT(*) FILTER (WHERE state = $4) AS failed,
       COALESCE(SUM(locked_stroops) FILTER (WHERE state = $1), 0) AS locked_stroops,
       COALESCE(SUM(reserved_stroops) FILTER (WHERE state = ANY($2::text[])), 0) AS reserved_stroops,
       COALESCE(SUM(reclaim_failures), 0) AS reclaim_failures
     FROM sponsored_accounts`,
    [STATES.ACTIVE, [STATES.REQUESTED, STATES.AWAITING_SIGNATURE, STATES.SUBMITTED], STATES.RECLAIMED, STATES.FAILED],
  );
  const row = rows[0] || {};
  const locked = BigInt(row.locked_stroops || 0);
  const reserved = BigInt(row.reserved_stroops || 0);
  return {
    activeSponsorships: Number(row.active || 0),
    pendingSponsorships: Number(row.pending || 0),
    reclaimedSponsorships: Number(row.reclaimed || 0),
    failedSponsorships: Number(row.failed || 0),
    lockedXlm: stroopsToXlmString(locked),
    committedXlm: stroopsToXlmString(locked + reserved),
    reclaimFailures: Number(row.reclaim_failures || 0),
  };
}

/** Is this address one the platform sponsors? Used by the donation caps. */
async function findActiveSponsorship(publicKey, dbPool = pool) {
  const { rows } = await dbPool.query(
    "SELECT * FROM sponsored_accounts WHERE account_public_key = $1 AND state = $2 LIMIT 1",
    [publicKey, STATES.ACTIVE],
  );
  return rows[0] || null;
}

module.exports = {
  STATES,
  CAPACITY_HOLDING_STATES,
  TERMINAL_STATES,
  SIGNATURE_WINDOW_MS,
  SponsorshipError,
  isSponsorshipEnabled,
  sponsorPublicKey,
  sponsorKeypair,
  accountExists,
  readUsage,
  readTreasuryBalanceStroops,
  quoteSponsorship,
  requestSponsorship,
  buildCreationTransaction,
  buildReclaimTransaction,
  submitSponsorship,
  assertMatchesOffer,
  abandonSponsorship,
  releaseCapacity,
  sweepExpiredSponsorships,
  reclaimSponsorship,
  findReclaimCandidates,
  reserveLedger,
  findActiveSponsorship,
  networkPassphrase,
};
