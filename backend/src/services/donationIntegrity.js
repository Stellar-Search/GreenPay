"use strict";

const { v4: uuid } = require("uuid");
const pool = require("../db/pool");
const { Keypair } = require("@stellar/stellar-sdk");
const { stroopsToXlm } = require("../utils/xlm");

const REVIEW_SCORE = 0.70;
const FLOW_RETENTION_HOURS = 72;
const CYCLE_WINDOW_HOURS = 24;
const MAX_GRAPH_DEPTH = 3;
const WORKER_BATCH_SIZE = 100;
const WORKER_INTERVAL_MS = 1000;
const HISTORICAL_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const WATCHLIST_MAX_ADDRESSES = 50_000;
const WATCHLIST_TTL_MS = FLOW_RETENTION_HOURS * 60 * 60 * 1000;

const EVALUATION_GATE = Object.freeze({
  minimumLabels: 100,
  minimumPositiveLabels: 20,
  minimumNegativeLabels: 20,
  maximumFalsePositiveRate: 0.02,
  minimumRecall: 0.80,
});

const controlledWallets = new Map();
const watchedWallets = new Map();
let workerTimer = null;
let sweepTimer = null;
let workerRunning = false;
let lastBatchAt = null;
let lastBatchSize = 0;
let lastWorkerError = null;

function toNumber(value) {
  const parsed = Number.parseFloat(value?.toString() || "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

function projectSetFor(map, address) {
  if (!address) return new Set();
  const value = map.get(address);
  if (!value) return new Set();
  if (value instanceof Set) return value;
  if (value.expiresAt <= Date.now()) {
    map.delete(address);
    return new Set();
  }
  return value.projectIds;
}

function addWatchedAddress(address, projectIds, now = Date.now()) {
  if (!address || !projectIds?.size) return;
  if (watchedWallets.size >= WATCHLIST_MAX_ADDRESSES && !watchedWallets.has(address)) {
    const oldest = watchedWallets.keys().next().value;
    if (oldest) watchedWallets.delete(oldest);
  }
  const existing = projectSetFor(watchedWallets, address);
  for (const projectId of projectIds) existing.add(projectId);
  watchedWallets.delete(address);
  watchedWallets.set(address, { projectIds: existing, expiresAt: now + WATCHLIST_TTL_MS });
}

function unionProjectIds(...sets) {
  const result = new Set();
  for (const set of sets) for (const item of set) result.add(item);
  return result;
}

function combinedConfidence(signals) {
  const remaining = signals.reduce((product, signal) => product * (1 - signal.confidence), 1);
  return Math.min(1, Math.max(0, 1 - remaining));
}

function sourcePreference(current, incoming) {
  if (incoming === "indexer_horizon" || incoming === "indexer_soroban") return incoming;
  return current || incoming;
}

async function refreshIntegrityWatchlist(db = pool) {
  await db.query(
    `INSERT INTO project_wallet_relationships (
       id, project_id, wallet_address, relationship_type, source,
       confidence, active, recorded_by, evidence
     )
     SELECT md5('project-recipient-wallet:' || p.id::text || ':' || p.wallet_address)::uuid,
            p.id, p.wallet_address, 'recipient', 'project_record',
            1, TRUE, 'integrity_watchlist', jsonb_build_object('field', 'projects.wallet_address')
       FROM projects p
     ON CONFLICT (project_id, wallet_address, relationship_type) DO UPDATE SET
       active = TRUE,
       confidence = 1,
       updated_at = NOW()`,
  );
  const [relationships, recent] = await Promise.all([
    db.query(
      `SELECT project_id, wallet_address
         FROM project_wallet_relationships
        WHERE active = TRUE
          AND (valid_until IS NULL OR valid_until > NOW())`,
    ),
    db.query(
      `SELECT project_id, donor_address AS wallet_address
         FROM donation_integrity_assessments
        WHERE observed_at >= NOW() - INTERVAL '72 hours'
       UNION
       SELECT project_id, source_address AS wallet_address
         FROM donation_integrity_flow_edges
        WHERE expires_at > NOW()
       UNION
       SELECT project_id, destination_address AS wallet_address
         FROM donation_integrity_flow_edges
        WHERE expires_at > NOW()`,
    ),
  ]);

  controlledWallets.clear();
  watchedWallets.clear();
  for (const row of relationships.rows) {
    const projects = controlledWallets.get(row.wallet_address) || new Set();
    projects.add(row.project_id);
    controlledWallets.set(row.wallet_address, projects);
    addWatchedAddress(row.wallet_address, projects);
  }
  for (const row of recent.rows) {
    addWatchedAddress(row.wallet_address, new Set([row.project_id]));
  }
  return { controlled: controlledWallets.size, watched: watchedWallets.size };
}

async function queueDonationAssessment(db, observation) {
  const source = observation.observedSource || "api";
  const result = await db.query(
    `INSERT INTO donation_integrity_queue (
       transaction_hash, project_id, donor_address, destination_address,
       amount_xlm, observed_source, ledger, observed_at
     )
     VALUES (
       $1, $2, $3,
       COALESCE($4, (SELECT wallet_address FROM projects WHERE id = $2)),
       $5::numeric, $6, $7, COALESCE($8::timestamptz, NOW())
     )
     ON CONFLICT (transaction_hash) DO UPDATE SET
       destination_address = COALESCE(EXCLUDED.destination_address, donation_integrity_queue.destination_address),
       observed_source = CASE
         WHEN EXCLUDED.observed_source IN ('indexer_horizon', 'indexer_soroban')
           THEN EXCLUDED.observed_source
         ELSE donation_integrity_queue.observed_source
       END,
       ledger = COALESCE(EXCLUDED.ledger, donation_integrity_queue.ledger),
       updated_at = NOW()
     RETURNING *`,
    [
      observation.transactionHash,
      observation.projectId,
      observation.donorAddress,
      observation.destinationAddress || null,
      observation.amountXlm,
      source,
      observation.ledger || null,
      observation.observedAt || null,
    ],
  );
  return result.rows[0];
}

async function insertEvent(db, {
  assessmentId,
  actor = "detector",
  actorType = "system",
  action,
  fromStatus = null,
  toStatus = null,
  reason = null,
  metadata = {},
}) {
  await db.query(
    `INSERT INTO donation_integrity_events (
       id, assessment_id, actor, actor_type, action,
       from_status, to_status, reason, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [uuid(), assessmentId, actor, actorType, action, fromStatus, toStatus, reason, JSON.stringify(metadata)],
  );
}

async function selfDonationSignal(db, observation) {
  const result = await db.query(
    `SELECT relationship_type, source, confidence
       FROM project_wallet_relationships
      WHERE project_id = $1
        AND wallet_address = $2
        AND active = TRUE
        AND valid_from <= $3::timestamptz
        AND (valid_until IS NULL OR valid_until > $3::timestamptz)
      ORDER BY confidence DESC
      LIMIT 1`,
    [observation.projectId, observation.donorAddress, observation.observedAt],
  );
  if (!result.rows[0]) return null;
  return {
    type: "self_donation",
    confidence: Math.min(1, Math.max(0, toNumber(result.rows[0].confidence))),
    fingerprint: `${observation.projectId}:${observation.donorAddress}`,
    evidence: {
      relationshipType: result.rows[0].relationship_type,
      relationshipSource: result.rows[0].source,
    },
  };
}

async function rapidRepeatSignal(db, observation) {
  const result = await db.query(
    `SELECT COUNT(*)::int AS pair_count,
            COUNT(*) FILTER (WHERE amount_xlm = $4::numeric)::int AS same_amount_count,
            MIN(observed_at) AS window_start,
            MAX(observed_at) AS window_end
       FROM donation_integrity_assessments
      WHERE project_id = $1
        AND donor_address = $2
        AND transaction_hash <> $3
        AND observed_at BETWEEN $5::timestamptz - INTERVAL '10 minutes'
                            AND $5::timestamptz + INTERVAL '10 minutes'`,
    [
      observation.projectId,
      observation.donorAddress,
      observation.transactionHash,
      observation.amountXlm,
      observation.observedAt,
    ],
  );
  const pairCountIncludingCurrent = Number(result.rows[0]?.pair_count || 0) + 1;
  const sameAmountIncludingCurrent = Number(result.rows[0]?.same_amount_count || 0) + 1;
  if (pairCountIncludingCurrent < 3) return null;

  let confidence = 0.62;
  if (pairCountIncludingCurrent >= 5) confidence = 0.80;
  if (pairCountIncludingCurrent >= 10) confidence = 0.93;
  if (sameAmountIncludingCurrent >= 3) confidence = Math.min(0.96, confidence + 0.07);
  return {
    type: "rapid_repeat_pair",
    confidence,
    fingerprint: `${observation.projectId}:${observation.donorAddress}:10m`,
    evidence: {
      pairCount: pairCountIncludingCurrent,
      sameAmountCount: sameAmountIncludingCurrent,
      windowMinutes: 10,
      windowStart: result.rows[0]?.window_start || observation.observedAt,
      windowEnd: result.rows[0]?.window_end || observation.observedAt,
    },
  };
}

async function circularFlowSignal(db, observation) {
  const result = await db.query(
    `WITH RECURSIVE paths(current_address, path, depth, first_seen, last_seen) AS (
       SELECT e.destination_address,
              ARRAY[e.source_address, e.destination_address]::text[],
              1,
              e.observed_at,
              e.observed_at
         FROM donation_integrity_flow_edges e
        WHERE e.project_id = $1
          AND e.source_address IN (
            SELECT wallet_address
              FROM project_wallet_relationships
             WHERE project_id = $1
               AND active = TRUE
               AND valid_from <= $3::timestamptz
               AND (valid_until IS NULL OR valid_until > $3::timestamptz)
          )
          AND e.observed_at BETWEEN $3::timestamptz - INTERVAL '24 hours'
                                AND $3::timestamptz + INTERVAL '24 hours'
       UNION ALL
       SELECT e.destination_address,
              paths.path || e.destination_address,
              paths.depth + 1,
              LEAST(paths.first_seen, e.observed_at),
              GREATEST(paths.last_seen, e.observed_at)
         FROM paths
         JOIN donation_integrity_flow_edges e
           ON e.project_id = $1
          AND e.source_address = paths.current_address
          AND NOT e.destination_address = ANY(paths.path)
          AND e.observed_at BETWEEN $3::timestamptz - INTERVAL '24 hours'
                                AND $3::timestamptz + INTERVAL '24 hours'
        WHERE paths.depth < $4
     )
     SELECT path, depth, first_seen, last_seen
       FROM paths
      WHERE current_address = $2
      ORDER BY depth ASC, last_seen DESC
      LIMIT 1`,
    [observation.projectId, observation.donorAddress, observation.observedAt, MAX_GRAPH_DEPTH],
  );
  if (!result.rows[0]) return null;
  const depth = Number(result.rows[0].depth);
  const confidence = depth === 1 ? 0.92 : depth === 2 ? 0.82 : depth === 3 ? 0.72 : 0.70;
  return {
    type: "circular_flow",
    confidence,
    fingerprint: `${observation.projectId}:${result.rows[0].path.join(">")}`,
    evidence: {
      depth,
      path: result.rows[0].path,
      windowHours: CYCLE_WINDOW_HOURS,
      firstSeen: result.rows[0].first_seen,
      lastSeen: result.rows[0].last_seen,
    },
  };
}

async function upsertSignals(db, assessmentId, signals) {
  await db.query("DELETE FROM donation_integrity_signals WHERE assessment_id = $1", [assessmentId]);
  for (const signal of signals) {
    await db.query(
      `INSERT INTO donation_integrity_signals (
         id, assessment_id, signal_type, confidence, fingerprint, evidence
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [uuid(), assessmentId, signal.type, signal.confidence, signal.fingerprint, JSON.stringify(signal.evidence)],
    );
  }
}

async function assessDonation(db, rawObservation) {
  const observation = {
    ...rawObservation,
    observedAt: rawObservation.observedAt || new Date().toISOString(),
    observedSource: rawObservation.observedSource || "api",
  };
  const existing = await db.query(
    "SELECT * FROM donation_integrity_assessments WHERE transaction_hash = $1 FOR UPDATE",
    [observation.transactionHash],
  );
  let assessment = existing.rows[0];
  let created = false;
  if (!assessment) {
    created = true;
    const inserted = await db.query(
      `INSERT INTO donation_integrity_assessments (
         id, transaction_hash, project_id, donor_address, destination_address,
         amount_xlm, observed_source, ledger, observed_at
       ) VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9::timestamptz)
       RETURNING *`,
      [
        uuid(), observation.transactionHash, observation.projectId,
        observation.donorAddress, observation.destinationAddress || null,
        observation.amountXlm, observation.observedSource, observation.ledger || null,
        observation.observedAt,
      ],
    );
    assessment = inserted.rows[0];
  } else {
    observation.observedSource = sourcePreference(assessment.observed_source, observation.observedSource);
    await db.query(
      `UPDATE donation_integrity_assessments
          SET destination_address = COALESCE($2, destination_address),
              observed_source = $3,
              ledger = COALESCE($4, ledger),
              updated_at = NOW()
        WHERE id = $1`,
      [assessment.id, observation.destinationAddress || null, observation.observedSource, observation.ledger || null],
    );
  }

  const signals = [];
  for (const detector of [selfDonationSignal, rapidRepeatSignal, circularFlowSignal]) {
    const signal = await detector(db, observation);
    if (signal) signals.push(signal);
  }
  const score = combinedConfidence(signals);
  const protectedStatus = ["confirmed", "dismissed", "appealed"].includes(assessment.review_status);
  const nextStatus = protectedStatus
    ? assessment.review_status
    : (score >= REVIEW_SCORE ? "pending_review" : "monitoring");

  await upsertSignals(db, assessment.id, signals);
  const updated = await db.query(
    `UPDATE donation_integrity_assessments
        SET confidence_score = $2,
            review_status = $3,
            last_scored_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [assessment.id, score.toFixed(4), nextStatus],
  );

  if (created) {
    await insertEvent(db, {
      assessmentId: assessment.id,
      action: "assessed",
      toStatus: nextStatus,
      reason: signals.length ? "Behavioural signals evaluated" : "No configured signal detected",
      metadata: { score, signalTypes: signals.map((signal) => signal.type) },
    });
  } else if (nextStatus !== assessment.review_status) {
    await insertEvent(db, {
      assessmentId: assessment.id,
      action: "score_transition",
      fromStatus: assessment.review_status,
      toStatus: nextStatus,
      reason: "Confidence crossed the human-review boundary",
      metadata: { score, signalTypes: signals.map((signal) => signal.type) },
    });
  }

  addWatchedAddress(observation.donorAddress, new Set([observation.projectId]));
  if (observation.destinationAddress) {
    addWatchedAddress(observation.destinationAddress, new Set([observation.projectId]));
  }
  return { assessment: updated.rows[0], signals };
}

async function processIntegrityQueueBatch({ db = pool, limit = WORKER_BATCH_SIZE } = {}) {
  const client = await db.connect();
  let processed = 0;
  try {
    await client.query("BEGIN");
    const queued = await client.query(
      `SELECT *
         FROM donation_integrity_queue
        WHERE next_attempt_at <= NOW()
        ORDER BY observed_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    let index = 0;
    for (const row of queued.rows) {
      const savepoint = `integrity_item_${index}`;
      index += 1;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        await assessDonation(client, {
          transactionHash: row.transaction_hash,
          projectId: row.project_id,
          donorAddress: row.donor_address,
          destinationAddress: row.destination_address,
          amountXlm: row.amount_xlm,
          observedSource: row.observed_source,
          ledger: row.ledger,
          observedAt: row.observed_at,
        });
        await client.query("DELETE FROM donation_integrity_queue WHERE transaction_hash = $1", [row.transaction_hash]);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        processed += 1;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(
          `UPDATE donation_integrity_queue
              SET attempts = attempts + 1,
                  last_error = $2,
                  next_attempt_at = NOW() + LEAST(INTERVAL '1 hour', (attempts + 1) * INTERVAL '1 minute'),
                  updated_at = NOW()
            WHERE transaction_hash = $1`,
          [row.transaction_hash, error.message.slice(0, 1000)],
        );
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      }
    }
    await client.query("COMMIT");
    lastBatchAt = new Date().toISOString();
    lastBatchSize = processed;
    lastWorkerError = null;
    return processed;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    lastWorkerError = error.message;
    throw error;
  } finally {
    client.release();
  }
}

async function sweepHistoricalDonations(db = pool, limit = 500) {
  const result = await db.query(
    `INSERT INTO donation_integrity_queue (
       transaction_hash, project_id, donor_address, destination_address,
       amount_xlm, observed_source, ledger, observed_at
     )
     SELECT e.payload->'data'->>'transactionHash',
            p.id,
            e.payload->'data'->>'donorAddress',
            p.wallet_address,
            (e.payload->'data'->>'amountXlm')::numeric,
            'historical_replay',
            NULL,
            e.occurred_at
       FROM event_stream e
       JOIN projects p ON p.id::text = e.payload->'data'->>'projectId'
      WHERE e.event_type = 'DonationRecorded'
        AND NOT EXISTS (
          SELECT 1 FROM donation_integrity_assessments a
           WHERE a.transaction_hash = e.payload->'data'->>'transactionHash'
        )
        AND NOT EXISTS (
          SELECT 1 FROM donation_integrity_queue q
           WHERE q.transaction_hash = e.payload->'data'->>'transactionHash'
        )
      ORDER BY e.occurred_at ASC
      LIMIT $1
     ON CONFLICT (transaction_hash) DO NOTHING
     RETURNING transaction_hash`,
    [limit],
  );
  return result.rowCount || result.rows.length;
}

async function rescoreCircularCandidates(db, projectId, addresses) {
  if (!addresses.length) return 0;
  const result = await db.query(
    `SELECT *
       FROM donation_integrity_assessments
      WHERE project_id = $1
        AND donor_address = ANY($2::text[])
        AND observed_at >= NOW() - INTERVAL '72 hours'
        AND review_status IN ('monitoring', 'pending_review')
      ORDER BY observed_at DESC
      LIMIT 100`,
    [projectId, addresses],
  );
  for (const row of result.rows) {
    await assessDonation(db, {
      transactionHash: row.transaction_hash,
      projectId: row.project_id,
      donorAddress: row.donor_address,
      destinationAddress: row.destination_address,
      amountXlm: row.amount_xlm,
      observedSource: row.observed_source,
      ledger: row.ledger,
      observedAt: row.observed_at,
    });
  }
  return result.rows.length;
}

async function observeNativePayment(operation, db = pool) {
  const sourceAddress = operation.from;
  const destinationAddress = operation.to;
  if (!sourceAddress || !destinationAddress) return false;
  const projectIds = unionProjectIds(
    projectSetFor(controlledWallets, sourceAddress),
    projectSetFor(controlledWallets, destinationAddress),
    projectSetFor(watchedWallets, sourceAddress),
    projectSetFor(watchedWallets, destinationAddress),
  );
  if (!projectIds.size) return false;

  const operationId = String(
    operation.id || operation.paging_token ||
    `${operation.transaction_hash}:${sourceAddress}:${destinationAddress}`,
  );
  const amountXlm = operation.amount_stroops !== undefined
    ? stroopsToXlm(operation.amount_stroops)
    : operation.amount;
  for (const projectId of projectIds) {
    await db.query(
      `INSERT INTO donation_integrity_flow_edges (
         id, project_id, transaction_hash, operation_id,
         source_address, destination_address, amount_xlm, ledger, observed_at,
         expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7::numeric, $8,
         COALESCE($9::timestamptz, NOW()),
         COALESCE($9::timestamptz, NOW()) + INTERVAL '72 hours'
       )
       ON CONFLICT (project_id, operation_id) DO NOTHING`,
      [
        uuid(), projectId, operation.transaction_hash, operationId,
        sourceAddress, destinationAddress, amountXlm, operation.ledger_attr || null,
        operation.created_at || null,
      ],
    );
    addWatchedAddress(sourceAddress, new Set([projectId]));
    addWatchedAddress(destinationAddress, new Set([projectId]));
    await rescoreCircularCandidates(db, projectId, [sourceAddress, destinationAddress]);
  }
  return true;
}

async function evaluateLabelledSet(db = pool) {
  const result = await db.query(
    `SELECT l.label, a.confidence_score
       FROM donation_integrity_labels l
       JOIN donation_integrity_assessments a ON a.id = l.assessment_id
      WHERE l.label IN ('legitimate', 'confirmed_abuse')`,
  );
  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;
  for (const row of result.rows) {
    const predicted = toNumber(row.confidence_score) >= REVIEW_SCORE;
    const positive = row.label === "confirmed_abuse";
    if (predicted && positive) truePositive += 1;
    else if (predicted) falsePositive += 1;
    else if (positive) falseNegative += 1;
    else trueNegative += 1;
  }
  const positiveLabels = truePositive + falseNegative;
  const negativeLabels = trueNegative + falsePositive;
  const falsePositiveRate = negativeLabels ? falsePositive / negativeLabels : null;
  const recall = positiveLabels ? truePositive / positiveLabels : null;
  const totalLabels = positiveLabels + negativeLabels;
  const enforcementReady = totalLabels >= EVALUATION_GATE.minimumLabels &&
    positiveLabels >= EVALUATION_GATE.minimumPositiveLabels &&
    negativeLabels >= EVALUATION_GATE.minimumNegativeLabels &&
    falsePositiveRate !== null && falsePositiveRate <= EVALUATION_GATE.maximumFalsePositiveRate &&
    recall !== null && recall >= EVALUATION_GATE.minimumRecall;
  return {
    thresholdVersion: "integrity-score-v1",
    totalLabels,
    positiveLabels,
    negativeLabels,
    truePositive,
    falsePositive,
    trueNegative,
    falseNegative,
    falsePositiveRate,
    recall,
    gate: EVALUATION_GATE,
    enforcementReady,
  };
}

function verifyWalletSignature(walletAddress, message, signatureBase64) {
  try {
    return Keypair.fromPublicKey(walletAddress).verify(
      Buffer.from(message, "utf8"),
      Buffer.from(signatureBase64, "base64"),
    );
  } catch {
    return false;
  }
}

function startIntegrityWorker() {
  if (workerRunning) return;
  workerRunning = true;
  const runBatch = () => processIntegrityQueueBatch().catch((error) => {
    lastWorkerError = error.message;
  });
  refreshIntegrityWatchlist().then(runBatch).catch((error) => {
    lastWorkerError = error.message;
  });
  sweepHistoricalDonations().then(runBatch).catch((error) => {
    lastWorkerError = error.message;
  });
  workerTimer = setInterval(runBatch, WORKER_INTERVAL_MS);
  sweepTimer = setInterval(() => {
    sweepHistoricalDonations().catch((error) => { lastWorkerError = error.message; });
    refreshIntegrityWatchlist().catch((error) => { lastWorkerError = error.message; });
    pool.query("DELETE FROM donation_integrity_flow_edges WHERE expires_at <= NOW()")
      .catch((error) => { lastWorkerError = error.message; });
  }, HISTORICAL_SWEEP_INTERVAL_MS);
  workerTimer.unref?.();
  sweepTimer.unref?.();
}

function stopIntegrityWorker() {
  if (workerTimer) clearInterval(workerTimer);
  if (sweepTimer) clearInterval(sweepTimer);
  workerTimer = null;
  sweepTimer = null;
  workerRunning = false;
}

function getIntegrityWorkerStatus() {
  return {
    isRunning: workerRunning,
    lastBatchAt,
    lastBatchSize,
    lastError: lastWorkerError,
    controlledWallets: controlledWallets.size,
    watchedWallets: watchedWallets.size,
    batchSize: WORKER_BATCH_SIZE,
    intervalMs: WORKER_INTERVAL_MS,
  };
}

function observedDonationsCte(surface) {
  let column;
  if (surface === "leaderboard") column = "exclude_from_leaderboard";
  else if (surface === "displayedTotals") column = "exclude_from_displayed_totals";
  else if (surface === "impactFigures") column = "exclude_from_impact_figures";
  else throw new Error(`Unknown integrity surface: ${surface}`);
  return `observed_donations AS (
    SELECT e.payload->'data'->>'transactionHash' AS transaction_hash,
           (e.payload->'data'->>'projectId')::uuid AS project_id,
           e.payload->'data'->>'donorAddress' AS donor_address,
           (e.payload->'data'->>'amountXlm')::numeric AS amount_xlm,
           COALESCE(e.payload->'data'->>'currency', 'XLM') AS currency,
           e.occurred_at AS created_at
      FROM event_stream e
     WHERE e.event_type = 'DonationRecorded'
    UNION ALL
    SELECT d.transaction_hash, d.project_id, d.donor_address,
           d.amount_xlm, d.currency, d.created_at
      FROM donations d
     WHERE d.status = 'committed'
       AND NOT EXISTS (
         SELECT 1 FROM event_stream e
          WHERE e.event_type = 'DonationRecorded'
            AND e.payload->'data'->>'transactionHash' = d.transaction_hash
       )
  ), surface_donations AS (
    SELECT od.*
      FROM observed_donations od
      LEFT JOIN donation_integrity_assessments a
        ON a.transaction_hash = od.transaction_hash
     WHERE NOT COALESCE((
       a.review_status = 'confirmed'
       AND a.${column} = TRUE
       AND EXISTS (
         SELECT 1 FROM donation_integrity_settings settings
          WHERE settings.id = 'global' AND settings.enforcement_enabled = TRUE
       )
     ), FALSE)
  )`;
}

module.exports = {
  REVIEW_SCORE,
  EVALUATION_GATE,
  queueDonationAssessment,
  assessDonation,
  processIntegrityQueueBatch,
  sweepHistoricalDonations,
  refreshIntegrityWatchlist,
  observeNativePayment,
  evaluateLabelledSet,
  verifyWalletSignature,
  insertEvent,
  startIntegrityWorker,
  stopIntegrityWorker,
  getIntegrityWorkerStatus,
  observedDonationsCte,
  _test: {
    combinedConfidence,
    controlledWallets,
    watchedWallets,
    addWatchedAddress,
  },
};
